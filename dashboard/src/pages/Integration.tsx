import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageShell, SectionHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import {
  ArrowRight,
  Search,
  ChevronsUpDown,
  Check,
  Copy,
  Terminal,
  Zap,
  Code,
  Box,
  Hammer,
  PawPrint,
} from "lucide-react";
import {
  fetchIntegration,
  saveIntegration,
  fetchApiKey,
  applyIntegrationConfig,
  fetchIntegrationClients,
  applyClientConfig,
  applyAllClients,
  restoreClientConfig,
  API_BASE,
  type ModelMappingDTO,
  type ClientMetaDTO,
  type IntegrationModelDTO,
} from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";
import { ClientCard } from "@/components/integration/ClientCard";

// Claude Code only ever calls these three model classes.
const CLAUDE_CODE_SLOTS = [
  { source: "haiku", title: "Haiku", desc: "small / fast / background tasks" },
  { source: "sonnet", title: "Sonnet", desc: "main coding model" },
  { source: "opus", title: "Opus", desc: "heavy reasoning" },
] as const;

/** Searchable model dropdown. */
function ModelCombobox({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; owned_by: string }[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, containerRef]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) =>
          o.id.toLowerCase().includes(q) || o.owned_by.toLowerCase().includes(q)
      )
    : options;

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={setContainerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="focus-ring flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:border-[var(--muted-foreground)]/40 md:min-h-0"
      >
        <span
          className={
            value
              ? "truncate font-mono text-xs text-[var(--foreground)]"
              : "truncate text-[var(--muted-foreground)]"
          }
        >
          {value || "— pass through (no mapping) —"}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="animate-scale-in absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] shadow-[var(--es-3)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="w-full bg-transparent text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-[18rem] overflow-y-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => select("")}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--secondary)] ${
                  !value ? "bg-[var(--secondary)]" : ""
                }`}
              >
                <span className="text-[var(--muted-foreground)]">
                  — pass through (no mapping) —
                </span>
                {!value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
              </button>
            </li>
            {filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => select(o.id)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--secondary)] ${
                    value === o.id ? "bg-[var(--secondary)]" : ""
                  }`}
                >
                  <span className="truncate font-mono text-xs text-[var(--foreground)]">
                    {o.id}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {o.owned_by}
                    </span>
                    {value === o.id && (
                      <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
                    )}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
                No models match "{query}".
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Integration() {
  const [enabled, setEnabled] = useState(true);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [clients, setClients] = useState<ClientMetaDTO[]>([]);
  const [integrationModels, setIntegrationModels] = useState<IntegrationModelDTO[]>(
    []
  );
  const [activeTab, setActiveTab] = useState("claude");
  const toast = useToast();

  const baseUrl = API_BASE;
  const defaultModel = "kp-sonnet-4.6";

  // Per-client model selection
  const [clientModels, setClientModels] = useState<Record<string, string>>({
    opencode: "kp-sonnet-4.6",
    codex: "codex-auto",
    hermes: "kp-sonnet-4.6",
    openclaw: "kp-sonnet-4.6",
    kilo: "kp-sonnet-4.6",
  });

  const load = useCallback(async () => {
    try {
      const [data, keyRes] = await Promise.all([
        fetchIntegration(),
        fetchApiKey().catch(() => null),
      ]);
      setEnabled(data.enabled);
      setModels(data.models || []);

      const next: Record<string, string> = {};
      for (const slot of CLAUDE_CODE_SLOTS) {
        const found = (data.mappings || []).find(
          (m) => m.sourcePattern.toLowerCase() === slot.source
        );
        next[slot.source] = found?.targetModel || "";
      }
      setTargets(next);
      if (keyRes?.key) setApiKey(keyRes.key);
    } catch (e: any) {
      toast.error(e.message || "Failed to load integration settings");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadClients = useCallback(async () => {
    try {
      const data = await fetchIntegrationClients();
      setClients(data.clients || []);
      setIntegrationModels(data.models || []);
    } catch (e: any) {
      console.error("Failed to load clients:", e);
    }
  }, []);

  useEffect(() => {
    load();
    loadClients();
  }, [load, loadClients]);
  useWsEvent(["model_mappings_updated"], load);

  const handleSave = async () => {
    setSaving(true);
    try {
      const mappings: ModelMappingDTO[] = CLAUDE_CODE_SLOTS.map((slot, i) => ({
        sourcePattern: slot.source,
        matchType: "contains",
        targetModel: targets[slot.source] || "",
        enabled: Boolean(targets[slot.source]),
        priority: i,
        label: `Claude Code · ${slot.title}`,
      }));
      await saveIntegration({ enabled, mappings });
      toast.success("Saved");
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleApplyConfig = async () => {
    setApplying(true);
    try {
      await applyIntegrationConfig(baseUrl);
      toast.success("Applied configuration to ~/.claude/settings.json");
    } catch (e: any) {
      toast.error(e.message || "Failed to apply configuration");
    } finally {
      setApplying(false);
    }
  };

  const handleApplyClient = async (clientId: string, model: string) => {
    await applyClientConfig(clientId, baseUrl, model);
    await loadClients();
  };

  const handleRestoreClient = async (clientId: string) => {
    await restoreClientConfig(clientId);
    await loadClients();
  };

  const mappedCount = CLAUDE_CODE_SLOTS.filter((s) => targets[s.source]).length;

  return (
    <PageShell>
      <PageHeader
        title="Integration"
        description="Connect AI coding tools to your proxy pool."
        badge={
          <Badge variant={enabled ? "success" : "muted"} dot>
            {enabled ? "mapping on" : "mapping off"}
          </Badge>
        }
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="claude" className="gap-1.5">
            <Terminal className="h-3.5 w-3.5" /> Claude
          </TabsTrigger>
          <TabsTrigger value="opencode" className="gap-1.5">
            <Code className="h-3.5 w-3.5" /> OpenCode
          </TabsTrigger>
          <TabsTrigger value="codex" className="gap-1.5">
            <Box className="h-3.5 w-3.5" /> Codex
          </TabsTrigger>
          <TabsTrigger value="hermes" className="gap-1.5">
            <Hammer className="h-3.5 w-3.5" /> Hermes
          </TabsTrigger>
          <TabsTrigger value="openclaw" className="gap-1.5">
            <PawPrint className="h-3.5 w-3.5" /> OpenClaw
          </TabsTrigger>
          <TabsTrigger value="kilo" className="gap-1.5">
            <Zap className="h-3.5 w-3.5" /> Kilo
          </TabsTrigger>
        </TabsList>

        {/* ── Claude Tab ──────────────────────────────────────── */}
        <TabsContent value="claude" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-[var(--muted-foreground)]" />
                Claude Code Setup
              </CardTitle>
              <CardDescription>
                Point Claude Code at this proxy — writes{" "}
                <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 font-mono">
                  ANTHROPIC_BASE_URL
                </code>{" "}
                and{" "}
                <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 font-mono">
                  ANTHROPIC_AUTH_TOKEN
                </code>{" "}
                into{" "}
                <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 font-mono">
                  ~/.claude/settings.json
                </code>
                .
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <CodeRow label="ANTHROPIC_BASE_URL" value={baseUrl} />
                <CodeRow
                  label="ANTHROPIC_AUTH_TOKEN"
                  value={apiKey || "<YOUR_API_KEY>"}
                />
              </div>
              <Button onClick={handleApplyConfig} loading={applying}>
                {!applying && <Zap className="h-4 w-4" />}
                Apply Config
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionHeader
                title="Model Mapping"
                description="Changes apply after Save."
                actions={
                  <>
                    <Badge variant="muted" className="tabular">
                      {mappedCount}/{CLAUDE_CODE_SLOTS.length}
                    </Badge>
                    <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-[var(--foreground)]">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                        className="accent-[var(--primary)]"
                      />
                      Enable mapping
                    </label>
                    <Button size="sm" onClick={handleSave} loading={saving}>
                      {saving ? "Saving…" : "Save"}
                    </Button>
                  </>
                }
              />
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  {CLAUDE_CODE_SLOTS.map((slot) => (
                    <div
                      key={slot.source}
                      className="flex flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 sm:flex-row sm:items-center"
                    >
                      <div className="shrink-0 space-y-1.5 sm:w-48">
                        <Skeleton className="h-3.5 w-20" />
                        <Skeleton className="h-2.5 w-32" />
                      </div>
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {CLAUDE_CODE_SLOTS.map((slot) => (
                    <div
                      key={slot.source}
                      className="flex flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 sm:flex-row sm:items-center"
                    >
                      <div className="shrink-0 sm:w-48">
                        <div className="text-sm font-medium text-[var(--foreground)]">
                          {slot.title}
                        </div>
                        <div className="text-xs text-[var(--muted-foreground)]">
                          {slot.desc}
                        </div>
                      </div>
                      <ArrowRight className="hidden h-4 w-4 shrink-0 text-[var(--muted-foreground)] sm:block" />
                      <ModelCombobox
                        value={targets[slot.source] || ""}
                        options={models}
                        onChange={(id) =>
                          setTargets((t) => ({ ...t, [slot.source]: id }))
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs leading-relaxed text-[var(--muted-foreground)]">
                Leave "pass through" to keep original behavior.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── OpenCode Tab ────────────────────────────────────── */}
        <TabsContent value="opencode" className="space-y-6">
          {clients
            .filter((c) => c.id === "opencode")
            .map((c) => (
              <ClientCard
                key={c.id}
                client={c}
                baseUrl={baseUrl}
                apiKey={apiKey}
                model={clientModels.opencode || defaultModel}
                models={integrationModels}
                showPreview
                onModelChange={(m) =>
                  setClientModels((p) => ({ ...p, opencode: m }))
                }
                onApply={handleApplyClient}
                onRestore={handleRestoreClient}
              />
            ))}
        </TabsContent>

        {/* ── Codex Tab ───────────────────────────────────────── */}
        <TabsContent value="codex" className="space-y-6">
          {clients
            .filter((c) => c.id === "codex")
            .map((c) => (
              <ClientCard
                key={c.id}
                client={c}
                baseUrl={baseUrl}
                apiKey={apiKey}
                model={clientModels.codex || "codex-auto"}
                models={integrationModels}
                showPreview={false}
                onModelChange={(m) => setClientModels((p) => ({ ...p, codex: m }))}
                onApply={handleApplyClient}
                onRestore={handleRestoreClient}
              />
            ))}
        </TabsContent>

        {/* ── Hermes Tab ──────────────────────────────────────── */}
        <TabsContent value="hermes" className="space-y-6">
          {clients
            .filter((c) => c.id === "hermes")
            .map((c) => (
              <ClientCard
                key={c.id}
                client={c}
                baseUrl={baseUrl}
                apiKey={apiKey}
                model={clientModels.hermes || defaultModel}
                models={integrationModels}
                showPreview={false}
                onModelChange={(m) => setClientModels((p) => ({ ...p, hermes: m }))}
                onApply={handleApplyClient}
                onRestore={handleRestoreClient}
              />
            ))}
        </TabsContent>

        {/* ── OpenClaw Tab ────────────────────────────────────── */}
        <TabsContent value="openclaw" className="space-y-6">
          {clients
            .filter((c) => c.id === "openclaw")
            .map((c) => (
              <ClientCard
                key={c.id}
                client={c}
                baseUrl={baseUrl}
                apiKey={apiKey}
                model={clientModels.openclaw || defaultModel}
                models={integrationModels}
                showPreview
                onModelChange={(m) =>
                  setClientModels((p) => ({ ...p, openclaw: m }))
                }
                onApply={handleApplyClient}
                onRestore={handleRestoreClient}
              />
            ))}
        </TabsContent>

        {/* ── Kilo Tab ────────────────────────────────────────── */}
        <TabsContent value="kilo" className="space-y-6">
          {clients
            .filter((c) => c.id === "kilo")
            .map((c) => (
              <ClientCard
                key={c.id}
                client={c}
                baseUrl={baseUrl}
                apiKey={apiKey}
                model={clientModels.kilo || defaultModel}
                models={integrationModels}
                showPreview
                onModelChange={(m) => setClientModels((p) => ({ ...p, kilo: m }))}
                onApply={handleApplyClient}
                onRestore={handleRestoreClient}
              />
            ))}
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

/** Inline copyable code row — copy-with-feedback, same pattern as JsonBlock. */
function CodeRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable (non-https / permissions) */
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-[var(--muted-foreground)]">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-[var(--foreground)]">
          {value}
        </pre>
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

