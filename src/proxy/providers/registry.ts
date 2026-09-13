import type { BaseProvider, ModelInfo } from "./base";
import { KiroProvider } from "./kiro";
import { CodeBuddyProvider } from "./codebuddy";
import { CodeBuddyChinaProvider } from "./codebuddy-china";
import { CanvaProvider } from "./canva";
import { CodexProvider } from "./codex";
import { QoderProvider } from "./qoder";
import { ByokProvider } from "./byok";
import { GrokProvider } from "./grok";
import { GrokCliProvider } from "./grok-cli";

/**
 * Single source of truth for the provider set.
 *
 * To add / remove / change a provider you touch exactly two things:
 *   1. that provider's own file (its models + ownsModel() pattern), and
 *   2. one line in PROVIDER_ORDER below.
 *
 * Routing (getProviderForModel) and model listing (getAllModels) iterate this
 * list — there is no per-provider logic anywhere else. Order matters only for
 * disambiguating overlapping patterns: more specific providers come first, and
 * the single isFallback provider (kiro standard) is consulted last.
 *
 * kiro-pro merged into kiro: the pro catalog (kp- ids) is served by the single
 * kiro provider + one shared account pool. Removed providers: youmind,
 * gitlab-duo (retired 2026-08-29).
 */
const kiro = new KiroProvider({ variant: "standard" });
const codebuddy = new CodeBuddyProvider();
const codebuddyChina = new CodeBuddyChinaProvider();
const canva = new CanvaProvider();
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();
const grok = new GrokProvider();
const grokCli = new GrokCliProvider();

const PROVIDER_ORDER = [
  canva, qoder, codex, grok, grokCli, byok, codebuddyChina, codebuddy, kiro,
] as const;

export const providers = {
  kiro,
  codebuddy,
  "codebuddy-china": codebuddyChina,
  canva,
  codex,
  qoder,
  byok,
  grok,
  "grok-cli": grokCli,
} as const;

export type ProviderName = keyof typeof providers;

const PROVIDER_ALIAS_MAP: Record<string, ProviderName> = {};
const PROVIDER_SHORT_ALIAS: Partial<Record<ProviderName, string>> = {};
for (const [key, val] of Object.entries(providers)) {
  PROVIDER_ALIAS_MAP[key] = key as ProviderName;
  const alias = (val as any).alias as string | undefined;
  if (alias) {
    PROVIDER_ALIAS_MAP[alias] = key as ProviderName;
    PROVIDER_SHORT_ALIAS[key as ProviderName] = alias;
  }
  for (const a of ((val as any).aliases || []) as string[]) PROVIDER_ALIAS_MAP[a] = key as ProviderName;
}

// "grok/" prefix → grok-cli (override provider "grok" which uses "xai/" prefix)
// Reverted: keep gcli/ prefix as default for grok-cli

const BUILTIN_MODEL_ALIASES: Record<string, string> = {
  "grok-build": "gcli/grok-build",
  "grok-composer-2.5-fast": "gcli/grok-composer-2.5-fast",
  "grok-4.6": "gcli/grok-4.6",
  "grok-4.6-high": "gcli/grok-4.6-high",
  "grok-4.6-xhigh": "gcli/grok-4.6-xhigh",
  "grok-4.6-medium": "gcli/grok-4.6-medium",
  "grok-4.6-low": "gcli/grok-4.6-low",
  "grok-4.5": "gcli/grok-4.5",
  "grok-4.5-high": "gcli/grok-4.5-high",
  "grok-4.5-medium": "gcli/grok-4.5-medium",
  "grok-4.5-low": "gcli/grok-4.5-low",
  "grok-4-fast-reasoning": "gcli/grok-4-fast-reasoning",
};

interface ParsedModelId {
  provider: ProviderName | null;
  model: string;
}

// Internal model-id prefixes that are redundant once the alias/ prefix is
// present (e.g. internal "qd-Auto" ↔ exposed "qd/Auto"). formatModelId()
// strips them on the way out; parseModelId() restores them on the way in.
// kiro: "kp-" kept so legacy kiro-pro ids (kp/opus-4.8) still resolve via the
// merged kiro provider.
const PROVIDER_MODEL_PREFIX: Partial<Record<ProviderName, string>> = {
  qoder: "qd-",
  kiro: "kp-",
  codex: "codex-",
};

export function parseModelId(modelStr: string): ParsedModelId {
  if (!modelStr) return { provider: null, model: modelStr };

  if (modelStr.includes("/")) {
    const idx = modelStr.indexOf("/");
    const prefix = modelStr.slice(0, idx);
    const model = modelStr.slice(idx + 1);
    const resolved = PROVIDER_ALIAS_MAP[prefix];
    if (resolved) {
      const internalPrefix = PROVIDER_MODEL_PREFIX[resolved];
      const bare = internalPrefix && !model.toLowerCase().startsWith(internalPrefix)
        ? internalPrefix + model
        : model;
      return { provider: resolved, model: bare };
    }
    return { provider: null, model: modelStr };
  }

  const aliased = BUILTIN_MODEL_ALIASES[modelStr];
  if (aliased && aliased !== modelStr) return parseModelId(aliased);

  return { provider: null, model: modelStr };
}

