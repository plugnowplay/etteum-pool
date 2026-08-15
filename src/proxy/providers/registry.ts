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
import { GrokCliProvider, MODEL_BY_ID as GROK_CLI_MODEL_BY_ID } from "./grok-cli";

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
  "grok-build": "gcli-build",
  "grok-4.6": "gcli-4.6",
  "grok-4.6-high": "gcli-4.6-high",
  "grok-4.6-medium": "gcli-4.6-medium",
  "grok-4.6-low": "gcli-4.6-low",
  "grok-4.5": "gcli-4.5",
  "grok-4.5-high": "gcli-4.5-high",
  "grok-4.5-medium": "gcli-4.5-medium",
  "grok-4.5-low": "gcli-4.5-low",
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
  "grok-cli": "gcli-",
  codebuddy: "cb-",
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
      // Grok CLI: reverse-map upstream name to internal model ID
      if (resolved === "grok-cli") {
        for (const [id, def] of Object.entries(GROK_CLI_MODEL_BY_ID)) {
          if (def.upstream.toLowerCase() === model.toLowerCase()) {
            return { provider: resolved, model: id };
          }
        }
      }
      const internalPrefix = PROVIDER_MODEL_PREFIX[resolved];
      const bare = internalPrefix && !model.toLowerCase().startsWith(internalPrefix)
        ? internalPrefix + model
        : model;
      return { provider: resolved, model: bare };
    }
    return { provider: null, model: modelStr };
  }

  const aliased = BUILTIN_MODEL_ALIASES[modelStr];
  if (aliased) return parseModelId(aliased);

  return { provider: null, model: modelStr };
}

export function formatModelId(provider: ProviderName, model: string): string {
  // Grok CLI: expose as gcli/<upstream> (e.g. gcli/grok-4.6, gcli/grok-build)
  if (provider === "grok-cli") {
    const def = GROK_CLI_MODEL_BY_ID[model.toLowerCase()];
    if (def) {
      const effort = model.includes("-high") ? "-high"
        : model.includes("-medium") ? "-medium"
        : model.includes("-low") ? "-low"
        : "";
      return `gcli/${def.upstream}${effort}`;
    }
  }
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
  const fallback = PROVIDER_ORDER.find((p) => p.isFallback);
  return (fallback?.name as ProviderName) ?? null;
}

/** All models across every registered provider, exposed as `provider/model`. */
export function getAllModels(): ModelInfo[] {
  return PROVIDER_ORDER.flatMap((provider) =>
    provider.getModels().map((m) => ({
      ...m,
      id: formatModelId(provider.name, m.id),
    })),
  );
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

