import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageHeader, PageShell, SectionHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { Save, RefreshCw, Zap, Flame, Globe, Wand2 } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  fetchProviderList,
  fetchAutoWarmupStatus,
  type AutoWarmupStatus,
} from "@/lib/api";
import { useApi } from "@/hooks/useApi";

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  "codebuddy-china": "CodeBuddy CN",
  canva: "Canva",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    load_balancing_method: "round_robin",
    auto_warmup_interval_minutes: "15",
    proxy_pool_usage: "all",
    proxy_pool_rotation: "round_robin",
    // Compression defaults — keep in sync with DEFAULT_COMPRESSION_CONFIG.
    compression_rtk_enabled: "true",
    compression_rtk_max_tool_chars: "4000",
    compression_rtk_keep_last_n_turns_full: "2",
    compression_rtk_smart_truncate: "true",
    compression_dcp_enabled: "false",
    compression_caveman_enabled: "false",
    compression_caveman_level: "lite",
    compression_cache_markers_enabled: "true",
    compression_image_dedupe_enabled: "true",
    compression_tsc_enabled: "true",
    compression_tsc_strip_schema_whitespace: "true",
    compression_tsc_trim_descriptions: "true",
    compression_tsc_drop_schema_meta: "true",
  });
  const [warmupStatus, setWarmupStatus] = useState<AutoWarmupStatus | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const toast = useToast();

  const providerListApi = useApi<{ data: string[] }>(fetchProviderList, []);

  const providers = useMemo(
    () => providerListApi.data?.data || [],
    [providerListApi.data]
  );

  async function load() {
    const res = (await fetchSettings()) as { data: Record<string, string> };
    setForm((current) => ({ ...current, ...(res.data || {}) }));
    setDirty(false);
    fetchAutoWarmupStatus().then(setWarmupStatus).catch(() => {});
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function lbMethodFor(provider: string): string {
    return (
      form[`provider_${provider}_lb_method`] ||
      form.load_balancing_method ||
      "round_robin"
    );
  }

  function isOverride(provider: string): boolean {
    return Boolean(form[`provider_${provider}_lb_method`]);
  }

  async function save() {
    setSaving(true);
    try {
      await updateSettings(form);
      setSavedAt(new Date());
      setDirty(false);
      toast.success("Settings saved");
    } finally {
      setSaving(false);
    }
  }

  const globalMethod = form.load_balancing_method || "round_robin";

  return (
    <PageShell>
      <PageHeader
        title="Proxy Settings"
        description="Configure load balancing, auto warmup, proxy pool routing, and the token compression pipeline."
        badge={
          dirty ? (
            <Badge variant="warning" dot>
              Unsaved
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-4 w-4" />
              Reload
            </Button>
            <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
              {!saving && <Save className="h-4 w-4" />}
              Save
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Load Balancing */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-[var(--primary)]" />
              Load Balancing
            </CardTitle>
            <CardDescription>
              Control how requests are distributed across accounts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field
              label="Global method"
              htmlFor="lb-global"
              hint={
                globalMethod === "sequential"
                  ? "Uses accounts in order, moves to next only when current is exhausted."
                  : "Distributes requests evenly across all active accounts."
              }
            >
              <Select
                id="lb-global"
                value={form.load_balancing_method || "round_robin"}
                onChange={(e) => setValue("load_balancing_method", e.target.value)}
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </Select>
            </Field>

            {providers.length > 0 && (
              <div className="space-y-1">
                <SectionHeader
                  title="Per-provider override"
                  description="Leave on Inherit to follow the global method."
                />
                <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                  {providers.map((provider) => {
                    const key = `provider_${provider}_lb_method`;
                    const effective = lbMethodFor(provider);
                    const overriden = isOverride(provider);
                    return (
                      <div
                        key={provider}
                        className="flex items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
                            {labelFor(provider)}
                            {overriden && (
                              <Badge variant="info" className="px-1.5 py-0 text-[10px] uppercase">
                                override
                              </Badge>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                            {effective === "sequential" ? "Sequential" : "Round Robin"}
                            {!overriden && (
                              <span className="ml-1 opacity-70">(inherits global)</span>
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Select
                            value={form[key] || ""}
                            onChange={(e) => setValue(key, e.target.value)}
                            aria-label={`Load balancing method for ${labelFor(provider)}`}
                            className="h-8 w-[140px] text-xs"
                          >
                            <option value="">Inherit</option>
                            <option value="round_robin">Round Robin</option>
                            <option value="sequential">Sequential</option>
                          </Select>
                          {overriden && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setValue(key, "")}
                              title="Clear override"
                            >
                              Reset
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        {/* Auto WarmUp */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-[var(--primary)]" />
              Auto WarmUp
            </CardTitle>
            <CardDescription>
              Automatically warm up enabled providers on a schedule. Checks accounts with
              status active, exhausted, or error (skips pending). Enable per provider on
              the Accounts page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field
              label="Interval (minutes)"
              htmlFor="warmup-interval"
              hint="Global interval for all providers with Auto WarmUp enabled."
            >
              <Input
                id="warmup-interval"
                type="number"
                min={1}
                max={1440}
                value={form.auto_warmup_interval_minutes || ""}
                onChange={(e) => setValue("auto_warmup_interval_minutes", e.target.value)}
                placeholder="15"
                className="tabular"
              />
            </Field>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Status
              </p>
              <p className="mt-1.5 text-sm font-medium text-[var(--foreground)]">
                {warmupStatus && warmupStatus.enabledProviders.length > 0 ? (
                  <>
                    <span className="tabular">{warmupStatus.enabledProviders.length}</span>{" "}
                    provider{warmupStatus.enabledProviders.length === 1 ? "" : "s"} enabled
                  </>
                ) : (
                  "No provider enabled"
                )}
              </p>
              {warmupStatus?.enabledProviders && warmupStatus.enabledProviders.length > 0 && (
                <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]">
                  {warmupStatus.enabledProviders.map(labelFor).join(", ")}
                </p>
              )}
              {warmupStatus?.nextRunAt && (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Next run:{" "}
                  <span className="tabular">
                    {new Date(warmupStatus.nextRunAt).toLocaleTimeString()}
                  </span>
                </p>
              )}
              {savedAt && (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Last saved: <span className="tabular">{savedAt.toLocaleTimeString()}</span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Proxy Pool */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-[var(--primary)]" />
              Proxy Pool
            </CardTitle>
            <CardDescription>
              Configure how the proxy pool is used for outgoing requests.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field
              label="Usage scope"
              htmlFor="proxy-usage"
              hint={
                form.proxy_pool_usage === "model"
                  ? "Proxies are only used for upstream model API calls. Auth/login runs without proxy."
                  : form.proxy_pool_usage === "auth"
                    ? "Proxies are only used for login automation. Model API calls go direct."
                    : "Proxies are used for both model API calls and login automation."
              }
            >
              <Select
                id="proxy-usage"
                value={form.proxy_pool_usage || "all"}
                onChange={(e) => setValue("proxy_pool_usage", e.target.value)}
              >
                <option value="all">All — Model + Auth</option>
                <option value="model">Model Only — API requests only</option>
                <option value="auth">Auth Only — Login automation only</option>
              </Select>
            </Field>

            <Field
              label="Rotation strategy"
              htmlFor="proxy-rotation"
              hint={
                form.proxy_pool_rotation === "sequential"
                  ? "Uses one proxy until it fails, then moves to the next in the list."
                  : "Distributes requests evenly across all active proxies in rotation."
              }
            >
              <Select
                id="proxy-rotation"
                value={form.proxy_pool_rotation || "round_robin"}
                onChange={(e) => setValue("proxy_pool_rotation", e.target.value)}
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </Select>
            </Field>
          </CardContent>
        </Card>
        {/* Compression — token saver pipeline */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Wand2 className="h-4 w-4 text-[var(--primary)]" />
                  Compression
                </CardTitle>
                <CardDescription className="mt-1">
                  Reduce token usage by compressing tool outputs, deduplicating context, and
                  shortening prompts. Pipeline runs in order: DCP → RTK → Caveman → Image
                  Dedupe → Cache Markers.
                </CardDescription>
              </div>
              <a
                href="https://github.com/priyo000/etteum-pool/blob/main/docs/compression.md"
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring mt-1 shrink-0 rounded text-xs text-[var(--primary)] hover:underline"
                title="Open the compression docs"
              >
                docs ↗
              </a>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* RTK */}
            <CompressionRow
              title="RTK"
              subtitle="Tool Result Compression"
              description="Compress large tool outputs — git diff, grep, ls, tree, file reads"
              enabled={form.compression_rtk_enabled === "true"}
              onToggle={(v) => setValue("compression_rtk_enabled", v ? "true" : "false")}
            >
              <div className="mt-3 space-y-3">
                {/* Quick presets — primary control */}
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { name: "Conservative", chars: "8000", turns: "3", smart: "true", hint: "Bigger budget, more context kept. ~3% saving." },
                      { name: "Balanced", chars: "4000", turns: "2", smart: "true", hint: "Recommended default. ~6% saving." },
                      { name: "Aggressive", chars: "2000", turns: "1", smart: "true", hint: "Smaller cap, only last turn protected. ~12% saving — model may miss older details." },
                    ] as const
                  ).map((preset) => {
                    const selected =
                      form.compression_rtk_max_tool_chars === preset.chars &&
                      form.compression_rtk_keep_last_n_turns_full === preset.turns;
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        title={preset.hint}
                        onClick={() => {
                          setValue("compression_rtk_max_tool_chars", preset.chars);
                          setValue("compression_rtk_keep_last_n_turns_full", preset.turns);
                        }}
                        className={`focus-ring rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] min-h-[44px] md:min-h-0 ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                            : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{preset.name}</div>
                        <div className="tabular mt-0.5 text-[10px] opacity-70">
                          {preset.chars} chars · keep {preset.turns}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Advanced disclosure */}
                <Disclosure label="Advanced settings">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <Field
                      label="Max chars per tool result"
                      htmlFor="rtk-max-chars"
                      hint="~4 chars = 1 token. Default: 4000 (≈1000 tokens)."
                    >
                      <Input
                        id="rtk-max-chars"
                        type="number"
                        min={500}
                        max={50000}
                        step={500}
                        value={form.compression_rtk_max_tool_chars || "4000"}
                        onChange={(e) => setValue("compression_rtk_max_tool_chars", e.target.value)}
                        className="tabular"
                      />
                    </Field>
                    <Field
                      label="Keep last N turns full"
                      htmlFor="rtk-keep-turns"
                      hint="Recent turns left untouched. Default: 2."
                    >
                      <Input
                        id="rtk-keep-turns"
                        type="number"
                        min={0}
                        max={20}
                        value={form.compression_rtk_keep_last_n_turns_full || "2"}
                        onChange={(e) =>
                          setValue("compression_rtk_keep_last_n_turns_full", e.target.value)
                        }
                        className="tabular"
                      />
                    </Field>
                    <Field
                      label="Smart truncate"
                      hint="git diff / tree aware. Default: on."
                    >
                      <label className="flex h-9 min-h-[44px] cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 md:min-h-0">
                        <input
                          type="checkbox"
                          checked={form.compression_rtk_smart_truncate === "true"}
                          onChange={(e) =>
                            setValue(
                              "compression_rtk_smart_truncate",
                              e.target.checked ? "true" : "false"
                            )
                          }
                        />
                        <span className="text-xs text-[var(--foreground)]">Pattern-aware</span>
                      </label>
                    </Field>
                  </div>
                </Disclosure>
              </div>
            </CompressionRow>
            {/* DCP */}
            <CompressionRow
              title="DCP"
              subtitle="Context Deduplication"
              description="When the same read-only tool (Read, Glob, Grep, LS, WebFetch) is called twice with identical input, the older result is replaced with a short reference stub. Lossless from the model's perspective."
              enabled={form.compression_dcp_enabled === "true"}
              onToggle={(v) => setValue("compression_dcp_enabled", v ? "true" : "false")}
            />

            {/* Caveman */}
            <CompressionRow
              title="Caveman"
              subtitle="Terse System Prompt"
              description="Strips filler words and compacts the system prompt. ⚠️ Off by default — aggressive levels can change model behaviour. Test with your own prompts before enabling Full or Ultra."
              enabled={form.compression_caveman_enabled === "true"}
              onToggle={(v) => setValue("compression_caveman_enabled", v ? "true" : "false")}
              alwaysShowChildren
            >
              <div className="mt-3 space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  Compression level
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { lvl: "lite", title: "Lite", subtitle: "Drop filler", hint: "~5–15% saving · safest" },
                      { lvl: "full", title: "Full", subtitle: "Bullet form", hint: "~30–50% saving · moderate risk" },
                      { lvl: "ultra", title: "Ultra", subtitle: "Telegraphic", hint: "~50–70% saving · may degrade output" },
                    ] as const
                  ).map(({ lvl, title, subtitle, hint }) => {
                    const selected = form.compression_caveman_level === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setValue("compression_caveman_level", lvl)}
                        title={hint}
                        className={`focus-ring rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] min-h-[44px] md:min-h-0 ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                            : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{title}</div>
                        <div className="mt-0.5 text-[10px] opacity-70">{subtitle}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                  {form.compression_caveman_level === "lite" &&
                    "Lite: removes politeness fillers (\"please\", \"make sure to\") and verbose connectors. Sentence structure preserved. Saves ~5–15%."}
                  {form.compression_caveman_level === "full" &&
                    "Full: lite + collapses narrative connectors (\"furthermore\", \"that being said\"), drops \"the following\" lead-ins, simplifies if/when clauses. Saves ~30–50%. Test before deploying."}
                  {form.compression_caveman_level === "ultra" &&
                    "Ultra: full + drops articles (a/an/the), drops modal helpers (you can/may/might), forces imperative voice. Saves ~50–70% but may degrade model behaviour. Use only after benchmarking."}
                </p>
              </div>
            </CompressionRow>

            {/* Cache Markers */}
            <CompressionRow
              title="Cache Markers"
              subtitle="Anthropic Prompt Caching"
              description="Tags the stable system-prompt prefix with cache_control:ephemeral so upstream providers can cache it. Auto-skips when prefix contains timestamps or UUIDs (would never cache anyway). Pays off as ~75% discount on repeat input tokens."
              enabled={form.compression_cache_markers_enabled === "true"}
              onToggle={(v) => setValue("compression_cache_markers_enabled", v ? "true" : "false")}
            />

            {/* Image Dedupe */}
            <CompressionRow
              title="Image Dedupe"
              subtitle="Duplicate Image Detection"
              description="When the same image is attached more than once in a request, later occurrences are replaced with a reference stub. Lossless — the image is still in earlier context."
              enabled={form.compression_image_dedupe_enabled === "true"}
              onToggle={(v) => setValue("compression_image_dedupe_enabled", v ? "true" : "false")}
            />

            {/* TSC — Tool Schema Compaction */}
            <CompressionRow
              title="TSC"
              subtitle="Tool Schema Compaction"
              description="Lossless compaction of the tools[] array — strips JSON-Schema metadata ($schema, $id, additionalProperties:false) and collapses whitespace runs in tool descriptions. Provider-agnostic; runs first in pipeline. Typical agent traffic: 5-15% saving."
              enabled={form.compression_tsc_enabled === "true"}
              onToggle={(v) => setValue("compression_tsc_enabled", v ? "true" : "false")}
            />
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

/**
 * Native <details> disclosure with chevron. Used to hide power-user controls
 * inside a CompressionRow so the default view stays simple.
 */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-[var(--border)] bg-[var(--surface-inset)]">
      <summary className="flex cursor-pointer list-none select-none items-center justify-between px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--foreground)]">
        <span>{label}</span>
        <span
          className="transition-transform duration-[var(--dur-fast)] group-open:rotate-180"
          aria-hidden
        >
          ▾
        </span>
      </summary>
      <div className="border-t border-[var(--border)] px-3 pb-3 pt-3">{children}</div>
    </details>
  );
}

/** Toggle row: title + description left, switch right, divider between rows. */
function CompressionRow({
  title,
  subtitle,
  description,
  enabled,
  onToggle,
  children,
  alwaysShowChildren = false,
}: {
  title: string;
  subtitle: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: ReactNode;
  /** When true, children render even when toggle is off (visually dimmed). */
  alwaysShowChildren?: boolean;
}) {
  return (
    <div className="border-b border-[var(--border)] pb-4 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--foreground)]">{title}</span>
            <span className="text-xs text-[var(--muted-foreground)]">({subtitle})</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">
            {description}
          </p>
        </div>
        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
          <input
            type="checkbox"
            className="peer sr-only"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Toggle ${title}`}
          />
          <div className="h-5 w-10 rounded-full bg-[var(--border)] transition-colors duration-[var(--dur-fast)] after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-[var(--foreground)] after:transition-transform after:content-[''] peer-checked:bg-[var(--primary)] peer-checked:after:bg-[var(--primary-foreground)] peer-checked:after:translate-x-5" />
        </label>
      </div>
      {children && (alwaysShowChildren || enabled) && (
        <div className={alwaysShowChildren && !enabled ? "pointer-events-none opacity-50" : ""}>
          {children}
        </div>
      )}
    </div>
  );
}
