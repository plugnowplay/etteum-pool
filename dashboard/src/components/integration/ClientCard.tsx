import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Check,
  Copy,
  Zap,
  ExternalLink,
  RefreshCw,
  Eye,
  EyeOff,
  Search,
  ChevronsUpDown,
} from "lucide-react";
import type { ClientMetaDTO, IntegrationModelDTO } from "@/lib/api";
import { fetchClientConfigPreview } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ConfigPreview } from "./ConfigPreview";

interface ClientCardProps {
  client: ClientMetaDTO;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: IntegrationModelDTO[];
  showPreview?: boolean;
  onModelChange: (model: string) => void;
  onApply: (clientId: string, model: string) => Promise<void>;
  onRestore: (clientId: string) => Promise<void>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        const ok = await copyText(value);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="p-1 rounded hover:bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
      title="Copy"
    >
      {copied ? (
        <Check className="w-3 h-3 text-[var(--success)]" />
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

export function ClientCard({
  client,
  baseUrl,
  apiKey,
  model,
  models,
  showPreview,
  onModelChange,
  onApply,
  onRestore,
}: ClientCardProps) {
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [previewData, setPreviewData] = useState<Record<string, unknown> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Auto-load config preview for schema-enabled clients
  useEffect(() => {
    if (showPreview !== false && !previewData && !previewLoading) {
      setPreviewLoading(true);
      fetchClientConfigPreview(client.id, baseUrl, model)
        .then((data) => { if (data.success && data.preview) setPreviewData(data.preview); })
        .catch(() => {})
        .finally(() => setPreviewLoading(false));
    }
  }, [client.id, baseUrl, model, showPreview]);

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    if (open) { document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey); }
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const filtered = query.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(query.trim().toLowerCase()))
    : models;

  const handleApply = async () => {
    setApplying(true);
    try {
      await onApply(client.id, model);
      setStatus({ ok: true, msg: "Applied" });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setApplying(false);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      await onRestore(client.id);
      setStatus({ ok: true, msg: "Restored" });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setRestoring(false);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  return (
    <Card className={`${!client.detected ? "opacity-70" : ""} transition-all duration-[var(--dur-base)] ease-[var(--ease-out)]`}>
      <CardContent className="space-y-3 p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${client.detected ? "bg-[var(--success)] shadow-[0_0_6px_var(--success)]" : "bg-[var(--muted-foreground)]"}`}
              title={client.detected ? "Detected" : "Not found"}
            />
            <div className="min-w-0">
              <h3 className="truncate text-sm font-medium text-[var(--foreground)]">
                {client.name}
              </h3>
              <p className="truncate text-xs text-[var(--muted-foreground)]">
                {client.detected ? `${client.cli}` : `${client.cli} — not detected`}
              </p>
            </div>
          </div>
          <a
            href={client.url}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring shrink-0 rounded p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            title="Open docs"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        {/* Description */}
        <p className="line-clamp-2 text-xs text-[var(--muted-foreground)]">
          {client.description}
        </p>

        {/* Model selector */}
        <div ref={ref} className="relative">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Model</label>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
            className="focus-ring flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm transition-colors hover:border-[var(--primary)]/40">
            <span className="truncate text-[var(--foreground)]">{model || "— select —"}</span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
          </button>
          {open && (
            <div className="animate-scale-in absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] shadow-[var(--es-3)]">
              <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)]">
                <Search className="w-3.5 h-3.5 text-[var(--muted-foreground)] shrink-0" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models..." className="w-full bg-transparent text-sm focus:outline-none text-[var(--foreground)]" />
              </div>
              <ul className="max-h-[14rem] overflow-y-auto py-1">
                {filtered.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => { onModelChange(m.id); setOpen(false); setQuery(""); }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)] flex items-center justify-between gap-2 ${model === m.id ? "bg-[var(--secondary)]" : ""}`}>
                      <span className="truncate text-[var(--foreground)]">{m.id}</span>
                      <span className="text-xs text-[var(--muted-foreground)] shrink-0">{m.owned_by}</span>
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && <li className="px-3 py-2 text-xs text-[var(--muted-foreground)]">No match</li>}
              </ul>
            </div>
          )}
        </div>

        {/* Config paths */}
        <div className="text-[11px] text-[var(--muted-foreground)] space-y-0.5">
          {client.configPaths.map((p) => (
            <div key={p} className="truncate font-mono" title={p}>
              {p}
            </div>
          ))}
        </div>

        {/* Schema preview (for clients that support it) */}
        {showPreview !== false && (
          <div className="space-y-2">
            <span className="text-[11px] font-medium text-[var(--muted-foreground)]">Config Schema</span>
            {previewLoading ? (
              <div className="px-3 py-4 rounded-md border border-[var(--border)] bg-[var(--background)] text-xs text-[var(--muted-foreground)] flex items-center gap-2">
                <RefreshCw className="w-3 h-3 animate-spin" /> Loading schema...
              </div>
            ) : previewData ? (
              <ConfigPreview config={previewData} />
            ) : null}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={handleApply}
            disabled={applying || !model || !client.detected}
            loading={applying}
            className="gap-1.5 text-xs h-8"
          >
            <Zap className="h-3 w-3" />
            Apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRestore}
            disabled={restoring || !client.detected}
            loading={restoring}
            className="text-xs h-8"
          >
            Restore
          </Button>
          {status && (
            <span
              className={`text-xs ml-auto ${
                status.ok
                  ? "text-[var(--success)]"
                  : "text-[var(--destructive)]"
              }`}
            >
              {status.msg}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
