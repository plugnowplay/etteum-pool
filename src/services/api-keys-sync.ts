/**
 * Sync tokens_used ke api_keys tiap 30 detik dari request_logs.
 *
 * Kenapa gak update inline di recordRequest?
 *   - Main proxy handler (src/proxy/index.ts) langsung insert ke request_logs
 *     tanpa lewat recordRequest(), jadi butuh hook tambahan.
 *   - api_key_id di request_logs harus di-set — untuk itu, kita simpan
 *     mapping in-memory (key → id) dari middleware, lalu backfill lewat SQL
 *     saat log baru masuk.
 *
 * Strategi:
 *   - Middleware /v1/* set c.set("apiKeyMeta", meta) untuk request masuk.
 *   - Handler pakai getRequestApiKeyId(ctx) waktu insert request_logs.
 *   - Cron ini sync total: SUM(total_tokens WHERE api_key_id=X AND id > last_seen)
 *     lalu increment api_keys.tokens_used.
 */
import { db } from "../db/index";
import { apiKeys, requestLogs } from "../db/schema";
import { eq, sql, gt, and, isNotNull } from "drizzle-orm";

let lastSyncedLogId = 0;
let running = false;

async function syncTokensUsed() {
  if (running) return;
  running = true;
  try {
    // Aggregate token per api_key_id untuk log baru (id > lastSyncedLogId)
    const rows = await db
      .select({
        apiKeyId: requestLogs.apiKeyId,
        totalTokens: sql<number>`COALESCE(SUM(${requestLogs.totalTokens}), 0)`,
        maxId: sql<number>`MAX(${requestLogs.id})`,
      })
      .from(requestLogs)
      .where(and(gt(requestLogs.id, lastSyncedLogId), isNotNull(requestLogs.apiKeyId)))
      .groupBy(requestLogs.apiKeyId);

    if (rows.length === 0) {
      // Tetap advance lastSyncedLogId biar gak scan ulang log tanpa api_key_id
      const maxRows = await db
        .select({ maxId: sql<number>`COALESCE(MAX(${requestLogs.id}), 0)` })
        .from(requestLogs);
      lastSyncedLogId = Math.max(lastSyncedLogId, Number(maxRows[0]?.maxId || 0));
      return;
    }

    let newLastId = lastSyncedLogId;
    for (const r of rows) {
      if (!r.apiKeyId || !r.totalTokens) continue;
      await db
        .update(apiKeys)
        .set({
          tokensUsed: sql`${apiKeys.tokensUsed} + ${r.totalTokens}`,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(apiKeys.id, r.apiKeyId));
      newLastId = Math.max(newLastId, Number(r.maxId) || 0);
    }
    lastSyncedLogId = newLastId;
  } catch (err) {
    console.error("[api-keys-sync] failed:", err);
  } finally {
    running = false;
  }
}

export function startApiKeyUsageSync() {
  // Initialize lastSyncedLogId ke MAX(id) sekarang biar gak double-count log lama
  db.select({ maxId: sql<number>`COALESCE(MAX(${requestLogs.id}), 0)` })
    .from(requestLogs)
    .then((rows) => {
      lastSyncedLogId = Number(rows[0]?.maxId || 0);
      console.log(`[api-keys-sync] Initialized (last log id: ${lastSyncedLogId}). Syncing every 30s.`);
    })
    .catch((err) => console.error("[api-keys-sync] init failed:", err));

  setInterval(syncTokensUsed, 30_000);
}
