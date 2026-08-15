import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock,
  Coins,
  Globe,
  RefreshCw,
  Search,
  ServerCrash,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard, Metric } from "@/components/ui/stat-card";
import { Drawer, DrawerSection, KeyValue } from "@/components/ui/drawer";
import { SkeletonCard } from "@/components/ui/skeleton";
import { fetchRequests, fetchRequestDetail } from "@/lib/api";
import { formatDateTimeID, formatTimeID } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

export interface RequestLog {
  id: number;
  createdAt: string;
  provider: string;
  model: string | null;
  status: "success" | "error";
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  creditsUsed?: number | null;
  accountId: number | null;
  accountEmail?: string | null;
  accountQuotaBefore?: number | null;
  accountQuotaAfter?: number | null;
  errorMessage: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
  compressionStats?: CompressionStats | null;
}

export interface CompressionStats {
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  savedPct: number;
  byTechnique?: {
    tsc?: number;
    rtk?: number;
    dcp?: number;
    caveman?: number;
    imageDedupe?: number;
    cacheMarkers?: number;
  };
  /** Per-shape-filter savings inside RTK (only present when RTK fired). */
  rtkFilters?: Record<string, number>;
  /** Which proxy carried this request upstream (null = direct). */
  proxyUsed?: { id: number; host: string } | null;
  durationMs: number;
}

export function getCreditMeta(req: RequestLog) {
  const body = req.requestBody as
    | { _poolprox?: { creditSource?: string; creditUnit?: string; creditRate?: number } }
    | null
    | undefined;
  return body?._poolprox || {};
}

export function getStatusTone(status: string): "success" | "warning" | "error" {
  if (status === "success") return "success";
  if (status.includes("429")) return "warning";
  return "error";
}

export function labelProvider(provider: string) {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "grok-cli") return "Grok CLI";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Proxy chip — reads the proxy the request actually went out through. */
export function ProxyChip({ stats }: { stats?: CompressionStats | null }) {
  const proxy = stats?.proxyUsed;
  if (proxy === undefined) return <span className="text-[var(--muted-foreground)]">—</span>;
  if (proxy === null) {
    return (
      <Badge variant="muted" className="font-normal">
        direct
      </Badge>
    );
  }
  return (
    <Badge variant="info" dot className="max-w-[180px] font-normal">
      <span className="truncate">{proxy.host}</span>
      <span className="tabular opacity-60">#{proxy.id}</span>
    </Badge>
  );
}

const PROVIDER_OPTIONS = [
  { value: "all", label: "All providers" },
  { value: "grok-cli", label: "Grok CLI" },
  { value: "kiro", label: "Kiro" },
  { value: "codebuddy", label: "CodeBuddy" },
  { value: "codebuddy-china", label: "CodeBuddy CN" },
  { value: "canva", label: "Canva" },
  { value: "qoder", label: "Qoder" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "All status" },
  { value: "success", label: "Success only" },
  { value: "error", label: "Errors only" },
];

