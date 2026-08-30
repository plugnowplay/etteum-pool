import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput, Input } from "@/components/ui/input";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { Cpu, Copy, Check, Search, ChevronsUpDown, Loader2, CloudDownload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchModels, fetchUpstreamModels, testModel, fetchCustomModels, saveCustomModel, deleteCustomModel } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

interface CustomModelRow {
  id: number;
  provider: string;
  model: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  thinking?: boolean | null;
  vision?: boolean | null;
}

interface CustomModelForm {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  thinking: boolean;
  vision: boolean;
}
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";

interface CustomModelRow {
  id: number;
  provider: string;
  model: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  thinking?: boolean | null;
  vision?: boolean | null;
}

interface CustomModelForm {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  thinking: boolean;
  vision: boolean;
}

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

interface CustomModelRow {
  id: number;
  provider: string;
  model: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  thinking?: boolean | null;
  vision?: boolean | null;
}

interface CustomModelForm {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  thinking: boolean;
  vision: boolean;
}

/** Provider chip palette — token-backed only, no raw Tailwind colors. */
const providerColors: Record<string, string> = {
  kiro: "bg-[var(--chart-2)]/15 text-[var(--chart-2)] border-[var(--chart-2)]/30",
  codebuddy: "bg-[var(--chart-3)]/15 text-[var(--chart-3)] border-[var(--chart-3)]/30",
  "codebuddy-china": "bg-[var(--error)]/15 text-[var(--error)] border-[var(--error)]/30",
  canva: "bg-[var(--chart-6)]/15 text-[var(--chart-6)] border-[var(--chart-6)]/30",
  codex: "bg-[var(--chart-1)]/15 text-[var(--chart-1)] border-[var(--chart-1)]/30",
  qoder: "bg-[var(--chart-4)]/15 text-[var(--chart-4)] border-[var(--chart-4)]/30",
  grok: "bg-[var(--info)]/15 text-[var(--info)] border-[var(--info)]/30",
  "grok-cli": "bg-[var(--chart-5)]/15 text-[var(--chart-5)] border-[var(--chart-5)]/30",
};

