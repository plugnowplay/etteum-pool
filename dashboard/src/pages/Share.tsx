import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  API_BASE,
  fetchApiKey,
  fetchDashboardStats,
  fetchManagedKeys,
  fetchModelUsage,
  fetchSettings,
  updateSettings,
  type ManagedKeyDTO,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatNumber, modelColor } from "@/lib/utils";
import {
  Check,
  Coins,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  RefreshCw,
  Share2,
  Zap,
} from "lucide-react";

/** Period presets — hour windows mirror the Usage page so numbers stay consistent. */
const PERIODS = [
  { id: "1d", label: "1d", hours: 48 },
  { id: "7d", label: "7d", hours: 24 * 8 },
  { id: "30d", label: "30d", hours: 24 * 31 },
  { id: "all", label: "All", hours: null },
] as const;

interface ModelRow {
  provider: string;
  model: string;
  tokens: number;
  requests: number;
  color: string;
}

/**
 * Copyable mono field — same visual language as the Integration page fields,
 * with per-field copied feedback instead of a toast.
 */
function CopyField({
  label,
  value,
  display,
  action,
}: {
  label: string;
  value: string;
  /** What to render (masked secrets); copies always use `value`. */
  display?: string;
  /** Extra control (reveal toggle) placed before the copy button. */
  action?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-[var(--muted-foreground)]">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-[var(--foreground)]">
          {display ?? value}
        </pre>
        {action}
        <button
          onClick={copy}
          aria-label={`Copy ${label}`}
          title={copied ? "Copied" : "Copy"}
          className="focus-ring shrink-0 rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[var(--success)]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

export default function Share() {
  const toast = useToast();
  const [period, setPeriod] = useState<string>("1d");
  const [stats, setStats] = useState<any>(null);
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [keyLoading, setKeyLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [publicEnabled, setPublicEnabled] = useState<boolean | null>(null);
  const [managedKeys, setManagedKeys] = useState<ManagedKeyDTO[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [selectedKeyName, setSelectedKeyName] = useState("master");
  const [selectedKeyLimits, setSelectedKeyLimits] = useState<ManagedKeyDTO | null>(null);
  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((res: any) => setPublicEnabled(res?.data?.share_page_enabled !== "false"))
      .catch(() => setPublicEnabled(null));
  }, []);

  async function handleTogglePublic(next: boolean) {
    const prev = publicEnabled;
    setPublicEnabled(next);
    try {
      await updateSettings({ share_page_enabled: next ? "true" : "false" });
      toast.success(next ? "Public share page enabled" : "Public share page disabled");
    } catch (err) {
      setPublicEnabled(prev);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const shareUrl = `${window.location.origin}/s${selectedKeyId ? `?keyId=${selectedKeyId}` : ""}`;

  // Load the pool key once; fall back to the browser-stored key if unreachable.
  // NOTE: never overwrite apiKey after user picked a managed key (race: async
  // fetchApiKey resolving late would clobber the selected key with master).
  useEffect(() => {
    fetchApiKey()
      .then((res: any) => {
        if (res?.key && !selectedKeyId) setApiKey(res.key);
      })
      .catch(() => {})
      .finally(() => setKeyLoading(false));
    // Load managed keys for selector
    fetchManagedKeys()
      .then((res) => {
        setManagedKeys(res.keys);
        // kalau user udah pilih key sebelum list ke-load, sync key value-nya
        setKeyLoading(false);
      })
      .catch(() => setKeyLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const cfg = PERIODS.find((p) => p.id === period) ?? PERIODS[0];
    const range = cfg.id === "all" ? "all" : undefined;
    setLoading(true);
    await Promise.all([
      fetchDashboardStats(cfg.hours, range).then(setStats).catch(() => setStats(null)),
      fetchModelUsage(cfg.hours, range)
        .then((res: any) => setModels(res?.data || []))
        .catch(() => setModels([])),
    ]);
    setLoading(false);
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  // Live refresh on new request logs (debounced, same as the Usage page).
  const scheduleReload = useCallback(() => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => {
      load();
    }, 500);
  }, [load]);

  useWsEvent(["request_log", "request_error"], scheduleReload);

  useEffect(() => {
    return () => {
      if (reloadRef.current) clearTimeout(reloadRef.current);
    };
  }, []);

  const baseUrl = `${API_BASE}/v1`;
  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
    cached: Number(stats?.tokens?.cached || 0),
  };
  const modelRows: ModelRow[] = models
    .map((m: any, idx: number) => ({
      provider: m.provider || "unknown",
      model: m.model || "unknown",
      tokens: Number(m.totalTokens || 0),
      requests: Number(m.totalRequests || 0),
      color: modelColor(`${m.provider || "unknown"}/${m.model || "unknown"}`, idx),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const maxModelTokens = Math.max(1, ...modelRows.map((m) => m.tokens));
  const promptPct = tokenStats.total > 0 ? (tokenStats.prompt / tokenStats.total) * 100 : 0;
  const completionPct =
    tokenStats.total > 0 ? (tokenStats.completion / tokenStats.total) * 100 : 0;

  const exampleModel = modelRows[0]?.model || "your-model";
  const curlSnippet = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${apiKey || "<YOUR_API_KEY>"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

  const connectionInfo = `Etteum Pool — API Access

Base URL: ${baseUrl}
API Key: ${apiKey || "<YOUR_API_KEY>"}

Example:
${curlSnippet}`;

  async function copyToClipboard(text: string, message: string) {
    const ok = await copyText(text);
    if (ok) toast.success(message);
    else toast.error("Clipboard unavailable in this browser");
  }

  return (
    <PageShell>
      <PageHeader
        title="Share"
        description="Connection details for any OpenAI-compatible client, plus live token usage across the pool."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} loading={loading}>
              {!loading && <RefreshCw className="h-4 w-4" />} Refresh
            </Button>
            <Button size="sm" onClick={() => copyToClipboard(connectionInfo, "Connection details copied")}>
              <Share2 className="h-4 w-4" /> Copy details
            </Button>
          </>
        }
      />

      {/* ── Connection ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Connection</CardTitle>
              <CardDescription>
                Point clients at the pool using this base URL and API key.
              </CardDescription>
            </div>
            <Badge variant="secondary">OpenAI-compatible</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <CopyField label="Base URL" value={baseUrl} />
            {keyLoading ? (
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-[38px] w-full rounded-md" />
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-[var(--muted-foreground)]">API Key</label>
                <select
                  value={selectedKeyId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") {
                      setSelectedKeyId(null);
                      setSelectedKeyName("master");
                      setSelectedKeyLimits(null);
                      setApiKey(localStorage.getItem("api_key") || "");
                      fetchApiKey().then((res: any) => res?.key && !selectedKeyId && setApiKey(res.key)).catch(() => {});
                    } else {
                      const id = Number(v);
                      const k = managedKeys.find((m) => m.id === id);
                      if (k) {
                        setSelectedKeyId(id);
                        setSelectedKeyName(k.name || `key-${k.id}`);
                        setSelectedKeyLimits(k);
                        setApiKey(k.key);
                      }
                    }
                  }}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 font-mono text-xs text-[var(--foreground)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <option value="">Master key (no limits)</option>
                  {managedKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name || `key-${k.id}`} — {k.key.slice(0, 12)}…
                      {k.tokenLimit > 0 ? ` · ${Math.round((k.tokensUsed / k.tokenLimit) * 100)}% tokens` : ""}
                      {!k.enabled ? " · disabled" : ""}
                    </option>
                  ))}
                </select>
                {selectedKeyLimits && (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {selectedKeyLimits.modelWhitelist ? (
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono">
                        models: {selectedKeyLimits.modelWhitelist}
                      </span>
                    ) : (
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">all models</span>
                    )}
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">
                      rpm: {selectedKeyLimits.rpmLimit > 0 ? selectedKeyLimits.rpmLimit : "∞"}
                    </span>
                    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">
                      tokens: {selectedKeyLimits.tokenLimit > 0
                        ? `${formatNumber(selectedKeyLimits.tokensUsed)}/${formatNumber(selectedKeyLimits.tokenLimit)}`
                        : "∞"}
                    </span>
                  </div>
                )}
                <CopyField
                  label=""
                  value={apiKey}
                  display={showKey ? apiKey : "•".repeat(Math.min(apiKey.length, 8))}
                  action={
                    <button
                      onClick={() => setShowKey((v) => !v)}
                      aria-label={showKey ? "Hide API key" : "Show API key"}
                      title={showKey ? "Hide" : "Show"}
                      className="focus-ring shrink-0 rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                    >
                      {showKey ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  }
                />
              </div>
            )}
          </div>

          {/* Public share page */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-medium text-[var(--foreground)]">Public share page</h4>
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  A public landing at <span className="font-mono">/s</span> showing the base URL, API key, usage bars, and model list — no login required.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={publicEnabled === true}
                disabled={publicEnabled === null}
                onClick={() => handleTogglePublic(!(publicEnabled === true))}
                title={publicEnabled === true ? "Click to disable public sharing" : "Click to enable public sharing"}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)] ${publicEnabled === true ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-[var(--es-1)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${publicEnabled === true ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>
            {publicEnabled === true && (
              <div className="mt-3">
                <CopyField label="Share URL" value={shareUrl} />
              </div>
            )}
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-[var(--foreground)]">Quick start</h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(curlSnippet, "curl example copied")}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-md bg-[var(--surface-inset)] p-3 text-xs leading-relaxed text-[var(--muted-foreground)]">
              {curlSnippet}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* ── Token stat tiles ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats === null ? (
          Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard
              label="Total tokens"
              value={<span className="tabular">{formatNumber(tokenStats.total)}</span>}
              icon={Zap}
              tone="primary"
            />
            <StatCard
              label="Prompt"
              value={<span className="tabular">{formatNumber(tokenStats.prompt)}</span>}
              icon={Zap}
              tone="success"
            />
            <StatCard
              label="Completion"
              value={<span className="tabular">{formatNumber(tokenStats.completion)}</span>}
              icon={Zap}
              tone="info"
            />
            <StatCard
              label="Cached"
              value={<span className="tabular">{formatNumber(tokenStats.cached)}</span>}
              icon={Zap}
              tone="default"
            />
            <StatCard
              label="Credits"
              value={<span className="tabular">{tokenStats.credits.toFixed(2)}</span>}
              icon={Coins}
              tone="warning"
            />
          </>
        )}
      </div>

      {/* ── Usage bars ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Token Usage</CardTitle>
              <CardDescription>
                Prompt vs completion split and per-model spend for the selected period.
              </CardDescription>
            </div>
            <Tabs value={period} onValueChange={setPeriod}>
              <TabsList>
                {PERIODS.map((p) => (
                  <TabsTrigger key={p.id} value={p.id}>
                    {p.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Prompt / completion split bar */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-[var(--foreground)]">Prompt / Completion</h4>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-[var(--secondary)]">
              <div
                className="h-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                style={{ width: `${promptPct}%`, backgroundColor: "var(--chart-2)" }}
              />
              <div
                className="h-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                style={{ width: `${completionPct}%`, backgroundColor: "var(--chart-3)" }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: "var(--chart-2)" }}
                />
                Prompt
                <span className="tabular font-medium text-[var(--foreground)]">
                  {formatNumber(tokenStats.prompt)}
                </span>
                <span className="tabular">({promptPct.toFixed(0)}%)</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: "var(--chart-3)" }}
                />
                Completion
                <span className="tabular font-medium text-[var(--foreground)]">
                  {formatNumber(tokenStats.completion)}
                </span>
                <span className="tabular">({completionPct.toFixed(0)}%)</span>
              </span>
            </div>
          </div>

          {/* Per-model usage bars */}
          <div className="space-y-2.5">
            <h4 className="text-sm font-medium text-[var(--foreground)]">By Model</h4>
            {loading && modelRows.length === 0 ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-1.5 w-full rounded-full" />
                  </div>
                ))}
              </div>
            ) : modelRows.length === 0 ? (
              <EmptyState
                compact
                icon={Cpu}
                title="No model usage yet"
                description="Per-model token spend appears once requests are logged."
              />
            ) : (
              <div className="space-y-2.5">
                {modelRows.map((row) => {
                  const pct = (row.tokens / maxModelTokens) * 100;
                  const share =
                    tokenStats.total > 0 ? (row.tokens / tokenStats.total) * 100 : 0;
                  return (
                    <div
                      key={`${row.provider}/${row.model}`}
                      className="space-y-1"
                    >
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: row.color }}
                          />
                          <span className="truncate font-medium text-[var(--foreground)]">
                            {row.provider}/{row.model}
                          </span>
                        </div>
                        <span className="tabular shrink-0 text-[var(--muted-foreground)]">
                          {formatNumber(row.tokens)}
                          <span className="opacity-60"> tokens</span>
                          <span className="mx-1 opacity-40">·</span>
                          {row.requests}
                          <span className="opacity-60"> req</span>
                          <span className="mx-1 opacity-40">·</span>
                          {share.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--secondary)]">
                        <div
                          className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                          style={{ width: `${pct}%`, backgroundColor: row.color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
