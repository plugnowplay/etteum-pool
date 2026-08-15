import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/input";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { Cpu, Copy, Check, Search, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchModels } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

/** Provider chip palette — token-backed only, no raw Tailwind colors. */
const providerColors: Record<string, string> = {
  kiro: "bg-[var(--chart-2)]/15 text-[var(--chart-2)] border-[var(--chart-2)]/30",
  "kiro-pro": "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/30",
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
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);
  const toast = useToast();

  useEffect(() => {
    fetchModels()
      .then((res: { data: ModelData[] }) => {
        setModels(res.data || []);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  const providers = ["all", ...Array.from(new Set(models.map((m) => m.owned_by)))];

  const filtered = models
    .filter((m) => filter === "all" || m.owned_by === filter)
    .filter((m) =>
      search === "" ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase())
    );

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModel(modelId);
  }

  const columns: Column<ModelData>[] = [
    {
      key: "id",
      header: "Model",
      primary: true,
      sortValue: (m) => m.id,
      cell: (m) => (
        <span className="text-sm font-medium text-[var(--foreground)]">{m.id}</span>
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
      />

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
