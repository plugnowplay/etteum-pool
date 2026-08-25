import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { fetchApi } from "@/lib/api";
import { Layers, Plus, Trash2, Save, ArrowUp, ArrowDown } from "lucide-react";

type Strategy = "fallback" | "round_robin" | "fusion" | "capacity_auto_switch";
type Combo = { name: string; strategy: Strategy; models: string[]; judgeModel?: string | null };
type Model = { id: string; owned_by: string };

const strategies: Array<{ id: Strategy; title: string; description: string }> = [
  { id: "fallback", title: "Fallback", description: "Tries models in order; next on failure." },
  { id: "round_robin", title: "Round Robin", description: "Rotates models across requests." },
  { id: "fusion", title: "Fusion", description: "All panel models in parallel, then judge synthesizes. N+1 calls." },
  { id: "capacity_auto_switch", title: "Capacity auto-switch", description: "Prefers model supporting image, PDF, or audio input." },
];

export default function Combos() {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState<Combo | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function load() {
    const [comboData, modelData] = await Promise.all([
      fetchApi<{ combos: Combo[] }>("/api/combos"),
      fetchApi<{ data: Model[] }>("/v1/models"),
    ]);
    setCombos(comboData.combos || []);
    setModels((modelData.data || []).filter((model) => !model.id.startsWith("combo:")));
  }

  useEffect(() => { load().catch((e) => toast.error(e.message)); }, []);

  const modelOptions = useMemo(() => models.map((model) => model.id), [models]);
  const updateSelected = (patch: Partial<Combo>) => setSelected((current) => current ? { ...current, ...patch } : current);

  function moveModel(index: number, dir: -1 | 1) {
    setSelected((current) => {
      if (!current) return current;
      const target = index + dir;
      if (target < 0 || target >= current.models.length) return current;
      const next = [...current.models];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, models: next };
    });
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await fetchApi<{ combo: Combo }>("/api/combos", { method: "PUT", body: JSON.stringify(selected) });
      setCombos((current) => [...current.filter((combo) => combo.name !== result.combo.name), result.combo].sort((a, b) => a.name.localeCompare(b.name)));
      setSelected(result.combo);
      toast.success(`Saved combo:${result.combo.name}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function remove(name: string) {
    await fetchApi(`/api/combos/${encodeURIComponent(name)}`, { method: "DELETE" });
    setCombos((current) => current.filter((combo) => combo.name !== name));
    if (selected?.name === name) setSelected(null);
  }

  return (
    <PageShell>
      <PageHeader
        title="Model Combos"
        description="Group models under one virtual model with fallback, rotation, fusion, or capacity routing."
        actions={
          <Button onClick={() => setSelected({ name: "", strategy: "fallback", models: [""], judgeModel: "" })}>
            <Plus className="h-4 w-4" /> New Combo
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Saved combos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {combos.map((combo) => (
              <div key={combo.name} className="flex items-center gap-2">
                <button
                  onClick={() => setSelected({ ...combo, models: [...combo.models] })}
                  className={`focus-ring min-h-[44px] flex-1 rounded px-3 py-2 text-left text-sm transition-colors duration-[var(--dur-fast)] md:min-h-0 ${
                    selected?.name === combo.name
                      ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "text-[var(--foreground)] hover:bg-[var(--secondary)]"
                  }`}
                >
                  <div className="font-medium">combo:{combo.name}</div>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    {combo.strategy} · <span className="tabular">{combo.models.length}</span> models
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete combo ${combo.name}`}
                  title="Delete combo"
                  onClick={() => remove(combo.name)}
                  className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {combos.length === 0 && (
              <EmptyState
                compact
                icon={Layers}
                title="No combos yet"
                description="Create a combo to route one virtual model across several upstreams."
              />
            )}
          </CardContent>
        </Card>

        {selected ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Combo editor</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <Field label="Name" htmlFor="combo-name" hint="Exposed upstream as combo:<name>.">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--muted-foreground)]">combo:</span>
                  <Input
                    id="combo-name"
                    value={selected.name}
                    onChange={(e) => updateSelected({ name: e.target.value })}
                    placeholder="smart"
                    className="flex-1"
                  />
                </div>
              </Field>

              <Field label="Strategy">
                <div className="grid gap-2 sm:grid-cols-2">
                  {strategies.map((strategy) => (
                    <button
                      key={strategy.id}
                      onClick={() => updateSelected({ strategy: strategy.id })}
                      className={`focus-ring rounded-md border p-3 text-left transition-colors duration-[var(--dur-fast)] ${
                        selected.strategy === strategy.id
                          ? "border-[var(--primary)] bg-[var(--primary)]/10"
                          : "border-[var(--border)] hover:bg-[var(--secondary)]"
                      }`}
                    >
                      <div className="text-sm font-medium text-[var(--foreground)]">{strategy.title}</div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">{strategy.description}</div>
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Panel models">
                <div className="space-y-2">
                  {selected.models.map((model, index) => (
                    <div key={`${index}-${model}`} className="flex gap-2">
                      <Select
                        value={model}
                        aria-label={`Panel model ${index + 1}`}
                        onChange={(e) => {
                          const next = [...selected.models];
                          next[index] = e.target.value;
                          updateSelected({ models: next });
                        }}
                        className="flex-1"
                      >
                        <option value="">Select model...</option>
                        {modelOptions.map((id) => (
                          <option key={id} value={id}>{id}</option>
                        ))}
                      </Select>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Move panel model ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => moveModel(index, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Move panel model ${index + 1} down`}
                        disabled={index === selected.models.length - 1}
                        onClick={() => moveModel(index, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Remove panel model ${index + 1}`}
                        onClick={() => updateSelected({ models: selected.models.filter((_, i) => i !== index) })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" onClick={() => updateSelected({ models: [...selected.models, ""] })}>
                    <Plus className="h-4 w-4" /> Add model
                  </Button>
                </div>
              </Field>

              {selected.strategy === "fusion" && (
                <Field
                  label="Judge model"
                  hint="Fusion bills every panel model plus judge: N+1 upstream calls."
                >
                  <Select
                    value={selected.judgeModel || ""}
                    aria-label="Judge model"
                    onChange={(e) => updateSelected({ judgeModel: e.target.value })}
                  >
                    <option value="">Select judge...</option>
                    {modelOptions.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </Select>
                </Field>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
                <Button onClick={save} loading={saving}>
                  {!saving && <Save className="h-4 w-4" />} Save combo
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-8">
              <EmptyState
                icon={Layers}
                title="No combo selected"
                description="Pick a saved combo on the left, or create a new one."
              />
            </CardContent>
          </Card>
        )}
      </div>
    </PageShell>
  );
}
