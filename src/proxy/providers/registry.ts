import type { BaseProvider, ModelInfo } from "./base";
import { KiroProvider } from "./kiro";
import { CodeBuddyProvider } from "./codebuddy";
import { CodeBuddyChinaProvider } from "./codebuddy-china";
import { CanvaProvider } from "./canva";
import { CodexProvider } from "./codex";
import { QoderProvider } from "./qoder";
import { ByokProvider } from "./byok";
import { GitlabDuoProvider } from "./gitlab-duo";
import { YouMindProvider } from "./youmind";
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
 */
// kiro and kiro-pro are two variants of the SAME provider class — same upstream
// (AWS CodeWhisperer), different model catalog + account pool. They keep
// distinct provider names so DB/bot/dashboard treat them separately.
const kiro = new KiroProvider({ variant: "standard" });
const kiroPro = new KiroProvider({ variant: "pro" });
const codebuddy = new CodeBuddyProvider();
const codebuddyChina = new CodeBuddyChinaProvider();
const canva = new CanvaProvider();
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();
const gitlabDuo = new GitlabDuoProvider();
const youmind = new YouMindProvider();
const grok = new GrokProvider();
const grokCli = new GrokCliProvider();

const PROVIDER_ORDER = [
  gitlabDuo, canva, qoder, codex, kiroPro, youmind, grok, grokCli, byok, codebuddyChina, codebuddy, kiro,
] as const;

export const providers = {
  kiro,
  "kiro-pro": kiroPro,
  codebuddy,
  "codebuddy-china": codebuddyChina,
  canva,
  codex,
  qoder,
  byok,
  "gitlab-duo": gitlabDuo,
  youmind,
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
const PROVIDER_MODEL_PREFIX: Partial<Record<ProviderName, string>> = {
  qoder: "qd-",
  "kiro-pro": "kp-",
  youmind: "ym-",
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
  const custom = customModelCache.find((m) => m.id === model || m.id.endsWith(`/${model}`));
  if (custom) return custom.owned_by as ProviderName;

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

let customModelCache: ModelInfo[] = [];

/** All models across every registered provider, exposed as `provider/model`. */
export function getAllModels(): ModelInfo[] {
  const builtin = PROVIDER_ORDER.flatMap((provider) =>
    provider.getModels().map((m) => ({
      ...m,
      id: formatModelId(provider.name as ProviderName, m.id),
    })),
  );
  return [...builtin, ...customModelCache];
}

export async function refreshCustomModels(): Promise<void> {
  try {
    const { db } = await import("../../db/index");
    const { customModels } = await import("../../db/schema");
    const rows = await db.select().from(customModels);
    const seen = new Set<string>();
    customModelCache = rows
      .filter((r) => {
        const key = `${r.provider}/${r.model}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({
        id: formatModelId(r.provider as ProviderName, r.model),
        object: "model" as const,
        created: Math.floor((r.createdAt?.getTime?.() ?? Date.now()) / 1000),
        owned_by: r.provider,
        context_window: r.contextWindow ?? 200000,
        max_output: r.maxOutput ?? 8192,
        thinking: Boolean(r.thinking),
        vision: Boolean(r.vision),
      }));
  } catch {
    customModelCache = [];
  }
}

export function getCustomModelEntries(): Array<{ provider: string; model: string }> {
  return customModelCache
    .map((m) => {
      const idx = m.id.indexOf("/");
      return idx > 0 ? { provider: m.owned_by, model: m.id.slice(idx + 1) } : null;
    })
    .filter((x): x is { provider: string; model: string } => x !== null);
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Refresh GitLab Duo models from every active gitlab-duo account's metadata. */
export async function refreshGitlabDuoModels(): Promise<void> {
  await gitlabDuo.refreshModelsCache();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}

/** Get GitLab Duo provider instance. */
export function getGitlabDuoProvider(): GitlabDuoProvider {
  return gitlabDuo;
}

