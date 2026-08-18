import { Hono } from "hono";
import { db, client } from "../db/index";
import {
  imapServers,
  grokAccounts,
  accounts,
  type GrokAccount,
} from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { getNextProxy, markProxyFail } from "../services/proxy-pool";
import path from "path";
import fs from "fs";

export const grokCreatorRoutes = new Hono();

// ── Table schema (idempotent) ─────────────────────────────────────────────
export function ensureGrokCreatorTables(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS grok_accounts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      email text NOT NULL,
      username text,
      password text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      imap_server_id integer REFERENCES imap_servers(id),
      proxy_id integer REFERENCES proxy_pool(id),
      token text,
      error_message text,
      metadata text,
      created_at integer NOT NULL,
      updated_at integer
    );
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS grok_accounts_status_idx ON grok_accounts(status);`);
  client.exec(`CREATE INDEX IF NOT EXISTS grok_accounts_imap_server_idx ON grok_accounts(imap_server_id);`);
}

// ── Helpers (self-contained, mirrors github-creator) ─────────────────────
function randomPassword(len = 18): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz0123456789@#%_";
  let out = "";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) out += chars[arr[i]! % chars.length];
  return out;
}

const FIRST_NAMES = [
  "james", "mary", "john", "patricia", "robert", "jennifer", "michael", "linda",
  "william", "elizabeth", "david", "barbara", "richard", "susan", "joseph",
  "jessica", "thomas", "sarah", "charles", "karen", "christopher", "lisa",
  "daniel", "nancy", "matthew", "betty", "anthony", "margaret", "mark", "sandra",
  "donald", "ashley", "steven", "kimberly", "paul", "emily", "andrew", "donna",
  "joshua", "michelle", "kevin", "carol", "brian", "amanda", "george", "dorothy",
  "edward", "melissa", "ronald", "deborah",
];
const LAST_NAMES = [
  "smith", "johnson", "williams", "brown", "jones", "garcia", "miller", "davis",
  "rodriguez", "martinez", "hernandez", "lopez", "gonzalez", "wilson", "anderson",
  "thomas", "taylor", "moore", "jackson", "martin", "lee", "perez", "thompson",
  "white", "harris", "sanchez", "clark", "ramirez", "lewis", "robinson", "walker",
  "young", "allen", "king", "wright", "scott", "torres", "nguyen", "hill", "flores",
  "green", "adams", "nelson", "baker", "hall", "rivera", "campbell", "mitchell",
  "carter", "roberts",
];

function generateUniqueEmails(count: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard < count * 50) {
    guard++;
    const fn = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]!;
    const ln = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]!;
    const num = Math.floor(Math.random() * 9000) + 100;
    const local = `${fn}.${ln}${num}`;
    if (seen.has(local)) continue;
    seen.add(local);
    out.push(local);
  }
  return out;
}

async function getImapServerDecrypted(id: number): Promise<{
  host: string; port: number; username: string; password: string;
  catchAllDomain: string | null;
} | null> {
  const [row] = await db.select().from(imapServers).where(eq(imapServers.id, id));
  if (!row) return null;
  let pass = "";
  try { pass = decrypt(row.password); } catch { pass = ""; }
  return {
    host: row.host, port: row.port, username: row.username,
    password: pass, catchAllDomain: row.catchAllDomain,
  };
}

/** Sanitise a grok_accounts row for API output (decrypt password). */
function sanitizeGrokAccount(row: GrokAccount) {
  let password = "";
  try { password = row.password ? decrypt(row.password) : ""; } catch { password = ""; }
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    password,
    status: row.status,
    imapServerId: row.imapServerId,
    proxyId: row.proxyId,
    token: row.token,
    errorMessage: row.errorMessage,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Run one grok registration via scripts/grok/farm_http.py (HTTP) or farm.py (browser). */
async function registerGrokAccount(account: GrokAccount, opts?: { mode?: "http" | "browser" }): Promise<{
  ok: boolean; status: string; token?: string | null; error?: string;
}> {
  const proxy = await getNextProxy("grok");
  const proxyUrl = proxy?.url || null;

  let plainPassword = "";
  try { plainPassword = decrypt(account.password); }
  catch { return { ok: false, status: "error", error: "Failed to decrypt account password" }; }

  if (!account.imapServerId) {
    return { ok: false, status: "error", error: "Account has no IMAP server assigned" };
  }
  const imapCfg = await getImapServerDecrypted(account.imapServerId);
  if (!imapCfg) return { ok: false, status: "error", error: "IMAP server not found" };
  if (!imapCfg.catchAllDomain) {
    return { ok: false, status: "error", error: "IMAP server has no catch_all_domain" };
  }

  if (proxy) {
    await db.update(grokAccounts).set({ proxyId: proxy.id }).where(eq(grokAccounts.id, account.id));
  }

  // Choose script by mode: farm.py = browser (Camoufox, Turnstile in-browser),
  // farm_http.py = HTTP-only (curl_cffi, needs external Turnstile solver).
  const mode = opts?.mode ?? "http";
  const scriptFile = mode === "browser" ? "farm.py" : "farm_http.py";
  const scriptPath = path.join(process.cwd(), "scripts", "grok", scriptFile);
  const args = ["python3.12", scriptPath, "-n", "1", "-c", "1", "-y"];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GROK_EMAIL: account.email,          // fixed email for this account row
    GROK_IMAP_USER: imapCfg.username,
    GROK_IMAP_PASS: imapCfg.password,
    GROK_IMAP_HOST: imapCfg.host,
    GROK_IMAP_PORT: String(imapCfg.port),
    GROK_EMAIL_MODE: "domain",
    GROK_EMAIL_DOMAIN: imapCfg.catchAllDomain,
    GROK_PASSWORD: plainPassword,
    GROK_MAX_ACCOUNTS: "1",
    GROK_CONCURRENT: "1",
    GROK_IMAP_DEBUG: "1",   // temporary: log IMAP reader details for OTP debug
  };
  if (mode === "browser") {
    env.GROK_HEADLESS = "false";
  } else {
    // HTTP mode needs a Turnstile solver. Prefer local captcha-solver sidecar,
    // else CapSolver fallback via CAPSOLVER_API_KEY.
    const solverUrl =
      process.env.GROK_SOLVER_URL ||
      process.env.SOLVER_URL ||
      (process.env.CAPSOLVER_API_KEY ? "capsolver" : "http://127.0.0.1:8877");
    env.SOLVER_URL = solverUrl;
  }
  if (proxyUrl) env.GROK_PROXY = proxyUrl;

  return new Promise<{ ok: boolean; status: string; token?: string | null; error?: string }>((resolve) => {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd: path.join(process.cwd(), "scripts", "grok"),
    });

    let stdout = "";
    let stderr = "";
    const decoder = new TextDecoder();

    const readAll = async (stream: ReadableStream<Uint8Array>, cb: (s: string) => void) => {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        cb(decoder.decode(value, { stream: true }));
      }
    };
    readAll(proc.stdout, (s) => { stdout += s; });
    readAll(proc.stderr, (s) => { stderr += s; });

    proc.exited.then(async (code) => {
      if (code !== 0) {
        const tail = (stdout + "\n" + stderr).split("\n").filter(Boolean).slice(-12).join("\n");
        if (proxy) void markProxyFail(proxy.id);
        return resolve({ ok: false, status: "error", error: `farm.py exited ${code}: ${tail}` });
      }
      // farm.py writes batch to scripts/grok/results/batch_<ts>/accounts.json
      try {
        const matches = stdout.match(/accounts\.json/) || stderr.match(/accounts\.json/);
        if (matches) {
          const resultsDir = path.join(process.cwd(), "scripts", "grok", "results");
          const newest = fs.readdirSync(resultsDir)
            .filter((d) => d.startsWith("batch_"))
            .sort()
            .reverse()[0];
          if (newest) {
            const acctPath = path.join(resultsDir, newest, "accounts.json");
            if (fs.existsSync(acctPath)) {
              const data = JSON.parse(fs.readFileSync(acctPath, "utf8"));
              const first = Array.isArray(data) ? data[0] : (data as any).accounts?.[0] || data;
              // farm.py result: { email, password, tokens: { access_token, refresh_token, ... } }
              const tokens = first?.tokens || {};
              const token = tokens.access_token || first?.token || null;
              const error = first?.error || tokens.error || null;
              const acctEmail = first?.email || account.email;
              if (token) {
                // Inject into accounts table as provider 'grok-cli'
                try {
                  await injectGrokCliAccount(acctEmail, tokens);
                } catch (injErr) {
                  // Non-fatal: account farmed but injection failed
                  console.error("grok-cli inject failed:", injErr instanceof Error ? injErr.message : injErr);
                }
              }
              return resolve({
                ok: true,
                status: token ? "verified" : "registered",
                token,
                error: error || undefined,
              });
            }
          }
        }
        return resolve({ ok: true, status: "registered", error: undefined });
      } catch (e) {
        return resolve({ ok: true, status: "registered", error: undefined });
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────

// Inject a farmed grok account into the accounts table as provider 'grok-cli'
// so the existing grok-cli proxy provider can serve it immediately.
async function injectGrokCliAccount(email: string, tokens: Record<string, any>): Promise<{
  id: number; provider: string; email: string; status: string; updated: boolean;
}> {
  const encryptedPassword = encrypt("grok-cli-oauth"); // dummy marker (OAuth accounts have no password)
  const emailForAccount = tokens.email || email;
  const accountTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    expires_at: tokens.expires_at
      ? tokens.expires_at
      : (tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined),
    email: emailForAccount,
    user_id: tokens.user_id,
    subscription_tier: tokens.subscription_tier,
    auth_mode: tokens.auth_mode || "oidc",
    client_id: tokens.client_id,
    scope: tokens.scope,
  };

  // Existing account? Update it.
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, emailForAccount))
    .then((rows) => rows.find((r) => r.provider === "grok-cli"));

  if (existing) {
    await db.update(accounts).set({
      password: encryptedPassword,
      status: "active",
      tokens: accountTokens as unknown,
      errorMessage: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(accounts.id, existing.id));
    return { id: existing.id, provider: "grok-cli", email: emailForAccount, status: "active", updated: true };
  }

  const [inserted] = await db.insert(accounts).values({
    provider: "grok-cli",
    email: emailForAccount,
    password: encryptedPassword,
    status: "active",
    tokens: accountTokens as unknown,
    metadata: { validated_at: new Date().toISOString() } as unknown,
    quotaLimit: -1,
    quotaRemaining: -1,
    lastLoginAt: new Date(),
  }).returning();
  return { id: inserted!.id, provider: "grok-cli", email: emailForAccount, status: "active", updated: false };
}

// GET /api/grok-creator/accounts — list all grok accounts
grokCreatorRoutes.get("/accounts", async (c) => {
  const rows = await db.select().from(grokAccounts).orderBy(desc(grokAccounts.createdAt));
  return c.json({ accounts: rows.map(sanitizeGrokAccount) });
});

// POST /api/grok-creator/accounts — create rows (not yet registered)
grokCreatorRoutes.post("/accounts", async (c) => {
  const body = await c.req.json<{ imap_server_id: number; count: number; password?: string }>();
  if (!body.imap_server_id || !body.count) {
    return c.json({ error: "imap_server_id and count are required" }, 400);
  }
  if (body.count > 100) return c.json({ error: "count must be 100 or less" }, 400);

  const [imapServer] = await db.select().from(imapServers).where(eq(imapServers.id, body.imap_server_id));
  if (!imapServer) return c.json({ error: "IMAP server not found" }, 404);
  const domain = imapServer.catchAllDomain;
  if (!domain) return c.json({ error: "IMAP server has no catch_all_domain set" }, 400);

  const plainPassword = body.password || randomPassword();
  const encryptedPassword = encrypt(plainPassword);
  const locals = generateUniqueEmails(body.count);

  const created: number[] = [];
  for (const local of locals) {
    const email = `${local}@${domain}`;
    const username = local.replace(".", "");
    const [row] = await db
      .insert(grokAccounts)
      .values({
        email,
        username,
        password: encryptedPassword,
        status: "pending",
        imapServerId: body.imap_server_id,
      })
      .returning();
    if (row) created.push(row.id);
  }

  broadcast({ type: "grok_creator.accounts_created", data: { count: created.length, ids: created } });
  return c.json({ created: created.length, ids: created, password: plainPassword });
});

// POST /api/grok-creator/accounts/:id/register — trigger grok registration
grokCreatorRoutes.post("/accounts/:id/register", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db.select().from(grokAccounts).where(eq(grokAccounts.id, id));
  if (!account) return c.json({ error: "Account not found" }, 404);
  const body = await c.req.json<{ mode?: string }>().catch(() => ({}) as any);
  const mode: "http" | "browser" = body?.mode === "browser" ? "browser" : "http";

  await db.update(grokAccounts).set({ status: "registering", errorMessage: null, updatedAt: new Date() }).where(eq(grokAccounts.id, id));
  broadcast({ type: "grok_creator.account_updated", data: { id, status: "registering", mode } });

  const result = await registerGrokAccount(account, { mode });

  await db.update(grokAccounts).set({
    status: result.status,
    token: result.token ?? null,
    errorMessage: result.error ?? null,
    updatedAt: new Date(),
  }).where(eq(grokAccounts.id, id));

  broadcast({ type: "grok_creator.account_updated", data: { id, status: result.status } });
  return c.json({ id, ...result });
});

// POST /api/grok-creator/accounts/:id/retry — re-run registration
grokCreatorRoutes.post("/accounts/:id/retry", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db.select().from(grokAccounts).where(eq(grokAccounts.id, id));
  if (!account) return c.json({ error: "Account not found" }, 404);
  const body = await c.req.json<{ mode?: string }>().catch(() => ({}) as any);
  const mode: "http" | "browser" = body?.mode === "browser" ? "browser" : "http";

  await db.update(grokAccounts).set({ status: "registering", errorMessage: null, updatedAt: new Date() }).where(eq(grokAccounts.id, id));
  broadcast({ type: "grok_creator.account_updated", data: { id, status: "registering", mode } });

  const result = await registerGrokAccount(account, { mode });

  await db.update(grokAccounts).set({
    status: result.status,
    token: result.token ?? null,
    errorMessage: result.error ?? null,
    updatedAt: new Date(),
  }).where(eq(grokAccounts.id, id));

  broadcast({ type: "grok_creator.account_updated", data: { id, status: result.status } });
  return c.json({ id, ...result });
});

// DELETE /api/grok-creator/accounts/:id
grokCreatorRoutes.delete("/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(grokAccounts).where(eq(grokAccounts.id, id));
  broadcast({ type: "grok_creator.account_updated", data: { id, deleted: true } });
  return c.json({ ok: true });
});

// GET /api/grok-creator/imap — list IMAP servers (shared)
grokCreatorRoutes.get("/imap", async (c) => {
  const rows = await db.select().from(imapServers).orderBy(desc(imapServers.createdAt));
  return c.json({ servers: rows });
});
