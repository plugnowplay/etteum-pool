import { db } from "../db/index";
import { proxyPool, settings } from "../db/schema";
import { eq, sql, inArray, and, lt } from "drizzle-orm";

interface CachedProxy {
  id: number;
  url: string;
  type: string;
}

// ── Proxy list cache ────────────────────────────────────────────────
let cachedProxies: CachedProxy[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;

async function refreshCache(): Promise<CachedProxy[]> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS && cachedProxies.length > 0) {
    return cachedProxies;
  }

  // Self-heal proxies stuck in 'rotating' (rotate-warp.sh marks them before
  // docker restart; a SIGKILL/reboot can skip the restore). Rotation takes
  // at most ~2 min — anything older than 5 min is stale, put it back in
  // rotation and let the outcome-window eviction deal with it if it's dead.
  try {
    const staleCutoff = new Date(now - 5 * 60_000);
    await db
      .update(proxyPool)
      .set({ status: "active", errorMessage: "recovered from stale 'rotating' state" })
      .where(and(eq(proxyPool.status, "rotating"), lt(proxyPool.updatedAt, staleCutoff)));
  } catch {
    // best-effort — never block request path on this
  }

  const rows = await db
    .select({ id: proxyPool.id, url: proxyPool.url, type: proxyPool.type })
    .from(proxyPool)
    .where(eq(proxyPool.status, "active"));

  cachedProxies = rows;
  cacheTimestamp = now;
  return cachedProxies;
}

export function invalidateProxyCache() {
  cacheTimestamp = 0;
}

// ── Proxy pool settings cache ───────────────────────────────────────
type ProxyUsage = "all" | "model" | "auth";
type ProxyRotation = "round_robin" | "sequential";

interface ProxyPoolSettings {
  usage: ProxyUsage;
  rotation: ProxyRotation;
}

let settingsCache: ProxyPoolSettings = { usage: "all", rotation: "round_robin" };
let settingsCacheTs = 0;
const SETTINGS_CACHE_TTL_MS = 10_000;

async function getProxyPoolSettings(): Promise<ProxyPoolSettings> {
  const now = Date.now();
  if (now - settingsCacheTs < SETTINGS_CACHE_TTL_MS) return settingsCache;

  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ["proxy_pool_usage", "proxy_pool_rotation"]));

  let usage: ProxyUsage = "all";
  let rotation: ProxyRotation = "round_robin";

  for (const row of rows) {
    if (row.key === "proxy_pool_usage" && (row.value === "all" || row.value === "model" || row.value === "auth")) {
      usage = row.value;
    }
    if (row.key === "proxy_pool_rotation" && (row.value === "round_robin" || row.value === "sequential")) {
      rotation = row.value;
    }
  }

  settingsCache = { usage, rotation };
  settingsCacheTs = now;
  return settingsCache;
}

export function invalidateProxySettingsCache() {
  settingsCacheTs = 0;
}

// ── Rotation state ──────────────────────────────────────────────────
let roundRobinIndex = 0;
let sequentialIndex = 0;

// ── Core: get next proxy ────────────────────────────────────────────
/**
 * Get the next proxy from the pool.
 *
 * @param purpose - What the proxy will be used for: `"model"` (upstream API
 *   calls) or `"auth"` (login automation). If the pool's usage setting
 *   doesn't include this purpose, returns `null`.
 * @param type - Optional protocol filter (`"http"` or `"socks5"`).
 */
