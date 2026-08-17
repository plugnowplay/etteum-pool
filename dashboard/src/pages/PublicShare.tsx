import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import { modelColor, formatNumber } from "@/lib/utils";
import { Check, Copy, Eye, EyeOff, RefreshCw, Server, Zap } from "lucide-react";

/**
 * Public landing page at /s — shareable read-only view of the pool:
 * connection info (base URL + key), usage bars, and the model catalogue.
 * Served unauthenticated via GET /api/share (gated by `share_page_enabled`).
 */

const PERIODS = [
  { id: "1d", label: "1d", hours: 24 },
  { id: "7d", label: "7d", hours: 24 * 7 },
  { id: "30d", label: "30d", hours: 24 * 30 },
] as const;

interface ShareModel {
  id: string;
  provider: string;
  contextWindow: number | null;
  maxOutput: number | null;
  thinking: boolean;
  vision: boolean;
}

interface ShareData {
  enabled: boolean;
  hours?: number;
  apiKey?: string;
  usage?: { requests: number; promptTokens: number; completionTokens: number; credits: number };
  modelUsage?: Array<{ provider: string; model: string; tokens: number; requests: number }>;
  models?: ShareModel[];
}

async function fetchShare(hours: number): Promise<ShareData> {
  const res = await fetch(`${API_BASE}/api/share?hours=${hours}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function CopyField({ label, value, display }: { label: string; value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  const [show, setShow] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const secret = /sk-/.test(value);
  const text = secret && !show ? `${value.slice(0, 8)}${"•".repeat(Math.max(0, value.length - 12))}` : (display ?? value);

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-[var(--muted-foreground)]">{label}</label>
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-[var(--foreground)]">{text}</pre>
        {secret && (
          <button
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide key" : "Reveal key"}
            className="focus-ring shrink-0 rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          onClick={copy}
          aria-label={`Copy ${label}`}
          title={copied ? "Copied" : "Copy"}
          className="focus-ring shrink-0 rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function formatCtx(n: number | null): string {
  if (!n) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export default function PublicShare() {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>("1d");
  const [showAllModels, setShowAllModels] = useState(false);
  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const cfg = PERIODS.find((p) => p.id === period) ?? PERIODS[0];
    try {
      const res = await fetchShare(cfg.hours);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (reloadRef.current) clearTimeout(reloadRef.current);
    };
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6">
        <div className="max-w-md space-y-2 text-center">
          <img src="/etteum.svg" alt="" className="mx-auto h-10 w-10 opacity-60" />
          <h1 className="text-lg font-semibold text-[var(--foreground)]">Share page unavailable</h1>
          <p className="text-sm text-[var(--muted-foreground)]">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
        <img src="/etteum.svg" alt="" className="h-10 w-10 animate-pulse" />
      </div>
    );
  }

  if (!data.enabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6">
        <div className="max-w-md space-y-2 text-center">
          <img src="/etteum.svg" alt="" className="mx-auto h-10 w-10 opacity-60" />
          <h1 className="text-lg font-semibold text-[var(--foreground)]">This share page is turned off</h1>
          <p className="text-sm text-[var(--muted-foreground)]">The pool owner has disabled public sharing.</p>
        </div>
      </div>
    );
  }

  const baseUrl = `${API_BASE}/v1`;
  const usage = data.usage ?? { requests: 0, promptTokens: 0, completionTokens: 0, credits: 0 };
  const modelUsage = (data.modelUsage ?? []).slice(0, 8);
  const models = data.models ?? [];
  const visibleModels = showAllModels ? models : models.slice(0, 12);
  const totalTokens = usage.promptTokens + usage.completionTokens;
  const promptPct = totalTokens > 0 ? (usage.promptTokens / totalTokens) * 100 : 0;
  const completionPct = totalTokens > 0 ? (usage.completionTokens / totalTokens) * 100 : 0;
  const maxModelTokens = Math.max(1, ...modelUsage.map((m) => m.tokens));
  const apiKey = data.apiKey || "";

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <img src="/etteum.svg" alt="" className="h-8 w-8" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Etteum Pool</h1>
              <p className="text-xs text-[var(--muted-foreground)]">Shared API access</p>
            </div>
          </div>
          <button
            onClick={load}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/50 hover:text-[var(--foreground)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </header>

        {/* Connection info */}
        <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Server className="h-4 w-4 text-[var(--primary)]" /> Connect any OpenAI-compatible client
          </h2>
          <CopyField label="Base URL" value={baseUrl} />
          <CopyField label="API Key" value={apiKey || "<not available>"} />
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            Point your client at the Base URL above and use the API key as the Bearer token. Anthropic-style clients
            can call <code className="rounded bg-[var(--secondary)] px-1 py-0.5 font-mono">/v1/messages</code> on the
            same host.
          </p>
        </section>

        {/* Usage */}
        <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-[var(--warning)]" /> Pool usage
            </h2>
            <div className="flex items-center gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    period === p.id
                      ? "bg-[var(--primary)]/10 text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Prompt / completion split */}
          <div className="space-y-2">
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
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--chart-2)" }} />
                Prompt <span className="tabular font-medium text-[var(--foreground)]">{formatNumber(usage.promptTokens)}</span>
                <span className="tabular">({promptPct.toFixed(0)}%)</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--chart-3)" }} />
                Completion{" "}
                <span className="tabular font-medium text-[var(--foreground)]">{formatNumber(usage.completionTokens)}</span>
                <span className="tabular">({completionPct.toFixed(0)}%)</span>
              </span>
              <span className="ml-auto tabular">
                {formatNumber(usage.requests)} requests · {usage.credits.toFixed(1)} credits
              </span>
            </div>
          </div>

          {/* Per-model bars */}
          {modelUsage.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-xs font-medium text-[var(--muted-foreground)]">By model</h3>
              {modelUsage.map((row, idx) => {
                const pct = (row.tokens / maxModelTokens) * 100;
                const share = (row.tokens / Math.max(1, totalTokens)) * 100;
                return (
                  <div key={`${row.provider}/${row.model}`} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate font-mono text-[var(--foreground)]">{row.model}</span>
                      <span className="shrink-0 tabular text-[var(--muted-foreground)]">
                        {formatNumber(row.tokens)} <span className="opacity-60">tokens</span>
                        <span className="mx-1 opacity-40">·</span>
                        {formatNumber(row.requests)} <span className="opacity-60">req</span>
                        <span className="mx-1 opacity-40">·</span>
                        {share.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--secondary)]">
                      <div
                        className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
                        style={{ width: `${pct}%`, backgroundColor: modelColor(`${row.provider}/${row.model}`, idx) }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Models */}
        <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Available models</h2>
            <span className="text-xs text-[var(--muted-foreground)] tabular">{models.length} models</span>
          </div>
          {models.length === 0 ? (
            <p className="text-xs text-[var(--muted-foreground)]">No models registered.</p>
          ) : (
            <>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {visibleModels.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-[var(--foreground)]">{m.id}</p>
                      <p className="text-[10px] text-[var(--muted-foreground)]">
                        {m.provider}
                        {m.contextWindow ? ` · ${formatCtx(m.contextWindow)} ctx` : ""}
                        {m.maxOutput ? ` · ${formatCtx(m.maxOutput)} out` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {m.thinking && (
                        <span className="rounded bg-[var(--primary)]/10 px-1.5 py-0.5 text-[9px] font-medium text-[var(--primary)]">
                          THINK
                        </span>
                      )}
                      {m.vision && (
                        <span className="rounded bg-[var(--chart-4, #8b5cf6)]/15 px-1.5 py-0.5 text-[9px] font-medium text-[var(--chart-4, #8b5cf6)]">
                          VISION
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {models.length > 12 && (
                <button
                  onClick={() => setShowAllModels((s) => !s)}
                  className="w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/50 hover:text-[var(--foreground)]"
                >
                  {showAllModels ? "Show less" : `Show all ${models.length} models`}
                </button>
              )}
            </>
          )}
        </section>

        <footer className="pb-4 text-center text-[11px] text-[var(--muted-foreground)]">
          Powered by <span className="font-medium">Etteum Pool</span>
        </footer>
      </div>
    </div>
  );
}
