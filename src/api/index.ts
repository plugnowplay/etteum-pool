import { Hono } from "hono";
import { accountsRouter } from "./accounts";
import { proxySettingsRouter } from "./proxy-settings";
import { statsRouter } from "./stats";
import { keysRouter } from "./keys";
import { vccRouter } from "./vcc";
import { proxyPoolRouter } from "./proxy-pool";
import { microwarpRouter } from "./microwarp";
import { imageStudioRouter } from "./image-studio";
import { filtersRouter } from "./filters";
import { binApi } from "./bin";
import { integrationRouter } from "./integration";
import { oauthRouter } from "./oauth";
import { combosRouter } from "./combos";
import { shareRouter } from "./share";
import { githubCreatorRoutes, ensureGithubCreatorTables } from "./github-creator";
import { grokCreatorRoutes, ensureGrokCreatorTables } from "./grok-creator";

export const apiRouter = new Hono();

apiRouter.route("/accounts", accountsRouter);
apiRouter.route("/settings", proxySettingsRouter);
apiRouter.route("/stats", statsRouter);
apiRouter.route("/keys", keysRouter);
apiRouter.route("/vcc", vccRouter);
apiRouter.route("/proxy-pool", proxyPoolRouter);
apiRouter.route("/microwarp", microwarpRouter);
apiRouter.route("/image-studio", imageStudioRouter);
apiRouter.route("/filters", filtersRouter);
apiRouter.route("/bin", binApi);
apiRouter.route("/integration", integrationRouter);
apiRouter.route("/oauth", oauthRouter);
apiRouter.route("/combos", combosRouter);
apiRouter.route("/share", shareRouter);
apiRouter.route("/github-creator", githubCreatorRoutes);
apiRouter.route("/grok-creator", grokCreatorRoutes);

// Ensure github creator tables exist (idempotent CREATE IF NOT EXISTS)
try {
  ensureGithubCreatorTables();
  ensureGrokCreatorTables();
  console.log("[DB] GitHub + Grok Creator tables ensured");
} catch (e) {
  console.error("[DB] Creator table init skipped:", e instanceof Error ? e.message : e);
}

apiRouter.get("/providers", (c) => {
  return c.json({ data: ["kiro", "kiro-pro", "codebuddy", "codebuddy-china", "canva", "codex", "qoder"] });
});

// Health check
apiRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
