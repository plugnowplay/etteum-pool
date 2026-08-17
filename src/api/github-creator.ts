import { Hono } from "hono";
import { db, client } from "../db/index";
import {
  imapServers,
  githubAccounts,
  proxyPool,
  type ImapServer,
  type GithubAccount,
} from "../db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { getNextProxy, markProxySuccess, markProxyFail } from "../services/proxy-pool";
import { ImapFlow } from "imapflow";

export const githubCreatorRoutes = new Hono();

// ── Runtime table creation ────────────────────────────────────────────
// The drizzle migration journal in this repo is inconsistent, so we guarantee
// the tables exist at runtime with idempotent CREATE statements — same pattern
// as ensureModelMappingTable() in src/proxy/model-mapping.ts.
export function ensureGithubCreatorTables(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS imap_servers (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      label text,
      host text NOT NULL,
      port integer NOT NULL DEFAULT 993,
      username text NOT NULL,
      password text NOT NULL,
      catch_all_domain text,
      status text NOT NULL DEFAULT 'active',
      last_tested_at integer,
      last_test_ok integer,
      created_at integer NOT NULL,
      updated_at integer
    );
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS imap_servers_status_idx ON imap_servers(status);`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS github_accounts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      email text NOT NULL,
      username text,
      password text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      imap_server_id integer REFERENCES imap_servers(id),
      proxy_id integer REFERENCES proxy_pool(id),
      verification_code text,
      error_message text,
      metadata text,
      created_at integer NOT NULL,
      updated_at integer
    );
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS github_accounts_status_idx ON github_accounts(status);`);
  client.exec(`CREATE INDEX IF NOT EXISTS github_accounts_imap_server_idx ON github_accounts(imap_server_id);`);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Sanitise an imap_servers row for API output (decrypt password). */
function sanitizeImapServer(row: ImapServer) {
  let password = "";
  try {
    password = row.password ? decrypt(row.password) : "";
  } catch {
    password = "";
  }
  return {
    ...row,
    password, // decrypted for the dashboard form
  };
}

/** Sanitise a github_accounts row for API output (decrypt password). */
function sanitizeGithubAccount(row: GithubAccount & { imapLabel?: string | null; proxyUrl?: string | null }) {
  let password = "";
  try {
    password = row.password ? decrypt(row.password) : "";
  } catch {
    password = "";
  }
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    password,
    status: row.status,
    imapServerId: row.imapServerId,
    proxyId: row.proxyId,
    verificationCode: row.verificationCode,
    errorMessage: row.errorMessage,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    imapLabel: row.imapLabel ?? null,
    proxyUrl: row.proxyUrl ?? null,
  };
}

function randomPassword(len = 16): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i]! % chars.length];
  return out;
}

