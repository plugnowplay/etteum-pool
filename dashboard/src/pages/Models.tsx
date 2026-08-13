import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

const providerColors: Record<string, string> = {
  kiro: "bg-[var(--chart-2)]/15 text-[var(--chart-2)] border-[var(--chart-2)]/30",
  "kiro-pro": "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/30",
  codebuddy: "bg-[var(--chart-3)]/15 text-[var(--chart-3)] border-[var(--chart-3)]/30",
  "codebuddy-china": "bg-red-500/15 text-red-400 border-red-400/30",
  canva: "bg-[var(--chart-6)]/15 text-[var(--chart-6)] border-[var(--chart-6)]/30",
  codex: "bg-[var(--chart-1)]/15 text-[var(--chart-1)] border-[var(--chart-1)]/30",
  qoder: "bg-[var(--chart-4)]/15 text-[var(--chart-4)] border-[var(--chart-4)]/30",
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
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm text-left focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
      >
        <span className={value ? "truncate text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}>
          {value || "Select model..."}
        </span>
        <ChevronsUpDown className="w-4 h-4 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg">
          <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
            <Search className="w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search model..."
              className="w-full bg-transparent text-sm text-[var(--foreground)] outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => { onChange(model.id); setOpen(false); setQuery(""); }}
                className="w-full flex items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm hover:bg-[var(--secondary)]"
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Models</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          {models.length} models available across {new Set(models.map((m) => m.owned_by)).size} providers
        </p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              type="text"
              placeholder="Search models, owners..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Model combobox */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <label className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
            Quick model select
          </label>
          <ModelCombobox
            models={models}
            value={selectedModel}
            onChange={async (modelId) => {
              setSelectedModel(modelId);
              await copyModelId(modelId);
            }}
          />
          {selectedModel && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Selected and copied: <code className="text-[var(--foreground)]">{selectedModel}</code>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === p
                ? "bg-[var(--info)]/20 text-[var(--info)] border border-[var(--info)]/30"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/50">
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Model
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Context
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Output
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Features
                  </th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((model) => (
                  <tr
                    key={model.id}
                    className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--secondary)]/30 transition-colors"
                  >
                    {/* Model ID */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--foreground)]">
                          {model.id}
                        </span>
                      </div>
                    </td>

                    {/* Owner */}
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${providerColors[model.owned_by] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)]"}`}>
                        {model.owned_by}
                      </span>
                    </td>

                    {/* Context */}
                    <td className="py-3 px-4 text-sm text-[var(--foreground)]">
                      {formatNumber(model.context_window)}
                    </td>

                    {/* Output */}
                    <td className="py-3 px-4 text-sm text-[var(--foreground)]">
                      {formatNumber(model.max_output)}
                    </td>

                    {/* Features */}
                    <td className="py-3 px-4">
                      {model.thinking && (
                        <Badge variant="default" className="text-xs">
                          Thinking
                        </Badge>
                      )}
                    </td>

                    {/* Copy Button */}
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => copyModelId(model.id)}
                        title={`Copy model ID: ${model.id}`}
                        className="p-1.5 rounded-md hover:bg-[var(--secondary)] transition-colors group"
                      >
                        {copiedModel === model.id ? (
                          <Check className="w-4 h-4 text-[var(--success)]" />
                        ) : (
                          <Copy className="w-4 h-4 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <Cpu className="w-12 h-12 text-[var(--muted-foreground)] mb-4" />
              <p className="text-[var(--muted-foreground)]">No models found</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Try adjusting your search or filter
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