export function formatModelId(provider: ProviderName, model: string): string {
  // BYOK ids are already fully-qualified ("<label>/<model>") — don't re-prefix.
  if (provider === "byok") return model;
  const prefix = PROVIDER_SHORT_ALIAS[provider] || provider;
  const internalPrefix = PROVIDER_MODEL_PREFIX[provider];
  const stripped = internalPrefix && model.toLowerCase().startsWith(internalPrefix)
    ? model.slice(internalPrefix.length)
    : model;
  return `${prefix}/${stripped}`;
}

export function stripProviderPrefix(modelStr: string): string {
  return parseModelId(modelStr).model;
}

/** Map a model id to the provider that handles it. */
export function getProviderForModel(model: string): ProviderName | null {
  const { provider: explicit, model: bare } = parseModelId(model);
  if (explicit) return explicit;

  for (const p of PROVIDER_ORDER) {
    if (p.ownsModel(bare)) return p.name as ProviderName;
  }
  const custom = customModelCache.find(
    (e) => e.info.id === model || e.info.id.endsWith(`/${model}`),
  );
  if (custom) {
    // The DB key is either a real provider or a BYOK label; only the former
    // is a routable ProviderName.
    if (custom.provider in providers) return custom.provider as ProviderName;
    if (byok.ownsModel(custom.info.id)) return "byok";
  }

  // Unknown "prefix/model" ids are BYOK-shaped: formatByokModelId emits
  // "<label>/<model>" and BYOK labels are dynamic DB rows, so they can never
  // appear in PROVIDER_ALIAS_MAP. Route them to byok even when its sync
  // prefix cache is cold — the isFallback catch-all (kiro) would otherwise
  // steal e.g. "openrouter/claude-sonnet-4.6" out of a BYOK combo. If no
  // BYOK account owns the prefix, the router fails with a clear error
  // instead of silently serving from kiro.
  if (bare.includes("/")) return "byok";

  const fallback = PROVIDER_ORDER.find((p) => p.isFallback);
  return (fallback?.name as ProviderName) ?? null;
}

// ── Custom (operator-defined) models ─────────────────────────────────────
// Rows in custom_models extend a provider's catalogue at runtime. They are
// listed in getAllModels() and routed via getProviderForModel(); each
// provider's chat path receives the bare model id and forwards it upstream
// as-is (custom qoder models fall back to MODEL_CONFIGS[0] behaviour unless
// the id matches a known def).

/**
 * A custom row keeps its raw DB `provider` key (used for routing) separate
 * from the `info.owned_by` label reported to clients, because the two differ
 * when the key is a BYOK label.
 */
type CustomModelEntry = { provider: string; model: string; info: ModelInfo };

let customModelCache: CustomModelEntry[] = [];

/** Uniform advertised context window (in tokens) for every model in /v1/models. */
export const UNIFIED_CONTEXT_WINDOW = 1_000_000;
/** Uniform advertised max_output (in tokens). Upstream still enforces the real cap. */
export const UNIFIED_MAX_OUTPUT = 128_000;

/** All models across every registered provider, exposed as `provider/model`. */
export function getAllModels(): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];

  for (const provider of PROVIDER_ORDER) {
    for (const m of provider.getModels()) {
      const id = formatModelId(provider.name as ProviderName, m.id);
      if (seen.has(id)) continue;
      seen.add(id);
      // All exposed models advertise a unified 1M context window / 128k output
      // so the dashboard, combos, and downstream clients (Kilo, opencode,
      // share links, etc.) never see mismatched or provider-specific limits.
      // Upstream still enforces the real cap when a request exceeds it.
      out.push({
        ...m,
        id,
        context_window: UNIFIED_CONTEXT_WINDOW,
        max_output: UNIFIED_MAX_OUTPUT,
      });
    }
  }

  // Custom rows only *extend* the catalogue: a builtin/BYOK model with the
  // same id always wins. Without this, a row like (enxx, gpt-6-astra) that a
  // BYOK account already serves was listed twice under two different owners
  // ("byok:enxx" and "enxx").
  for (const entry of customModelCache) {
    if (seen.has(entry.info.id)) continue;
    seen.add(entry.info.id);
    out.push({
      ...entry.info,
      context_window: UNIFIED_CONTEXT_WINDOW,
      max_output: UNIFIED_MAX_OUTPUT,
    });
  }

  return out;
}

export async function refreshCustomModels(): Promise<void> {
  try {
    const { db } = await import("../../db/index");
    const { customModels } = await import("../../db/schema");
    const rows = await db.select().from(customModels);
    const byokPrefixes = new Set(byok.getPrefixes());
    const seen = new Set<string>();
    customModelCache = rows
      .filter((r) => {
        const key = `${r.provider}/${r.model}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        info: {
          id: formatModelId(r.provider as ProviderName, r.model),
          object: "model" as const,
          created: Math.floor((r.createdAt?.getTime?.() ?? Date.now()) / 1000),
          // A row keyed by a BYOK label belongs to that BYOK endpoint, so it
          // must report the same owner the BYOK provider does.
          owned_by: byokPrefixes.has(r.provider) ? `byok:${r.provider}` : r.provider,
          context_window: r.contextWindow ?? 1000000,
          max_output: r.maxOutput ?? 128000,
          thinking: Boolean(r.thinking),
          vision: Boolean(r.vision),
        },
      }));
  } catch {
    customModelCache = [];
  }
}

export function getCustomModelEntries(): Array<{ provider: string; model: string }> {
  return customModelCache.map(({ provider, model }) => ({ provider, model }));
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}