function formatNumber(n: number | undefined): string {
  if (!n) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function ModelCombobox({
  models,
  value,
  onChange,
}: {
  models: ModelData[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (container && !container.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, container]);

  const filtered = models.filter((model) => {
    const q = query.toLowerCase().trim();
    return !q || model.id.toLowerCase().includes(q) || model.owned_by.toLowerCase().includes(q);
  });

  return (
    <div ref={setContainer} className="relative">
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        aria-expanded={open}
        aria-label="Select model"
        className="focus-ring min-h-[44px] w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-left text-sm flex md:min-h-0"
      >
        <span className={value ? "truncate text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}>
          {value || "Select model..."}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="animate-scale-in absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] shadow-[var(--es-3)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
            <Search className="h-4 w-4 text-[var(--muted-foreground)]" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search model..."
              aria-label="Search model"
              className="w-full bg-transparent text-sm text-[var(--foreground)] outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => { onChange(model.id); setOpen(false); setQuery(""); }}
                className="focus-ring flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-[var(--secondary)]"
              >
                <span className="truncate text-[var(--foreground)]">{model.id}</span>
                <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{model.owned_by}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-sm text-[var(--muted-foreground)]">No models found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [fetching, setFetching] = useState(false);
  const [upstream, setUpstream] = useState<Record<string, string[]> | null>(null);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({});
  const [customModels, setCustomModels] = useState<CustomModelRow[]>([]);
  const [customForm, setCustomForm] = useState<CustomModelForm>({ provider: "qoder", model: "", contextWindow: 200000, maxOutput: 8192, thinking: false, vision: false });
  const [customBusy, setCustomBusy] = useState(false);
  const [customEditing, setCustomEditing] = useState<string | null>(null);
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);
  const toast = useToast();

  async function handleFetchUpstream() {
    setFetching(true);
    setUpstream(null);
    try {
      const res = await fetchUpstreamModels("all");
      const map: Record<string, string[]> = {};
      for (const p of res.providers || []) {
        if (p.ok && p.models?.length) map[p.provider] = p.models;
      }
      setUpstream(map);
      toast.success(`Upstream models fetched for ${Object.keys(map).length} provider(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  async function handleTestModel(modelId: string) {
    setTestingModel(modelId);
    try {
      const res = await testModel(modelId);
      setTestResult((prev) => ({
        ...prev,
        [modelId]: { ok: res.success === true, latencyMs: res.latencyMs, error: res.error },
      }));
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [modelId]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setTestingModel((prev) => (prev === modelId ? null : prev));
    }
  }

  async function loadCustom() {
    try {
      const res = await fetchCustomModels();
      setCustomModels(res.data || []);
    } catch { /* non-fatal */ }
  }

  async function handleSaveCustom() {
    const model = customForm.model.trim();
    if (!customForm.provider || !model) { toast.error("Provider dan model wajib diisi"); return; }
    setCustomBusy(true);
    try {
      await saveCustomModel(customForm.provider, model, {
        contextWindow: Number(customForm.contextWindow) || 200000,
        maxOutput: Number(customForm.maxOutput) || 8192,
        thinking: customForm.thinking,
        vision: customForm.vision,
      });
      toast.success(`Model ${customForm.provider}/${model} tersimpan`);
      setCustomForm({ provider: "qoder", model: "", contextWindow: 200000, maxOutput: 8192, thinking: false, vision: false });
      await loadCustom();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomBusy(false);
    }
  }

  async function handleDeleteCustom(provider: string, model: string) {
    setCustomBusy(true);
    try {
      await deleteCustomModel(provider, model);
      toast.success(`Model ${provider}/${model} dihapus`);
      await loadCustom();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomBusy(false);
    }
  }

  function startEditCustom(row: CustomModelRow) {
    setCustomForm({
      provider: row.provider,
      model: row.model,
      contextWindow: Number(row.contextWindow ?? 200000),
      maxOutput: Number(row.maxOutput ?? 8192),
      thinking: Boolean(row.thinking),
      vision: Boolean(row.vision),
    });
  }

  const load = useCallback(() => {
    return fetchModels()
      .then((res: { data: ModelData[] }) => {
        setModels(res.data || []);
        setLoading(false);
      })
      .catch(() => {
        setModels([]);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live refresh whenever the account pool changes — model availability is
  // derived from which accounts are active/enabled.
  useWsEvent(
    ["account_created", "account_updated", "account_deleted", "accounts_updated", "accounts_bulk_created", "account_status", "provider_toggled", "byok_created", "byok_updated", "byok_deleted"],
    load,
  );

  const providers = ["all", ...Array.from(new Set(models.map((m) => m.owned_by)))];

  const filtered = models
    .filter((m) => filter === "all" || m.owned_by === filter)
    .filter((m) =>
      search === "" ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase())
    );

  async function copyModelId(modelId: string) {
    await copyText(modelId);
    setCopiedModel(modelId);
  }

  const columns: Column<ModelData>[] = [
    {
      key: "id",
      header: "Model",
      primary: true,
      sortValue: (m) => m.id,
      cell: (m) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--foreground)]">{m.id}</span>
          {upstream && (
            <Badge variant={upstream[m.owned_by]?.includes(m.id.split("/").slice(1).join("/")) ? "success" : "muted"} className="text-[10px]">
              upstream
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      sortValue: (m) => m.owned_by,
      cell: (m) => (
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            providerColors[m.owned_by] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)]"
          }`}
        >
          {m.owned_by}
        </span>
      ),
    },
    {
      key: "context",
      header: "Context",
      align: "right",
      hideBelow: "md",
      width: "w-[100px]",
      sortValue: (m) => m.context_window ?? 0,
      cell: (m) => (
        <span className="tabular text-sm text-[var(--foreground)]">
          {formatNumber(m.context_window)}
        </span>
      ),
    },
    {
      key: "output",
      header: "Output",
      align: "right",
      hideBelow: "md",
      width: "w-[100px]",
      sortValue: (m) => m.max_output ?? 0,
      cell: (m) => (
        <span className="tabular text-sm text-[var(--foreground)]">
          {formatNumber(m.max_output)}
        </span>
      ),
    },
    {
      key: "features",
      header: "Features",
      hideBelow: "lg",
      sortValue: (m) => (m.thinking ? 1 : 0),
      cell: (m) =>
        m.thinking ? (
          <Badge variant="info" className="text-xs font-normal">
            Thinking
          </Badge>
        ) : (
          <span className="text-[var(--muted-foreground)]">—</span>
        ),
    },
    {
      key: "test",
      header: "",
      align: "right",
      width: "w-[110px]",
      cell: (m) => {
        const res = testResult[m.id];
        return (
          <div className="flex items-center justify-end gap-1.5">
            {res && (
              <span
                className={`tabular text-[11px] ${res.ok ? "text-[var(--success)]" : "text-[var(--error)]"}`}
                title={res.error || `OK in ${res.latencyMs}ms`}
              >
                {res.ok ? `${res.latencyMs}ms` : "fail"}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleTestModel(m.id)}
              disabled={testingModel === m.id}
              className="h-7 px-2 text-xs"
            >
              {testingModel === m.id ? "…" : "Test"}
            </Button>
          </div>
        );
      },
    },
    {
      key: "copy",
      header: "",
      align: "right",
      width: "w-12",
      cell: (m) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Copy model ID: ${m.id}`}
          title={`Copy model ID: ${m.id}`}
          onClick={(e) => {
            e.stopPropagation();
            copyModelId(m.id);
          }}
        >
          {copiedModel === m.id ? (
            <Check className="h-4 w-4 text-[var(--success)]" />
          ) : (
            <Copy className="h-4 w-4 text-[var(--muted-foreground)]" />
          )}
        </Button>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Models"
        description="Every model exposed by the pool, with context and output limits."
        badge={
          <Badge variant="muted" className="tabular">
            {models.length}
          </Badge>
        }
        actions={
          <Button variant="outline" size="sm" onClick={handleFetchUpstream} disabled={fetching}>
            {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
            {fetching ? "Fetching…" : "Fetch from Upstream"}
          </Button>
        }
      />
      {upstream && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <label className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              Upstream models ({Object.keys(upstream).length} provider{Object.keys(upstream).length === 1 ? "" : "s"})
            </label>
            {Object.entries(upstream).map(([provider, list]) => (
              <div key={provider} className="space-y-1">
                <p className="text-xs font-medium text-[var(--foreground)]">
                  {provider} <span className="text-[var(--muted-foreground)]">({list.length})</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {list.slice(0, 40).map((m) => (
                    <code key={m} className="rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[10px]">{m}</code>
                  ))}
                  {list.length > 40 && <span className="text-[10px] text-[var(--muted-foreground)]">+{list.length - 40} more</span>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <label className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            Custom models ({customModels.length}) — tambah/edit manual, merge ke daftar pool
          </label>
          <div className="grid gap-2 sm:grid-cols-[140px_1fr_110px_110px_auto]">
            <select
              value={customForm.provider}
              onChange={(e) => setCustomForm({ ...customForm, provider: e.target.value })}
              className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm"
              aria-label="Provider"
            >
              {["qoder", "codebuddy-china", "codebuddy", "grok", "grok-cli", "codex", "kiro", "canva"].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <Input
              value={customForm.model}
              onChange={(e) => setCustomForm({ ...customForm, model: e.target.value })}
              placeholder="nama model (mis. Qwen3.9-Max)"
              className="font-mono text-sm"
            />
            <Input
              type="number"
              value={customForm.contextWindow}
              onChange={(e) => setCustomForm({ ...customForm, contextWindow: Number(e.target.value) })}
              placeholder="ctx"
              className="text-sm"
              aria-label="Context window"
            />
            <Input
              type="number"
              value={customForm.maxOutput}
              onChange={(e) => setCustomForm({ ...customForm, maxOutput: Number(e.target.value) })}
              placeholder="max out"
              className="text-sm"
              aria-label="Max output"
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                <input type="checkbox" checked={customForm.thinking} onChange={(e) => setCustomForm({ ...customForm, thinking: e.target.checked })} /> Think
              </label>
              <label className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                <input type="checkbox" checked={customForm.vision} onChange={(e) => setCustomForm({ ...customForm, vision: e.target.checked })} /> Vision
              </label>
              <Button size="sm" onClick={handleSaveCustom} disabled={customBusy}>
                {customBusy ? "Saving…" : customEditing ? "Update" : "Add"}
              </Button>
              {customEditing && (
                <Button size="sm" variant="outline" onClick={() => { setCustomEditing(null); setCustomForm((f) => ({ ...f, model: "" })); }}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
          {customModels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {customModels.map((cm) => (
                <span key={`${cm.provider}/${cm.model}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 py-1 text-xs">
                  <code className="font-mono">{cm.provider}/{cm.model}</code>
                  <span className="text-[10px] text-[var(--muted-foreground)]">{formatNumber(cm.contextWindow ?? undefined)}ctx</span>
                  <button
                    onClick={() => {
                      setCustomEditing(`${cm.provider}/${cm.model}`);
                      setCustomForm({
                        provider: cm.provider,
                        model: cm.model,
                        contextWindow: cm.contextWindow ?? 200000,
                        maxOutput: cm.maxOutput ?? 8192,
                        thinking: Boolean(cm.thinking),
                        vision: Boolean(cm.vision),
                      });
                    }}
                    className="text-[var(--info)] hover:underline"
                    title="Edit"
                  >✎</button>
                  <button
                    onClick={() => handleDeleteCustom(cm.provider, cm.model)}
                    className="text-[var(--error)] hover:underline"
                    title="Delete"
                  >✕</button>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search models, owners…"
          className="sm:flex-1"
        />
      </div>

      <Card>
        <CardContent className="space-y-2 p-4">
          <label className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            Quick model select
          </label>
          <ModelCombobox
            models={models}
            value={selectedModel}
            onChange={async (modelId) => {
              setSelectedModel(modelId);
              await copyModelId(modelId);
              toast.success(`Copied ${modelId}`);
            }}
          />
          {selectedModel && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Selected and copied: <code className="text-[var(--foreground)]">{selectedModel}</code>
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`focus-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--dur-fast)] ${
              filter === p
                ? "border border-[var(--info)]/30 bg-[var(--info)]/20 text-[var(--info)]"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(m) => m.id}
        loading={loading}
        pageSize={25}
        empty={
          <EmptyState
            compact
            icon={search || filter !== "all" ? Search : Cpu}
            title="No models found"
            description={
              search || filter !== "all"
                ? "Try adjusting your search or filter."
                : "No models are exposed by the pool yet."
            }
          />
        }
      />
    </PageShell>
  );
}
