import { Hono } from "hono";
import { db } from "../db/index";
import { settings, usageSummary, requestLogs, apiKeys } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { getAllModels } from "../proxy/providers/registry";
import { getActiveApiKey } from "./keys";

export const shareRouter = new Hono();

const SETTING_KEY = "share_page_enabled";

async function isShareEnabled(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTING_KEY));
  if (!row || row.value == null) return true;
  return row.value === "true";
}

/**
 * GET /api/share — public, unauthenticated landing data for the /s page.
 * Wajib `keyId` query param. Hanya key yang `isShareable=true` yang bisa di-share.
 * Gak ada fallback master key — master key gak bisa di-share.
 *
 * Query params:
 *   hours  — window (default 24, max 30d)
 *   keyId  — REQUIRED: id managed key yang shareable
 */
shareRouter.get("/", async (c) => {
  if (!(await isShareEnabled())) {
    return c.json({ enabled: false });
  }

  const hours = Math.min(24 * 30, Math.max(1, Number(c.req.query("hours")) || 24));
  const keyId = Number(c.req.query("keyId")) || 0;

  if (!keyId) {
    return c.json({ enabled: false, error: "keyId required" });
  }

  const [managed] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  if (!managed || !managed.enabled || !managed.isShareable) {
    return c.json({ enabled: false, error: "key not found or not shareable" });
  }

  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  // Usage dari request_logs yang match api_key_id
  const [usageRow] = await db
    .select({
      requests: sql<number>`COALESCE(COUNT(*), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      cachedTokens: sql<number>`COALESCE(SUM(cached_tokens), 0)`,
    })
    .from(requestLogs)
    .where(
      sql`${requestLogs.createdAt} >= ${since} AND ${requestLogs.apiKeyId} = ${keyId} AND ${requestLogs.status} = 'success'`
    );

  // Model usage per-key
  const modelUsage = await db
    .select({
      model: requestLogs.model,
      tokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      requests: sql<number>`COALESCE(COUNT(*), 0)`,
    })
    .from(requestLogs)
    .where(
      sql`${requestLogs.createdAt} >= ${since} AND ${requestLogs.apiKeyId} = ${keyId} AND ${requestLogs.status} = 'success'`
    )
    .groupBy(requestLogs.model)
    .having(sql`COALESCE(SUM(total_tokens), 0) > 0`)
    .orderBy(sql`COALESCE(SUM(total_tokens), 0) DESC`);

  // Filter models by key's whitelist
  const whitelist = (managed.modelWhitelist || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const allModels = getAllModels();
  const availableModels = whitelist.length > 0
    ? allModels.filter((m) => whitelist.some((w) => m.id.toLowerCase().includes(w) || m.id.toLowerCase().endsWith(w)))
    : allModels;

  return c.json({
    enabled: true,
    hours,
    keyId: managed.id,
    apiKey: managed.key,
    apiKeyName: managed.name || `key-${managed.id}`,
    apiKeyLimits: {
      rpmLimit: managed.rpmLimit,
      tokenLimit: managed.tokenLimit,
      tokensUsed: managed.tokensUsed,
      modelWhitelist: managed.modelWhitelist,
    },
    usage: {
      requests: Number(usageRow?.requests || 0),
      promptTokens: Number(usageRow?.promptTokens || 0),
      completionTokens: Number(usageRow?.completionTokens || 0),
      cachedTokens: Number(usageRow?.cachedTokens || 0),
    },
    modelUsage: modelUsage.map((m) => ({
      provider: "",
      model: m.model,
      tokens: Number(m.tokens),
      requests: Number(m.requests),
    })),
    models: availableModels.map((m) => ({
      id: m.id,
      provider: m.owned_by,
      contextWindow: m.context_window ?? null,
      maxOutput: m.max_output ?? null,
      thinking: Boolean(m.thinking),
      vision: Boolean(m.vision),
    })),
  });
});