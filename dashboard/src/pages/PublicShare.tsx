import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatNumber } from "@/lib/utils";

/**
 * RETRO EDITION — halaman share public /s.
 * CRT phosphor-green terminal: scanlines, ASCII panel, blinking cursor.
 * Semua fungsi tetap: copy, keyId, period switch, model list.
 */

const PERIODS = [
  { id: "1d", label: "1D", hours: 24 },
  { id: "7d", label: "7D", hours: 24 * 7 },
  { id: "30d", label: "30D", hours: 24 * 30 },
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
  apiKeyName?: string;
  apiKeyLimits?: { rpmLimit: number; tokenLimit: number; tokensUsed: number; modelWhitelist: string };
  usage?: { requests: number; promptTokens: number; completionTokens: number; credits: number; cachedTokens?: number };
  modelUsage?: Array<{ provider: string; model: string; tokens: number; requests: number }>;
  models?: ShareModel[];
}

async function fetchShare(hours: number): Promise<ShareData> {
  const params = new URLSearchParams(window.location.search);
  params.set("hours", hours.toString());
  const res = await fetch(`${API_BASE}/api/share?${params.toString()}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function formatCtx(n: number | null): string {
  if (!n) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Chunky retro progress bar pakai block characters █████░░░ */
function RetroBar({ pct, width = 24, label }: { pct: number; width?: number; label?: string }) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return (
    <span className="whitespace-pre">
      <span className="text-[#9dff70]">{bar.slice(0, width)}</span>
      {label ? <span className="ml-1 opacity-70">{label}</span> : null}
    </span>
  );
}

/** Retro copy button — [COPY] / [OK!] */
function RetroCopy({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <button
      onClick={copy}
      className="shrink-0 border border-[#9dff70]/60 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#9dff70] transition-colors hover:bg-[#9dff70] hover:text-black"
      aria-label={label || "Copy"}
      title={label || "Copy"}
    >
      {copied ? "[OK!]" : "[CP]"}
    </button>
  );
}

/** ASCII double-line panel header: ╔═ TITLE ═╗ */
function PanelTitle({ children }: { children: string }) {
  return (
    <div className="mb-2 font-mono text-[11px] tracking-[0.3em] text-[#baff9e]">
      ── {children} ─────────────────────────
    </div>
  );
}

const STYLE = `
  .crt-wrap { background:#050a03; min-height:100vh; position:relative; }
  .crt-wrap::before {
    content:""; position:fixed; inset:0; pointer-events:none; z-index:40;
    background:repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px);
  }
  .crt-wrap::after {
    content:""; position:fixed; inset:0; pointer-events:none; z-index:41;
    background:radial-gradient(ellipse at center, transparent 55%, rgba(0,20,0,0.5) 100%);
  }
  .retro-blink { animation:blink 1.1s steps(1) infinite; }
  @keyframes blink { 50% { opacity:0; } }
  .retro-glow { text-shadow:0 0 6px rgba(120,255,80,0.55), 0 0 2px rgba(120,255,80,0.9); }
`;

export default function PublicShare() {
  const [period, setPeriod] = useState<string>("1d");
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(async (p: string) => {
    const cfg = PERIODS.find((x) => x.id === p) ?? PERIODS[0];
    try {
      const res = await fetchShare(cfg.hours);
      if (mounted.current) { setData(res); setError(null); }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load(period);
    const iv = setInterval(() => { setTick((t) => t + 1); load(period); }, 30_000);
    return () => { mounted.current = false; clearInterval(iv); };
  }, [load, period]);

  if (error) {
    return (
      <div className="crt-wrap flex min-h-screen items-center justify-center p-6">
        <style>{STYLE}</style>
        <div className="max-w-md border border-[#ff5f56]/60 bg-black/60 p-6 font-mono text-sm text-[#ff5f56]">
          <div className="retro-glow">▓▓ ERROR ▓▓</div>
          <p className="mt-2 text-xs opacity-80">{error}</p>
          <button onClick={() => load(period)} className="mt-4 border border-[#ff5f56]/60 px-3 py-1 text-xs hover:bg-[#ff5f56] hover:text-black">
            [RETRY]
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="crt-wrap flex min-h-screen items-center justify-center p-6">
        <style>{STYLE}</style>
        <div className="font-mono text-sm text-[#9dff70] retro-glow">
          LOADING<span className="retro-blink">_</span>
        </div>
      </div>
    );
  }

  if (!data.enabled) {
    return (
      <div className="crt-wrap flex min-h-screen items-center justify-center p-6">
        <style>{STYLE}</style>
        <div className="max-w-md border border-[#ffd75f]/60 bg-black/60 p-6 text-center font-mono">
          <div className="text-sm text-[#ffd75f] retro-glow">▓▓ OFFLINE ▓▓</div>
          <p className="mt-2 text-xs text-[#9dff70]/70">
            {(data as any).error || "SHARE PAGE DISABLED BY OPERATOR"}
          </p>
        </div>
      </div>
    );
  }

  const baseUrl = `${API_BASE}/v1`;
  const usage = data.usage ?? { requests: 0, promptTokens: 0, completionTokens: 0, credits: 0, cachedTokens: 0 };
  const modelUsage = (data.modelUsage ?? []).slice(0, 8);
  const models = data.models ?? [];
  const visibleModels = showAllModels ? models : models.slice(0, 12);
  const totalTokens = usage.promptTokens + usage.completionTokens;
  const promptPct = totalTokens > 0 ? (usage.promptTokens / totalTokens) * 100 : 0;
  const completionPct = totalTokens > 0 ? (usage.completionTokens / totalTokens) * 100 : 0;
  const maxModelTokens = Math.max(1, ...modelUsage.map((m) => m.tokens));
  const apiKey = data.apiKey || "";
  const maskedKey = apiKey ? `${apiKey.slice(0, 8)}${"•".repeat(Math.max(0, apiKey.length - 12))}` : "";
  const clock = new Date().toISOString().slice(11, 19);

  return (
    <div className="crt-wrap">
      <style>{STYLE}</style>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {/* ── Header ── */}
        <div className="border border-[#9dff70]/50 bg-black/50 p-4 font-mono">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="text-[#baff9e] retro-glow">
              <span className="opacity-60">┌─[</span> ETTEUM POOL <span className="opacity-60">]</span>
              <span className="ml-2 opacity-70">v1.0</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-[#9dff70]/70">
              <span className="retro-blink">●</span> ONLINE · {clock} UTC
            </div>
          </div>
          <div className="mt-2 text-[11px] text-[#9dff70]/60">
            SHARED API ACCESS — OPENAI COMPATIBLE<span className="retro-blink">_</span>
          </div>
        </div>

        {/* ── Connection ── */}
        <div className="mt-4 border border-[#9dff70]/50 bg-black/50 p-4 font-mono">
          <PanelTitle>CONNECTION</PanelTitle>
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[#9dff70]/60">BASE URL</span>
              <span className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-[#baff9e]">{baseUrl}</span>
              <RetroCopy value={baseUrl} label="Copy base URL" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[#9dff70]/60">API KEY</span>
              <span className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-[#baff9e]">
                {showKey ? apiKey : maskedKey}
              </span>
              <button
                onClick={() => setShowKey((v) => !v)}
                className="shrink-0 border border-[#9dff70]/60 px-1.5 py-0.5 text-[10px] tracking-widest text-[#9dff70] hover:bg-[#9dff70] hover:text-black"
                aria-label="Toggle key visibility"
              >
                {showKey ? "[HID]" : "[SHW]"}
              </button>
              <RetroCopy value={apiKey} label="Copy API key" />
            </div>
            {data.apiKeyName && data.apiKeyName !== "master" && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-[#9dff70]/20 pt-2 text-[10px] text-[#9dff70]/70">
                <span>KEY: {data.apiKeyName}</span>
                {data.apiKeyLimits?.modelWhitelist && <span className="font-mono">MODELS: {data.apiKeyLimits.modelWhitelist}</span>}
                <span>RPM: {data.apiKeyLimits?.rpmLimit || "∞"}</span>
                {data.apiKeyLimits?.tokenLimit ? (
                  <span>
                    TOKENS: {formatNumber(data.apiKeyLimits.tokensUsed)}/{formatNumber(data.apiKeyLimits.tokenLimit)}
                  </span>
                ) : null}
              </div>
            )}
            <div className="border-t border-[#9dff70]/20 pt-2 text-[10px] leading-relaxed text-[#9dff70]/60">
              &gt; point your client at BASE URL above, use API KEY as Bearer token
              <br />
              &gt; anthropic-style: POST /v1/messages on same host
            </div>
          </div>
        </div>

        {/* ── Usage ── */}
        <div className="mt-4 border border-[#9dff70]/50 bg-black/50 p-4 font-mono">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <PanelTitle>KEY USAGE</PanelTitle>
            <div className="flex gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  className={`border px-2 py-0.5 text-[10px] tracking-widest transition-colors ${
                    period === p.id
                      ? "border-[#9dff70] bg-[#9dff70] text-black"
                      : "border-[#9dff70]/40 text-[#9dff70]/70 hover:border-[#9dff70] hover:text-[#9dff70]"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[#9dff70]/60">PROMPT</span>
              <RetroBar pct={promptPct} width={26} />
              <span className="tabular text-[#baff9e]">{formatNumber(usage.promptTokens)}</span>
              <span className="text-[#9dff70]/50">({promptPct.toFixed(0)}%)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[#9dff70]/60">COMPLETION</span>
              <RetroBar pct={completionPct} width={26} />
              <span className="tabular text-[#baff9e]">{formatNumber(usage.completionTokens)}</span>
              <span className="text-[#9dff70]/50">({completionPct.toFixed(0)}%)</span>
            </div>
            {usage.cachedTokens !== undefined && usage.cachedTokens > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-[#9dff70]/60">CACHED</span>
                <RetroBar
                  pct={totalTokens > 0 ? (usage.cachedTokens / totalTokens) * 100 : 0}
                  width={26}
                />
                <span className="tabular text-[#baff9e]">{formatNumber(usage.cachedTokens)}</span>
                <span className="text-[#9dff70]/50">(prompt-cache hits)</span>
              </div>
            )}
            <div className="mt-2 border-t border-[#9dff70]/20 pt-2 text-[10px] text-[#9dff70]/70">
              &gt; {formatNumber(usage.requests)} REQUESTS
              {data.apiKeyLimits?.tokenLimit ? (
                <> · <span className="text-[#ffd75f]">{formatNumber(data.apiKeyLimits.tokensUsed)}/{formatNumber(data.apiKeyLimits.tokenLimit)} TOKENS</span></>
              ) : null}
              {" · "}
              <span className="text-[#ffd75f]">AUTO-REFRESH 30s</span>
              <span className="retro-blink">▌</span>
            </div>
          </div>
        </div>

        {/* ── By model ── */}
        {modelUsage.length > 0 && (
          <div className="mt-4 border border-[#9dff70]/50 bg-black/50 p-4 font-mono">
            <PanelTitle>BY MODEL</PanelTitle>
            <div className="space-y-1.5 text-xs">
              {modelUsage.map((row) => {
                const pct = (row.tokens / maxModelTokens) * 100;
                const share = (row.tokens / Math.max(1, totalTokens)) * 100;
                return (
                  <div key={`${row.provider}/${row.model}`} className="flex items-center gap-2">
                    <span className="w-32 shrink-0 truncate text-[#baff9e]" title={`${row.provider}/${row.model}`}>
                      {row.model}
                    </span>
                    <RetroBar pct={pct} width={22} />
                    <span className="tabular text-[#9dff70]/80">{formatNumber(row.tokens)}</span>
                    <span className="text-[#9dff70]/50">tok</span>
                    <span className="text-[#9dff70]/50">· {formatNumber(row.requests)}req · {share.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Model catalogue ── */}
        <div className="mt-4 border border-[#9dff70]/50 bg-black/50 p-4 font-mono">
          <PanelTitle>MODEL CATALOGUE ({models.length})</PanelTitle>
          {models.length === 0 ? (
            <div className="text-xs text-[#9dff70]/50">&gt; no models registered</div>
          ) : (
            <>
              <ul className="space-y-1 text-[11px]">
                {visibleModels.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[#9dff70]">▸</span>
                    <span className="min-w-0 break-all text-[#baff9e]">{m.id}</span>
                    <span className="text-[#9dff70]/50">[{m.provider}]</span>
                    <span className="text-[#9dff70]/50">ctx:{formatCtx(m.contextWindow)}</span>
                    <span className="text-[#9dff70]/50">out:{formatCtx(m.maxOutput)}</span>
                    <span className="flex gap-1 text-[9px]">
                      {m.thinking && <span className="border border-[#9dff70]/40 px-1">THINK</span>}
                      {m.vision && <span className="border border-[#9dff70]/40 px-1">VIS</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {models.length > 12 && (
                <button
                  onClick={() => setShowAllModels((s) => !s)}
                  className="mt-2 w-full border border-[#9dff70]/40 py-1 text-[10px] tracking-widest text-[#9dff70]/70 hover:border-[#9dff70] hover:text-[#9dff70]"
                >
                  [{showAllModels ? "SHOW LESS" : `SHOW ALL ${models.length}`}]
                </button>
              )}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="mt-6 pb-4 text-center font-mono text-[10px] text-[#9dff70]/50">
          ── POWERED BY <span className="text-[#baff9e]">ETTEUM POOL</span> ──
          <br />
          <span className="opacity-50">press F5 to re-establish connection · session #{tick}</span>
        </div>
      </div>
    </div>
  );
}