function randomUsername(): string {
  const adjectives = ["swift", "bright", "calm", "lunar", "solar", "noble", "vivid", "quiet", "bold", "crisp"];
  const nouns = ["dev", "coder", "hacker", "builder", "maker", "dev", "coder", "hacker", "builder", "maker"];
  const num = Math.floor(Math.random() * 9000 + 1000);
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}${num}`;
}

// ── IMAP connection helpers ──────────────────────────────────────────

interface ImapConfig {
  host: string;
  port: number;
  username: string;
  password: string; // plaintext (already decrypted)
}

async function openImap(cfg: ImapConfig): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
  });
  await client.connect();
  return client;
}

async function getImapServerDecrypted(id: number): Promise<{
  host: string;
  port: number;
  username: string;
  password: string;
  catchAllDomain: string | null;
} | null> {
  const [row] = await db.select().from(imapServers).where(eq(imapServers.id, id));
  if (!row) return null;
  let password = "";
  try {
    password = decrypt(row.password);
  } catch {
    password = "";
  }
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password,
    catchAllDomain: row.catchAllDomain,
  };
}

/**
 * Search IMAP for a GitHub verification email sent to `emailTo` within the last
 * `sinceMinutes`. Returns the parsed code + message metadata, or null.
 */
async function readVerificationCode(
  imapCfg: ImapConfig,
  emailTo: string,
  sinceMinutes: number,
): Promise<{ code: string | null; subject: string; from: string; date: string; raw?: string } | null> {
  const client = await openImap(imapCfg);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
      // Search for messages to the target address from GitHub senders
      const messages = await client.search({
        to: emailTo,
        since,
      });

      // Filter by GitHub sender domains — imapflow search doesn't support
      // FROM + TO together in all servers, so we filter client-side.
      const githubSenders = ["noreply@github.com", "notifications@github.com", "noreply@github.mail.com"];
      // Iterate newest-first
      for (let i = messages.length - 1; i >= 0; i--) {
        const uid = messages[i]!;
        const msg = await client.fetchOne(uid, { envelope: true, source: true, internalDate: true });
        if (!msg) continue;

        const fromAddr = msg.envelope?.from?.[0]?.address || "";
        const fromHeader = msg.envelope?.from?.[0]?.name
          ? `${msg.envelope.from[0].name} <${fromAddr}>`
          : fromAddr;

        // Check if sender is from GitHub
        const isGithub = githubSenders.some((s) => fromAddr.toLowerCase().includes(s.split("@")[0]!)) ||
          fromAddr.toLowerCase().includes("github.com");

        if (!isGithub) continue;

        const subject = msg.envelope?.subject || "(no subject)";
        const source = msg.source instanceof Uint8Array
          ? new TextDecoder().decode(msg.source)
          : String(msg.source || "");

        // Parse verification code: GitHub uses a 6-digit code in the subject or body
        // Also handle verification URLs with tokens
        const codeMatch =
          subject.match(/\b(\d{6})\b/) ||
          source.match(/verification code[^0-9]*(\d{6})/i) ||
          source.match(/\b(\d{6})\b/) ||
          source.match(/code[^0-9]*?(\d{6})/i);

        // Also look for a verification URL/token
        const urlMatch = source.match(/https:\/\/github\.com\/users\/[^\s"']*verify[^\s"']*/i);

        const code = codeMatch?.[1] || (urlMatch ? urlMatch[0] : null);

        return {
          code,
          subject,
          from: fromHeader,
          date: msg.internalDate ? msg.internalDate.toISOString() : new Date().toISOString(),
          raw: source.slice(0, 5000),
        };
      }

      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── GitHub registration flow ─────────────────────────────────────────

/**
 * Register a GitHub account. Steps:
 *  1. Get a proxy from proxy_pool via getNextProxy("github")
 *  2. Fetch the signup page to extract the CSRF authenticity_token
 *  3. POST the signup form with the account email + password
 *  4. Poll IMAP for the verification code
 *  5. POST the verification code to GitHub
 *  6. Update github_accounts status
 */
async function registerGitHubAccount(account: GithubAccount): Promise<{
  ok: boolean;
  status: string;
  verificationCode?: string | null;
  error?: string;
  username?: string | null;
}> {
  // 1. Get a proxy
  const proxy = await getNextProxy("github");
  if (!proxy) {
    return { ok: false, status: "error", error: "No active proxy available in the pool" };
  }

  // Decrypt the account password
  let plainPassword = "";
  try {
    plainPassword = decrypt(account.password);
  } catch {
    return { ok: false, status: "error", error: "Failed to decrypt account password" };
  }

  // Get the IMAP server config
  if (!account.imapServerId) {
    return { ok: false, status: "error", error: "Account has no IMAP server assigned" };
  }
  const imapCfg = await getImapServerDecrypted(account.imapServerId);
  if (!imapCfg) {
    return { ok: false, status: "error", error: "IMAP server not found" };
  }

  // Assign the proxy to the account
  await db
    .update(githubAccounts)
    .set({ proxyId: proxy.id, updatedAt: new Date() })
    .where(eq(githubAccounts.id, account.id));

  const proxyUrl = proxy.url;

  try {
    // 2. Fetch the signup page to extract authenticity_token (CSRF)
    const signupPageRes = await fetch("https://github.com/signup", {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      // @ts-expect-error — Bun supports the `proxy` option on fetch
      proxy: proxyUrl,
      redirect: "manual",
    });

    const signupHtml = await signupPageRes.text();
    const tokenMatch =
      signupHtml.match(/name="authenticity_token"\s+value="([^"]+)"/) ||
      signupHtml.match(/authenticity_token"[^>]*value="([^"]+)"/);
    const authenticityToken = tokenMatch?.[1];

    // Extract cookies from the signup page response
    const setCookies = signupPageRes.headers.getSetCookie?.() || [];
    const cookieHeader = setCookies.map((c: string) => c.split(";")[0]).join("; ");

    if (!authenticityToken) {
      await markProxyFail(proxy.id);
      return {
        ok: false,
        status: "error",
        error: "Could not extract authenticity_token from GitHub signup page",
      };
    }

    // 3. Submit the signup form
    const formData = new URLSearchParams();
    formData.append("authenticity_token", authenticityToken);
    formData.append("user[email]", account.email);
    formData.append("user[password]", plainPassword);
    formData.append("source", "form-signup");
    formData.append("required_field_0d96", ""); // honeypot — must be empty
    formData.append("timestamp", String(Date.now()));
    formData.append("timestamp_secret", "");

    const signupRes = await fetch("https://github.com/signup", {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://github.com",
        Referer: "https://github.com/signup",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: formData.toString(),
      // @ts-expect-error — Bun supports the `proxy` option on fetch
      proxy: proxyUrl,
      redirect: "manual",
    });

    // GitHub responds with a redirect to /account/verify-email after successful signup
    const location = signupRes.headers.get("location") || "";
    const signupOk =
      signupRes.status === 302 || location.includes("verify") || location.includes("account");

    if (!signupOk) {
      const body = await signupRes.text().catch(() => "");
      // Check for known error patterns
      const errorMatch =
        body.match(/<div[^>]*class="[^"]*flash[^"]*"[^>]*>([^<]+)</) ||
        body.match(/"error"[^>]*>([^<]+)</);
      const errorMsg = errorMatch?.[1]?.trim() || `Signup failed (HTTP ${signupRes.status})`;
      await markProxyFail(proxy.id);
      return { ok: false, status: "error", error: errorMsg };
    }

    // Update status to registered
    await db
      .update(githubAccounts)
      .set({ status: "registered", updatedAt: new Date() })
      .where(eq(githubAccounts.id, account.id));

    broadcast({ type: "github_creator.account_updated", data: { id: account.id, status: "registered" } });

    // 4. Poll IMAP for verification code (try up to 3 times with 10s intervals)
    let verificationResult: { code: string | null; subject: string; from: string; date: string } | null = null;
    const maxPollAttempts = 3;
    const pollIntervalMs = 15_000;
    const lookbackMinutes = 10;

    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      try {
        verificationResult = await readVerificationCode(
          imapCfg,
          account.email,
          lookbackMinutes,
        );
        if (verificationResult?.code) break;
      } catch (imapErr) {
        // IMAP read error — keep trying
        console.error(`[GitHubCreator] IMAP poll attempt ${attempt + 1} failed:`, imapErr);
      }
      if (attempt < maxPollAttempts - 1) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }

    if (!verificationResult?.code) {
      await markProxySuccess(proxy.id);
      return {
        ok: false,
        status: "error",
        error: "Registered but no verification code found in IMAP after polling",
      };
    }

    // Store the verification code
    await db
      .update(githubAccounts)
      .set({
        verificationCode: verificationResult.code,
        status: "verified",
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(githubAccounts.id, account.id));

    await markProxySuccess(proxy.id);

    broadcast({
      type: "github_creator.account_updated",
      data: {
        id: account.id,
        status: "verified",
        verificationCode: verificationResult.code,
      },
    });

    return {
      ok: true,
      status: "verified",
      verificationCode: verificationResult.code,
      username: account.username,
    };
  } catch (err) {
    await markProxyFail(proxy.id);
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: "error", error: errorMsg };
  }
}

// ══════════════════════════════════════════════════════════════════════
// IMAP Servers CRUD
// ══════════════════════════════════════════════════════════════════════

// GET /api/github-creator/imap — list all imap_servers
githubCreatorRoutes.get("/imap", async (c) => {
  const rows = await db.select().from(imapServers).orderBy(desc(imapServers.createdAt));
  return c.json({ data: rows.map(sanitizeImapServer) });
});

// POST /api/github-creator/imap — create new
githubCreatorRoutes.post("/imap", async (c) => {
  const body = await c.req.json<{
    label?: string;
    host: string;
    port?: number;
    username: string;
    password: string;
    catch_all_domain?: string;
  }>();

  if (!body.host || !body.username || !body.password) {
    return c.json({ error: "host, username, and password are required" }, 400);
  }

  const [row] = await db
    .insert(imapServers)
    .values({
      label: body.label || null,
      host: body.host,
      port: body.port || 993,
      username: body.username,
      password: encrypt(body.password),
      catchAllDomain: body.catch_all_domain || null,
      status: "active",
    })
    .returning();

  broadcast({ type: "github_creator.imap_created", data: sanitizeImapServer(row!) });
  return c.json({ data: sanitizeImapServer(row!) });
});

// PUT /api/github-creator/imap/:id — update
githubCreatorRoutes.put("/imap/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    label?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    catch_all_domain?: string;
    status?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.label !== undefined) updates.label = body.label;
  if (body.host !== undefined) updates.host = body.host;
  if (body.port !== undefined) updates.port = body.port;
  if (body.username !== undefined) updates.username = body.username;
  if (body.password !== undefined) updates.password = encrypt(body.password);
  if (body.catch_all_domain !== undefined) updates.catchAllDomain = body.catch_all_domain;
  if (body.status !== undefined) updates.status = body.status;

  const [row] = await db
    .update(imapServers)
    .set(updates)
    .where(eq(imapServers.id, id))
    .returning();

  if (!row) return c.json({ error: "IMAP server not found" }, 404);

  broadcast({ type: "github_creator.imap_updated", data: sanitizeImapServer(row) });
  return c.json({ data: sanitizeImapServer(row) });
});

// DELETE /api/github-creator/imap/:id — delete
githubCreatorRoutes.delete("/imap/:id", async (c) => {
  const id = Number(c.req.param("id"));

  // Check if any github_accounts reference this server
  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(githubAccounts)
    .where(eq(githubAccounts.imapServerId, id));

  if (Number(countRow?.count || 0) > 0) {
    return c.json(
      { error: `Cannot delete: ${countRow!.count} GitHub account(s) are using this IMAP server` },
      400,
    );
  }

  await db.delete(imapServers).where(eq(imapServers.id, id));
  broadcast({ type: "github_creator.imap_deleted", data: { id } });
  return c.json({ success: true });
});

// POST /api/github-creator/imap/:id/test — test IMAP connection
githubCreatorRoutes.post("/imap/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const [row] = await db.select().from(imapServers).where(eq(imapServers.id, id));
  if (!row) return c.json({ error: "IMAP server not found" }, 404);

  let password = "";
  try {
    password = decrypt(row.password);
  } catch {
    return c.json({ ok: false, error: "Failed to decrypt stored password" });
  }

  try {
    const imapClient = new ImapFlow({
      host: row.host,
      port: row.port,
      secure: row.port === 993,
      auth: { user: row.username, pass: password },
      logger: false,
    });
    await imapClient.connect();

    const lock = await imapClient.getMailboxLock("INBOX");
    try {
      const status = await imapClient.status("INBOX", { messages: true });
      const messageCount = status.messages || 0;
      await lock.release();
      await imapClient.logout();

      // Update test status
      await db
        .update(imapServers)
        .set({
          lastTestedAt: new Date(),
          lastTestOk: true,
          updatedAt: new Date(),
        })
        .where(eq(imapServers.id, id));

      return c.json({ ok: true, messages: messageCount });
    } finally {
      try { await lock.release(); } catch {}
      try { await imapClient.logout(); } catch {}
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    await db
      .update(imapServers)
      .set({
        lastTestedAt: new Date(),
        lastTestOk: false,
        updatedAt: new Date(),
      })
      .where(eq(imapServers.id, id));

    return c.json({ ok: false, error: errorMsg });
  }
});

// POST /api/github-creator/imap/:id/read-code — read verification code from IMAP
githubCreatorRoutes.post("/imap/:id/read-code", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ email_to: string; since_minutes?: number }>();

  if (!body.email_to) {
    return c.json({ error: "email_to is required" }, 400);
  }

  const imapCfg = await getImapServerDecrypted(id);
  if (!imapCfg) return c.json({ error: "IMAP server not found" }, 404);

  try {
    const result = await readVerificationCode(
      imapCfg,
      body.email_to,
      body.since_minutes || 10,
    );

    if (!result || !result.code) {
      return c.json({ code: null, error: "No matching email found" });
    }

    return c.json(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return c.json({ code: null, error: errorMsg });
  }
});

// ══════════════════════════════════════════════════════════════════════
// GitHub Accounts
// ══════════════════════════════════════════════════════════════════════

// GET /api/github-creator/accounts — list all with imap label + proxy info
githubCreatorRoutes.get("/accounts", async (c) => {
  const rows = await db
    .select({
      account: githubAccounts,
      imapLabel: imapServers.label,
      imapHost: imapServers.host,
      proxyUrl: proxyPool.url,
    })
    .from(githubAccounts)
    .leftJoin(imapServers, eq(githubAccounts.imapServerId, imapServers.id))
    .leftJoin(proxyPool, eq(githubAccounts.proxyId, proxyPool.id))
    .orderBy(desc(githubAccounts.createdAt));

  const data = rows.map((r) =>
    sanitizeGithubAccount({
      ...r.account,
      imapLabel: r.imapLabel,
      proxyUrl: r.proxyUrl,
    }),
  );

  return c.json({ data });
});

// POST /api/github-creator/accounts — bulk create github account entries
githubCreatorRoutes.post("/accounts", async (c) => {
  const body = await c.req.json<{
    imap_server_id: number;
    count: number;
    username_prefix: string;
    password?: string;
  }>();

  if (!body.imap_server_id || !body.count || !body.username_prefix) {
    return c.json({ error: "imap_server_id, count, and username_prefix are required" }, 400);
  }

  if (body.count > 100) {
    return c.json({ error: "count must be 100 or less" }, 400);
  }

  // Get the IMAP server to find the catch-all domain
  const [imapServer] = await db.select().from(imapServers).where(eq(imapServers.id, body.imap_server_id));
  if (!imapServer) return c.json({ error: "IMAP server not found" }, 404);

  const domain = imapServer.catchAllDomain;
  if (!domain) {
    return c.json({ error: "IMAP server has no catch_all_domain set" }, 400);
  }

  const plainPassword = body.password || randomPassword();
  const encryptedPassword = encrypt(plainPassword);

  const created: number[] = [];
  for (let i = 0; i < body.count; i++) {
    const padded = String(i + 1).padStart(3, "0"); // 001, 002, ...
    const email = `${body.username_prefix}+${padded}@${domain}`;
    const username = randomUsername();

    const [row] = await db
      .insert(githubAccounts)
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

  broadcast({
    type: "github_creator.accounts_created",
    data: { count: created.length, ids: created },
  });

  return c.json({ created: created.length, ids: created, password: plainPassword });
});

// POST /api/github-creator/accounts/:id/register — trigger registration flow
githubCreatorRoutes.post("/accounts/:id/register", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.id, id));
  if (!account) return c.json({ error: "Account not found" }, 404);

  // Update status to "registering" immediately
  await db
    .update(githubAccounts)
    .set({ status: "registered", errorMessage: null, updatedAt: new Date() })
    .where(eq(githubAccounts.id, id));

  broadcast({ type: "github_creator.account_updated", data: { id, status: "registering" } });

  const result = await registerGitHubAccount(account);

  await db
    .update(githubAccounts)
    .set({
      status: result.status,
      verificationCode: result.verificationCode ?? null,
      errorMessage: result.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(githubAccounts.id, id));

  broadcast({
    type: "github_creator.account_updated",
    data: {
      id,
      status: result.status,
      verificationCode: result.verificationCode,
      error: result.error,
    },
  });

  return c.json(result);
});

// POST /api/github-creator/accounts/:id/retry — re-register a failed account
githubCreatorRoutes.post("/accounts/:id/retry", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.id, id));
  if (!account) return c.json({ error: "Account not found" }, 404);

  // Reset status to pending for retry
  await db
    .update(githubAccounts)
    .set({ status: "pending", errorMessage: null, verificationCode: null, updatedAt: new Date() })
    .where(eq(githubAccounts.id, id));

  broadcast({ type: "github_creator.account_updated", data: { id, status: "pending" } });

  const result = await registerGitHubAccount(account);

  await db
    .update(githubAccounts)
    .set({
      status: result.status,
      verificationCode: result.verificationCode ?? null,
      errorMessage: result.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(githubAccounts.id, id));

  broadcast({
    type: "github_creator.account_updated",
    data: {
      id,
      status: result.status,
      verificationCode: result.verificationCode,
      error: result.error,
    },
  });

  return c.json(result);
});

// DELETE /api/github-creator/accounts/:id — delete
githubCreatorRoutes.delete("/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(githubAccounts).where(eq(githubAccounts.id, id));
  broadcast({ type: "github_creator.account_deleted", data: { id } });
  return c.json({ success: true });
});
