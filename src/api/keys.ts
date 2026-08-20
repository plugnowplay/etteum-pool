import { Hono } from "hono";
import { db } from "../db/index";
import { settings, apiKeys } from "../db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { config } from "../config";

const API_KEY_SETTING = "pool_api_key";
const API_KEY_CACHE_TTL_MS = 5000;

/**
 * Multi-key API key resolution
 * ────────────────────────────
 * Ada 3 jalur validasi:
 *   1. Legacy master key   — dari settings.pool_api_key ATAU env API_KEY.
 *                            Ini "admin" key: tanpa limits, akses penuh.
 *   2. Managed key (baru)  — row di tabel api_keys, dengan limit (rpm, token, model).
 *   3. Everything else      — reject.
 *
 * `resolveApiKey(token)` return metadata untuk key yang valid, atau null.
 * Middleware /v1/* pakai ini untuk enforce limits.
 */

export type ApiKeyMeta =
  | { type: "master"; key: string }
  | {
      type: "managed";
      id: number;
      key: string;
      name: string;
      modelWhitelist: string[]; // normalized lowercase, empty = allow all
      rpmLimit: number;         // 0 = unlimited
      tokenLimit: number;       // 0 = unlimited
      tokensUsed: number;
      enabled: boolean;
    };

// Cache master key lookup (small hot-path)
let activeMasterKeyCache: { key: string; expiresAt: number } | null = null;