export default function Requests() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  /**
   * Open the detail drawer for a row. The list endpoint omits the heavy
   * requestBody / responseBody columns to keep the page snappy, so we lazily
   * fetch the full record here — showing what we already have immediately so
   * the drawer feels instant, then filling in the bodies once they arrive.
   */
  async function openDetail(req: RequestLog) {
    setSelected(req);
    if (req.requestBody !== undefined && req.responseBody !== undefined) return;
    setDetailLoading(true);
    try {
      const res = (await fetchRequestDetail(req.id)) as { data: RequestLog };
      if (res?.data) {
        setSelected((current) =>
          current?.id === req.id ? { ...current, ...res.data } : current
        );
      }
    } catch {
      // best-effort; leave bodies undefined and let the UI render empty blocks
    } finally {
      setDetailLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = (await fetchRequests(1, 100, provider)) as { data: RequestLog[] };
      setLogs(res.data || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [provider]);

  useWsEvent(["request_log"], (msg) => {
    if (msg.type === "request_log") {
      setLogs((current) => [msg.data as RequestLog, ...current].slice(0, 100));
    }
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((req) => {
      if (status !== "all" && req.status !== status) return false;
      if (!q) return true;
      return (
        req.model?.toLowerCase().includes(q) ||
        req.provider.toLowerCase().includes(q) ||
        req.accountEmail?.toLowerCase().includes(q) ||
        req.errorMessage?.toLowerCase().includes(q) ||
        req.compressionStats?.proxyUsed?.host?.toLowerCase().includes(q) ||
        String(req.accountId || "").includes(q)
      );
    });
  }, [logs, search, status]);

  // Headline stats are computed over the *filtered* set so they always agree
  // with the table underneath.
  const stats = useMemo(() => {
    const total = filtered.length;
    const ok = filtered.filter((r) => r.status === "success").length;
    const tokens = filtered.reduce((sum, r) => sum + (r.totalTokens || 0), 0);
    const credits = filtered.reduce((sum, r) => sum + Number(r.creditsUsed || 0), 0);
    const durations = filtered.map((r) => r.durationMs || 0).filter((d) => d > 0);
    const avgMs = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    const saved = filtered.reduce(
      (sum, r) => sum + (r.compressionStats?.saved || 0),
      0
    );
    return {
      total,
      successRate: total ? (ok / total) * 100 : 0,
      tokens,
      credits,
      avgMs,
      saved,
    };
  }, [filtered]);

  const columns: Column<RequestLog>[] = [
    {
      key: "time",
      header: "Time",
      width: "w-[92px]",
      sortValue: (r) => r.createdAt,
      cell: (r) => (
        <span
          className="tabular font-mono text-xs text-[var(--muted-foreground)]"
          title={formatDateTimeID(r.createdAt)}
        >
          {formatTimeID(r.createdAt)}
        </span>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      primary: true,
      sortValue: (r) => r.provider,
      cell: (r) => (
        <span className="text-sm font-medium text-[var(--foreground)]">
          {labelProvider(r.provider)}
        </span>
      ),
    },
    {
      key: "model",
      header: "Model",
      hideBelow: "md",
      sortValue: (r) => r.model,
      cell: (r) => (
        <span className="font-mono text-xs text-[var(--muted-foreground)]">
          {r.model || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      sortValue: (r) => r.status,
      cell: (r) => (
        <Badge variant={getStatusTone(r.status)} dot>
          {r.status}
        </Badge>
      ),
    },
    {
      key: "proxy",
      header: "Proxy",
      hideBelow: "lg",
      sortValue: (r) => r.compressionStats?.proxyUsed?.host ?? "",
      cell: (r) => <ProxyChip stats={r.compressionStats} />,
    },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      hideBelow: "md",
      width: "w-[90px]",
      sortValue: (r) => r.durationMs ?? 0,
      cell: (r) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">
          {formatDuration(r.durationMs)}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      hideBelow: "lg",
      width: "w-[90px]",
      sortValue: (r) => r.totalTokens ?? 0,
      cell: (r) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">
          {r.totalTokens ? formatNum(r.totalTokens) : "—"}
        </span>
      ),
    },
    {
      key: "credits",
      header: "Credits",
      align: "right",
      hideBelow: "xl",
      width: "w-[80px]",
      sortValue: (r) => Number(r.creditsUsed || 0),
      cell: (r) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">
          {Number(r.creditsUsed || 0).toFixed(2)}
        </span>
      ),
    },
    {
      key: "account",
      header: "Account",
      hideBelow: "xl",
      sortValue: (r) => r.accountEmail ?? r.accountId ?? "",
      cell: (r) => (
        <span className="block max-w-[200px] truncate text-xs text-[var(--muted-foreground)]">
          {r.accountEmail || (r.accountId ? `#${r.accountId}` : "—")}
        </span>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Requests"
        description="Live upstream request log — provider, proxy route, latency, and token spend."
        badge={
          <Badge variant="muted" className="tabular">
            {filtered.length}
          </Badge>
        }
        actions={
          <Button variant="outline" size="sm" onClick={load} loading={loading}>
            {!loading && <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {loading && logs.length === 0 ? (
          Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard
              label="Requests"
              value={formatNum(stats.total)}
              icon={Activity}
              tone="primary"
            />
            <StatCard
              label="Success"
              value={`${stats.successRate.toFixed(1)}%`}
              icon={CheckCircle2}
              tone={stats.successRate >= 95 ? "success" : stats.successRate >= 80 ? "warning" : "error"}
            />
            <StatCard
              label="Avg latency"
              value={formatDuration(stats.avgMs)}
              icon={Clock}
              tone="info"
            />
            <StatCard
              label="Tokens"
              value={formatNum(stats.tokens)}
              hint={stats.saved > 0 ? `−${formatNum(stats.saved)} saved` : undefined}
              icon={Coins}
            />
            <StatCard
              label="Credits"
              value={stats.credits.toFixed(2)}
              icon={Coins}
              tone="warning"
              className="col-span-2 lg:col-span-1"
            />
          </>
        )}
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search model, account, proxy, error…"
          className="sm:flex-1"
        />
        <Select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="sm:w-[180px]"
          aria-label="Filter by provider"
        >
          {PROVIDER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="sm:w-[150px]"
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        loading={loading && logs.length === 0}
        onRowClick={openDetail}
        activeKey={selected?.id ?? null}
        pageSize={25}
        empty={
          <EmptyState
            compact
            icon={search || status !== "all" ? Search : ServerCrash}
            title={search || status !== "all" ? "No matching requests" : "No requests yet"}
            description={
              search || status !== "all"
                ? "Loosen the search or filters to see more rows."
                : "Requests appear here in real time as they hit the proxy."
            }
          />
        }
      />

      <RequestDrawer
        req={selected}
        loading={detailLoading}
        onClose={() => setSelected(null)}
      />
    </PageShell>
  );
}

function RequestDrawer({
  req,
  loading,
  onClose,
}: {
  req: RequestLog | null;
  loading: boolean;
  onClose: () => void;
}) {
  if (!req) return null;
  const credit = getCreditMeta(req);
  const proxy = req.compressionStats?.proxyUsed;

  return (
    <Drawer
      open={Boolean(req)}
      onClose={onClose}
      width="md"
      title={req.model || "Request"}
      subtitle={formatDateTimeID(req.createdAt)}
      meta={
        <>
          <Badge variant={getStatusTone(req.status)} dot>
            {req.status}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {labelProvider(req.provider)}
          </Badge>
          <Badge variant="muted" className="tabular font-normal">
            {formatDuration(req.durationMs)}
          </Badge>
          <ProxyChip stats={req.compressionStats} />
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Total" value={formatNum(req.totalTokens || 0)} tone="info" />
        <Metric label="Prompt" value={formatNum(req.promptTokens || 0)} tone="success" />
        <Metric
          label="Completion"
          value={formatNum(req.completionTokens || 0)}
          tone="primary"
        />
        <Metric
          label="Credit"
          value={Number(req.creditsUsed || 0).toFixed(2)}
          tone="warning"
        />
      </div>

      <DrawerSection title="Routing">
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1">
          <KeyValue
            label="Proxy"
            mono
            value={
              proxy === undefined
                ? "unknown"
                : proxy === null
                  ? "direct (no proxy)"
                  : `${proxy.host} · #${proxy.id}`
            }
          />
          <KeyValue
            label="Account"
            value={req.accountEmail || (req.accountId ? `#${req.accountId}` : "—")}
          />
          <KeyValue
            label="Credit balance"
            mono
            value={`${req.accountQuotaBefore ?? 0} → ${req.accountQuotaAfter ?? 0}`}
          />
          <KeyValue label="Credit source" value={credit.creditSource || "unknown"} />
          {credit.creditUnit && <KeyValue label="Credit unit" value={credit.creditUnit} />}
          {typeof credit.creditRate === "number" && (
            <KeyValue label="Credit rate" mono value={credit.creditRate} />
          )}
        </div>
      </DrawerSection>

      {req.compressionStats && (
        <CompressionPanel stats={req.compressionStats} promptTokens={req.promptTokens} />
      )}

      {req.errorMessage && (
        <DrawerSection title="Error">
          <div className="rounded-md border border-[var(--error)]/30 bg-[var(--error)]/10 p-3 text-xs leading-relaxed text-[var(--error)]">
            {req.errorMessage}
          </div>
        </DrawerSection>
      )}

      {loading && req.requestBody === undefined ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <RefreshCw className="h-3 w-3 animate-spin" /> Loading request & response body…
        </div>
      ) : (
        <>
          <JsonBlock title="Request body" value={req.requestBody} />
          <JsonBlock title="Response body" value={req.responseBody} />
        </>
      )}
    </Drawer>
  );
}

const TECHNIQUE_LABELS: Record<
  keyof NonNullable<CompressionStats["byTechnique"]>,
  string
> = {
  tsc: "TSC (tool schema)",
  rtk: "RTK (tool truncation)",
  dcp: "DCP (dedup)",
  caveman: "Caveman (system prompt)",
  imageDedupe: "Image dedup",
  cacheMarkers: "Cache markers",
};

const RTK_FILTER_LABELS: Record<string, string> = {
  "git-diff": "git diff (hunks)",
  "git-status": "git status",
  tree: "tree (depth ≤ 1)",
  "read-numbered": "Read (line-numbered)",
  grep: "grep (per-file)",
  "dedup-log": "dedup-log",
  generic: "generic head + tail",
};

/** Horizontal bar row used in the compression breakdown. */
function BarRow({
  label,
  value,
  pct,
  indent = false,
}: {
  label: string;
  value: number;
  pct: number;
  indent?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={
          indent
            ? "flex-1 truncate pl-2 text-[var(--muted-foreground)]"
            : "flex-1 truncate text-[var(--foreground)]"
        }
      >
        {label}
      </span>
      <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full bg-[var(--success)] transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="tabular w-14 shrink-0 text-right text-[var(--muted-foreground)]">
        −{formatNum(value)}
      </span>
    </div>
  );
}

function CompressionPanel({
  stats,
  promptTokens,
}: {
  stats: CompressionStats;
  promptTokens: number | null;
}) {
  const { tokensBefore, tokensAfter, saved, byTechnique = {}, rtkFilters, durationMs } = stats;

  const techEntries = Object.entries(byTechnique).filter(
    ([, v]) => typeof v === "number" && v > 0
  ) as Array<[keyof typeof TECHNIQUE_LABELS, number]>;

  const filterEntries: Array<[string, number]> = rtkFilters
    ? Object.entries(rtkFilters)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  // Anchor the displayed before/after to provider-reported prompt_tokens
  // (ground truth) instead of our char/4 heuristic. The internal estimate is
  // only used to allocate per-technique attribution.
  //
  //   actualBefore = promptTokens + saved   (billed without compression)
  //   actualAfter  = promptTokens           (actually billed)
  const hasProviderTruth = typeof promptTokens === "number" && promptTokens > 0;
  const displayAfter = hasProviderTruth ? promptTokens : tokensAfter;
  const displayBefore = hasProviderTruth ? promptTokens + saved : tokensBefore;
  const displayPct = displayBefore > 0 ? (saved / displayBefore) * 100 : 0;

  if (saved <= 0) {
    return (
      <DrawerSection title="Compression">
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--muted-foreground)]">
          Pipeline ran in {durationMs}ms — no compressible content this turn.
        </div>
      </DrawerSection>
    );
  }

  return (
    <DrawerSection title="Compression">
      <div className="rounded-md border border-[var(--success)]/30 bg-[var(--success)]/5 p-3">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-xl font-semibold text-[var(--success)]">
            −{formatNum(saved)}
          </span>
          <span className="text-xs text-[var(--muted-foreground)]">tokens saved</span>
          <span className="tabular ml-auto text-sm font-semibold text-[var(--success)]">
            {displayPct.toFixed(2)}%
          </span>
        </div>

        <div
          className="tabular mt-1 text-[11px] text-[var(--muted-foreground)]"
          title={
            hasProviderTruth
              ? `Anchored to provider-reported prompt_tokens (${formatNum(promptTokens!)}). Internal estimate was ${formatNum(tokensBefore)} → ${formatNum(tokensAfter)}.`
              : "Internal char/4 estimate (provider usage not available)"
          }
        >
          {formatNum(displayBefore)} <span className="opacity-50">→</span>{" "}
          {formatNum(displayAfter)} tokens
          {hasProviderTruth && <span className="ml-1 opacity-50">· actual</span>}
          <span className="ml-2 opacity-50">pipeline {durationMs}ms</span>
        </div>

        {techEntries.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-[var(--border)] pt-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              By technique
            </p>
            {techEntries.map(([key, value]) => (
              <BarRow
                key={key}
                label={TECHNIQUE_LABELS[key]}
                value={value}
                pct={saved > 0 ? (value / saved) * 100 : 0}
              />
            ))}
          </div>
        )}

        {filterEntries.length > 0 && (
          <details className="group mt-2.5">
            <summary className="focus-ring cursor-pointer rounded text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">
              RTK filters ({filterEntries.length})
              <span className="ml-1 opacity-50 group-open:hidden">▸</span>
              <span className="ml-1 hidden opacity-50 group-open:inline">▾</span>
            </summary>
            <div className="mt-1.5 space-y-1.5">
              {filterEntries.map(([name, value]) => {
                const rtkTotal = byTechnique.rtk ?? 0;
                return (
                  <BarRow
                    key={name}
                    indent
                    label={RTK_FILTER_LABELS[name] ?? name}
                    value={value}
                    pct={rtkTotal > 0 ? (value / rtkTotal) * 100 : 0}
                  />
                );
              })}
            </div>
          </details>
        )}
      </div>
    </DrawerSection>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value || {}, null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked (non-https / permissions) — silently ignore
    }
  }

  return (
    <DrawerSection
      title={title}
      actions={
        <button
          onClick={copy}
          className="focus-ring rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      }
    >
      <pre className="max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-inset)] p-3 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
        {text}
      </pre>
    </DrawerSection>
  );
}
