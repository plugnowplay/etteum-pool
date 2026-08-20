import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, client } from "./index";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";

/**
 * Idempotent column-add migrations.
 * The drizzle/ folder is gitignored in this repo — fresh deploys would never
 * see file-based migrations for new columns. Each entry below adds a column
 * if it doesn't already exist; safe to run on every boot.
 *
 * Order: from oldest schema additions to newest. Add to the END of the list
 * when you add a new column to schema.ts.
 */
const IDEMPOTENT_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 2026-06-13 — compression_stats (token-saver telemetry, see src/proxy/compression/)
  { table: "request_logs", column: "compression_stats", ddl: "ALTER TABLE request_logs ADD COLUMN compression_stats TEXT" },
  // 2026-06-14 — Qoder Free counter (mirrors /activity qmodel_latest promo).
  // Decremented per-request when the model maps to qmodel_latest. Synced (and
  // overridden) from Qoder by warmup. See src/auth/warmup-runner.ts.
  { table: "accounts", column: "free_limit",     ddl: "ALTER TABLE accounts ADD COLUMN free_limit REAL DEFAULT 0" },
  { table: "accounts", column: "free_remaining", ddl: "ALTER TABLE accounts ADD COLUMN free_remaining REAL DEFAULT 0" },
  { table: "accounts", column: "free_reset_at",  ddl: "ALTER TABLE accounts ADD COLUMN free_reset_at INTEGER" },
  // 2026-08-15 — upstream prompt-cache hit tokens per request (usage.cache_read_input_tokens
  // / prompt_tokens_details.cached_tokens). 0 = provider tidak melaporkan cache.
  { table: "request_logs", column: "cached_tokens", ddl: "ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER DEFAULT 0" },
  // 2026-08-16 — cached_tokens (upstream prompt-cache hits in request logs).
  { table: "request_logs", column: "cached_tokens", ddl: "ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER DEFAULT 0" },
  // 2026-08-20 — multi API key: attribution per-request.
  { table: "request_logs", column: "api_key_id", ddl: "ALTER TABLE request_logs ADD COLUMN api_key_id INTEGER" },
  { table: "api_keys", column: "is_shareable", ddl: "ALTER TABLE api_keys ADD COLUMN is_shareable INTEGER NOT NULL DEFAULT 0" },
];

// Whole-table additions that predate the drizzle journal or ship without it.
// Idempotent CREATE ... IF NOT EXISTS — safe on every boot.
const IDEMPOTENT_TABLES: Array<{ name: string; ddl: string }> = [
  {
    name: "custom_models",
    ddl: `CREATE TABLE IF NOT EXISTS custom_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      context_window INTEGER DEFAULT 200000,
      max_output INTEGER DEFAULT 8192,
      thinking INTEGER DEFAULT 0,
      vision INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, model)
    )`,
  },
  // 2026-08-20 — multi API keys dengan limits per-key
  {
    name: "api_keys",
    ddl: `CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      model_whitelist TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      last_used_at INTEGER
    )`,
  },
];

function tableHasColumn(table: string, column: string): boolean {
  try {
    const rows = client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function runIdempotentColumns() {
  for (const m of IDEMPOTENT_COLUMNS) {
    if (tableHasColumn(m.table, m.column)) continue;
    try {
      await db.run(sql.raw(m.ddl));
      console.log(`[DB] Added column ${m.table}.${m.column}`);
    } catch (err) {
      // Re-check: another process may have added it concurrently.
      if (!tableHasColumn(m.table, m.column)) {
        console.error(`[DB] Failed to add ${m.table}.${m.column}:`, err);
      }
    }
  }
}

async function runIdempotentTables() {
  for (const t of IDEMPOTENT_TABLES) {
    try {
      db.run(sql.raw(t.ddl));
    } catch (err) {
      console.error(`[DB] Failed to create ${t.name}:`, err);
    }
  }
}

export async function runMigrations() {
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    await migrate(db, { migrationsFolder });
    console.log("[DB] Migrations complete.");
  } else {
    console.log("[DB] No migrations found, skipping. Use 'bun run db:push' to sync schema.");
  }

  // Idempotent CREATE TABLE for tables that ship without drizzle journal
  await runIdempotentTables();
  // Always run idempotent column-add migrations (works on fresh deploys without drizzle/).
  await runIdempotentColumns();
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