function generateApiKey(prefix = "sk-miot"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${prefix}-${token}`;
}

export async function getActiveMasterKey(): Promise<string> {
  const now = Date.now();
  if (activeMasterKeyCache && activeMasterKeyCache.expiresAt > now) {
    return activeMasterKeyCache.key;
  }
  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  const key = row?.value || config.apiKey;
  activeMasterKeyCache = { key, expiresAt: now + API_KEY_CACHE_TTL_MS };
  return key;
}

/** Backward-compatible alias — semua kode existing yang import getActiveApiKey */
export const getActiveApiKey = getActiveMasterKey;

async function saveMasterKey(key: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  } else {
    await db.insert(settings).values({ key: API_KEY_SETTING, value: key });
  }
  activeMasterKeyCache = { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
}

/**
 * Resolve a bearer token to a key record. Returns null if invalid or disabled.
 * Managed keys are looked up by exact match on api_keys.key.
 */
export async function resolveApiKey(token: string): Promise<ApiKeyMeta | null> {
  if (!token) return null;
  // Master key path (env / settings)
  if (token === config.apiKey) return { type: "master", key: token };
  const master = await getActiveMasterKey();
  if (token === master) return { type: "master", key: token };

  // Managed key path — lookup DB
  try {
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.key, token));
    if (!row) return null;
    if (!row.enabled) return null;
    return {
      type: "managed",
      id: row.id,
      key: row.key,
      name: row.name,
      modelWhitelist: (row.modelWhitelist || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
      rpmLimit: row.rpmLimit,
      tokenLimit: row.tokenLimit,
      tokensUsed: row.tokensUsed,
      enabled: row.enabled,
    };
  } catch {
    return null;
  }
}

/** Legacy: only checks whether token is a valid credential (master or managed). */
export async function isValidApiKey(token: string): Promise<boolean> {
  return (await resolveApiKey(token)) !== null;
}

// ────────────────────────────────────────────────────────────
// Rate limit tracking (in-memory sliding window per key)
// ────────────────────────────────────────────────────────────
const rpmBuckets = new Map<number, number[]>(); // keyId -> array of request timestamps (ms)

export function checkRpmLimit(keyId: number, limit: number): { allowed: boolean; retryAfterMs: number } {
  if (limit <= 0) return { allowed: true, retryAfterMs: 0 };
  const now = Date.now();
  const windowStart = now - 60_000;
  let bucket = rpmBuckets.get(keyId);
  if (!bucket) {
    bucket = [];
    rpmBuckets.set(keyId, bucket);
  }
  // Drop stale
  while (bucket.length > 0 && bucket[0] < windowStart) bucket.shift();
  if (bucket.length >= limit) {
    const retryAfterMs = bucket[0] + 60_000 - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 100) };
  }
  bucket.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

/** Increment token usage for a managed key. Called from recordRequest(). */
export async function recordKeyUsage(keyId: number, tokens: number) {
  if (!keyId || tokens <= 0) return;
  try {
    await db
      .update(apiKeys)
      .set({
        tokensUsed: sql`${apiKeys.tokensUsed} + ${tokens}`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.id, keyId));
  } catch (err) {
    console.error("[api-keys] failed to record usage:", err);
  }
}

// ────────────────────────────────────────────────────────────
// Router: manajemen master key + CRUD managed keys
// ────────────────────────────────────────────────────────────
export const keysRouter = new Hono();

// ─── Master key (halaman API Key existing — tetap kompatibel) ───
keysRouter.get("/", async (c) => {
  const key = await getActiveMasterKey();
  return c.json({ key, source: key === config.apiKey ? "env" : "database" });
});

keysRouter.post("/regenerate", async (c) => {
  const key = generateApiKey();
  await saveMasterKey(key);
  return c.json({ key, source: "database" });
});

keysRouter.post("/set", async (c) => {
  const body = await c.req.json<{ key: string }>();
  if (!body.key || body.key.length < 16) {
    return c.json({ error: "API key must be at least 16 characters" }, 400);
  }
  await saveMasterKey(body.key);
  return c.json({ key: body.key, source: "database" });
});

keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const valid = await isValidApiKey(body.key || "");
  return c.json({ valid });
});

// ─── Managed keys (multi-key CRUD) ───
keysRouter.get("/managed", async (c) => {
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  return c.json({
    count: rows.length,
    keys: rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      modelWhitelist: r.modelWhitelist,
      rpmLimit: r.rpmLimit,
      tokenLimit: r.tokenLimit,
      tokensUsed: r.tokensUsed,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastUsedAt: r.lastUsedAt,
    })),
  });
});

keysRouter.post("/managed", async (c) => {
  const body = await c.req.json<{
    name?: string;
    modelWhitelist?: string;
    rpmLimit?: number;
    tokenLimit?: number;
    key?: string;
  }>();
  const key = (body.key && body.key.trim().length >= 16) ? body.key.trim() : generateApiKey();
  const name = (body.name || "").trim();
  const modelWhitelist = (body.modelWhitelist || "").trim();
  const rpmLimit = Math.max(0, Math.floor(body.rpmLimit ?? 0));
  const tokenLimit = Math.max(0, Math.floor(body.tokenLimit ?? 0));

  try {
    const [inserted] = await db.insert(apiKeys)
      .values({ key, name, modelWhitelist, rpmLimit, tokenLimit })
      .returning();
    return c.json({ ok: true, id: inserted.id, key: inserted.key });
  } catch (err: any) {
    if (String(err?.message || err).includes("UNIQUE")) {
      return c.json({ error: "Key already exists" }, 409);
    }
    return c.json({ error: err?.message || "insert failed" }, 500);
  }
});

keysRouter.put("/managed/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    name?: string;
    modelWhitelist?: string;
    rpmLimit?: number;
    tokenLimit?: number;
    enabled?: boolean;
  }>();
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.modelWhitelist !== undefined) updates.modelWhitelist = body.modelWhitelist.trim();
  if (body.rpmLimit !== undefined) updates.rpmLimit = Math.max(0, Math.floor(body.rpmLimit));
  if (body.tokenLimit !== undefined) updates.tokenLimit = Math.max(0, Math.floor(body.tokenLimit));
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  await db.update(apiKeys).set(updates).where(eq(apiKeys.id, id));
  return c.json({ ok: true });
});

keysRouter.delete("/managed/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
  rpmBuckets.delete(id);
  return c.json({ ok: true });
});

keysRouter.post("/managed/:id/reset-usage", async (c) => {
  const id = Number(c.req.param("id"));
  await db.update(apiKeys).set({ tokensUsed: 0, updatedAt: new Date() }).where(eq(apiKeys.id, id));
  return c.json({ ok: true });
});
