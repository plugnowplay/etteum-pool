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
 * Gated by the `share_page_enabled` setting; deliberately exposes only the
 * pool connection info (key is the point of sharing), aggregate usage
 * numbers, and the model catalogue. No account-level data.
 *
 * Query params:
 *   hours  — window (default 24, max 30d)
 *   keyId  — optional managed key id; if present, the share page exposes that
 *            key instead of the master key (useful for limited/shared access).
 */
shareRouter.get("/", async (c) => {
  if (!(await isShareEnabled())) {
    return c.json({ enabled: false });
  }

  const hours = Math.min(24 * 30, Math.max(1, Number(c.req.query("hours")) || 24));
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const keyIdParam = Number(c.req.query("keyId")) || 0;
  let exposedKey = await getActiveApiKey();
  let exposedKeyName = "master";
  let exposedKeyLimits: { rpmLimit: number; tokenLimit: number; tokensUsed: number; modelWhitelist: string } | null = null;
  if (keyIdParam > 0) {
    const [managed] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyIdParam));
    if (managed && managed.enabled) {
      exposedKey = managed.key;
      exposedKeyName = managed.name || `key-${managed.id}`;
      exposedKeyLimits = {
        rpmLimit: managed.rpmLimit,
        tokenLimit: managed.tokenLimit,
        tokensUsed: managed.tokensUsed,
        modelWhitelist: managed.modelWhitelist,
      };
    }
  }

  const [totals, byModel, cacheTotal] = await Promise.all([
    db
      .select({
        requests: sql<number>`COALESCE(SUM(total_requests), 0)`,
        promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
        credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
      })
      .from(usageSummary)
      .where(sql`${usageSummary.bucket} >= ${since}`),
    db
      .select({
        provider: usageSummary.provider,
        model: usageSummary.model,
        tokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
        requests: sql<number>`COALESCE(SUM(total_requests), 0)`,
      })
      .from(usageSummary)
      .where(sql`${usageSummary.bucket} >= ${since}`)
      .groupBy(usageSummary.provider, usageSummary.model)
      .having(sql`COALESCE(SUM(total_tokens), 0) > 0`)
      .orderBy(sql`COALESCE(SUM(total_tokens), 0) DESC`),
    // Cache hit tokens dari request_logs (kolom cached_tokens)
    db
      .select({ total: sql<number>`COALESCE(SUM(cached_tokens), 0)` })
      .from(requestLogs)
      .where(sql`${requestLogs.createdAt} >= ${Math.floor(Date.now() / 1000) - hours * 3600}`),
  ]);

  const models = getAllModels().map((m) => ({
    id: m.id,
    provider: m.owned_by,
    contextWindow: m.context_window ?? null,
    maxOutput: m.max_output ?? null,
    thinking: Boolean(m.thinking),
    vision: Boolean(m.vision),
  }));

  return c.json({
    enabled: true,
    hours,
    apiKey: exposedKey,
    apiKeyName: exposedKeyName,
    apiKeyLimits: exposedKeyLimits,
    usage: {
      ...(totals[0] ?? { requests: 0, promptTokens: 0, completionTokens: 0, credits: 0 }),
      cachedTokens: cacheTotal[0]?.total || 0,
    },
    modelUsage: byModel,
    models,
  });
});