export async function getNextProxy(
  purpose: "model" | "auth" = "model",
  type?: "http" | "socks5",
): Promise<{ id: number; url: string } | null> {
  const cfg = await getProxyPoolSettings();

  // Check if proxy pool is enabled for this purpose
  if (cfg.usage !== "all" && cfg.usage !== purpose) return null;

  const proxies = await refreshCache();
  const filtered = type ? proxies.filter((p) => p.type === type) : proxies;
  if (filtered.length === 0) return null;

  let proxy: CachedProxy | undefined;

  if (cfg.rotation === "sequential") {
    // Sequential: stick with current index, only advance on failure
    if (sequentialIndex >= filtered.length) sequentialIndex = 0;
    proxy = filtered[sequentialIndex];
  } else {
    // Round-robin (default)
    const index = roundRobinIndex % filtered.length;
    roundRobinIndex = (roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER;
    proxy = filtered[index];
  }

  if (!proxy) return null;

  // Update lastUsedAt in background
  void db
    .update(proxyPool)
    .set({ lastUsedAt: new Date() })
    .where(eq(proxyPool.id, proxy.id));

  return { id: proxy.id, url: proxy.url };
}

/**
 * Advance the sequential index (call on proxy failure so the next call
 * picks a different proxy).
 */
export function advanceSequentialIndex() {
  sequentialIndex++;
}

// ── Success / Fail tracking ─────────────────────────────────────────

/** Consecutive failures before a proxy is treated as traffic-exhausted and
 *  pulled from rotation. Bun fetch collapses proxy 407 TRAFFIC_EXHAUSTED into
 *  a generic connect error, so we count consecutive failures in memory. */
const PROXY_EXHAUST_FAILS = 3;

/**
 * Rolling outcome window per proxy. Round-robin INTERLEAVES requests across
 * the pool, so a hard-dead proxy only fails once every N requests and never
 * reaches the consecutive threshold on its own — it would stay "active"
 * forever and keep eating traffic. The window tracks the last N outcomes
 * (true = success, false = fail) per proxy; once there are enough samples,
 * a sustained fail ratio evicts the proxy regardless of interleaving.
 */
const OUTCOME_WINDOW_MAX = 20;
const OUTCOME_WINDOW_MIN = 8; // need at least this many samples before judging
const OUTCOME_FAIL_RATIO = 0.6; // >= 60% fails in the window → evict

const consecutiveFails = new Map<number, number>();
const outcomeWindow = new Map<number, boolean[]>();

function recordOutcome(id: number, ok: boolean) {
  const window = outcomeWindow.get(id) ?? [];
  window.push(ok);
  if (window.length > OUTCOME_WINDOW_MAX) window.shift();
  outcomeWindow.set(id, window);
}

export async function markProxySuccess(id: number) {
  consecutiveFails.delete(id);
  recordOutcome(id, true);
  await db
    .update(proxyPool)
    .set({ successCount: sql`${proxyPool.successCount} + 1`, updatedAt: new Date() })
    .where(eq(proxyPool.id, id));
}

export async function markProxyFail(id: number, error?: string) {
  await db
    .update(proxyPool)
    .set({
      failCount: sql`${proxyPool.failCount} + 1`,
      errorMessage: error || null,
      updatedAt: new Date(),
    })
    .where(eq(proxyPool.id, id));

  // In sequential mode, advance to next proxy on failure
  advanceSequentialIndex();

  // Exhaustion detection, two signals:
  // 1. N consecutive failures with no success in between means the proxy is
  //    out of traffic (Bun collapses proxy 407 TRAFFIC_EXHAUSTED into a
  //    generic "Unable to connect" throw).
  // 2. Sustained fail RATIO over the rolling window — round-robin interleaves
  //    requests across the pool, so a hard-dead proxy never strings together
  //    3 consecutive fails (its successes elsewhere reset the counter) yet
  //    keeps failing every time it's picked. The ratio signal catches that.
  const fails = (consecutiveFails.get(id) ?? 0) + 1;
  consecutiveFails.set(id, fails);

  const window = outcomeWindow.get(id) ?? [];
  window.push(false);
  if (window.length > OUTCOME_WINDOW_MAX) window.shift();
  outcomeWindow.set(id, window);
  const windowFails = window.filter((ok) => !ok).length;
  const ratioEvict =
    window.length >= OUTCOME_WINDOW_MIN &&
    windowFails / window.length >= OUTCOME_FAIL_RATIO;

  if (fails < PROXY_EXHAUST_FAILS && !ratioEvict) return;

  consecutiveFails.delete(id);
  outcomeWindow.delete(id);
  const [row] = await db
    .select({ status: proxyPool.status })
    .from(proxyPool)
    .where(eq(proxyPool.id, id));
  if (!row || row.status !== "active") return;

  const reason = ratioEvict && fails < PROXY_EXHAUST_FAILS
    ? `sustained fail ratio ${windowFails}/${window.length} over last ${window.length} attempts`
    : `${fails} consecutive failures`;
  await db
    .update(proxyPool)
    .set({ status: "error", errorMessage: `Proxy unusable (${reason})` })
    .where(eq(proxyPool.id, id));
  cachedProxies = cachedProxies.filter((p) => p.id !== id);
  cacheTimestamp = 0;
  const { broadcast } = await import("../ws/index");
  broadcast({
    type: "proxy_exhausted",
    data: {
      id,
      failCount: fails,
      error: error || "Unable to connect",
      message: `Proxy #${id} ${reason} — removed from rotation`,
      timestamp: new Date().toISOString(),
    },
  });
  console.warn(`[PROXY-EXHAUSTED] Proxy #${id} disabled after ${reason}`);
}

// ── Auto-recovery loop ──────────────────────────────────────────────
// Proxies evicted to status='error' (traffic exhausted / sustained fails)
// are periodically re-checked. Healthy ones return to rotation
// automatically — no more manual "check" clicks after a bad patch.
const PROXY_RECOVERY_INTERVAL_MS = 2 * 60_000; // check every 2 min
const PROXY_RECOVERY_MAX_AGE_MS = 60 * 60_000; // skip proxies evicted <1 min ago

let recoveryRunning = false;

async function runProxyRecovery() {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    const cutoff = new Date(Date.now() - PROXY_RECOVERY_MAX_AGE_MS);
    const candidates = await db
      .select({ id: proxyPool.id, url: proxyPool.url, errorMessage: proxyPool.errorMessage })
      .from(proxyPool)
      .where(and(eq(proxyPool.status, "error"), lt(proxyPool.updatedAt, cutoff)));

    for (const p of candidates) {
      const result = await checkProxyHealth(p.url);
      if (result.ok) {
        await db
          .update(proxyPool)
          .set({
            status: "active",
            errorMessage: null,
            latencyMs: result.latencyMs,
            updatedAt: new Date(),
          })
          .where(eq(proxyPool.id, p.id));
        outcomeWindow.delete(p.id);
        consecutiveFails.delete(p.id);
        invalidateProxyCache();
        console.log(`[PROXY-RECOVERY] Proxy #${p.id} (${p.url}) healthy again (ip=${result.ip ?? "?"}, ${result.latencyMs}ms) — back in rotation`);
        const { broadcast } = await import("../ws/index");
        broadcast({
          type: "proxy_recovered",
          data: {
            id: p.id,
            url: p.url,
            ip: result.ip,
            latencyMs: result.latencyMs,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        console.log(`[PROXY-RECOVERY] Proxy #${p.id} (${p.url}) still down: ${result.error ?? "unknown"}`);
      }
    }
  } catch (err) {
    console.error(`[PROXY-RECOVERY] loop error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    recoveryRunning = false;
  }
}

export function startProxyRecoveryLoop() {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(runProxyRecovery, PROXY_RECOVERY_INTERVAL_MS);
  console.log(`[PROXY-RECOVERY] auto-recovery loop started (every ${PROXY_RECOVERY_INTERVAL_MS / 60_000} min)`);
}

let recoveryTimer: ReturnType<typeof setInterval> | undefined;

// ── Health check ────────────────────────────────────────────────────
export async function checkProxyHealth(proxyUrl: string): Promise<{ ok: boolean; latencyMs: number; error?: string; ip?: string }> {
  const start = Date.now();
  try {
    const curlPath = Bun.which("curl") || "/usr/bin/curl";
    const proc = Bun.spawn(
      [curlPath, "-s", "-o", "/dev/null", "-w", "%{http_code}|%{remote_ip}", "--proxy", proxyUrl, "--max-time", "10", "https://github.com"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const latencyMs = Date.now() - start;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { ok: false, latencyMs, error: stderr.trim() || `curl exit ${exitCode}` };
    }

    const [statusCode, ip] = stdout.trim().split("|");
    if (statusCode === "200") {
      return { ok: true, latencyMs, ip };
    }
    return { ok: false, latencyMs, error: `HTTP ${statusCode}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}
