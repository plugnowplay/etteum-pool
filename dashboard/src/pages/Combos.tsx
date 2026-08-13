import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";
import { Plus, Trash2, Save } from "lucide-react";

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
  const [error, setError] = useState("");

  async function load() {
    const [comboData, modelData] = await Promise.all([
      fetchApi<{ combos: Combo[] }>("/api/combos"),
      fetchApi<{ data: Model[] }>("/v1/models"),
    ]);
    setCombos(comboData.combos || []);
    setModels((modelData.data || []).filter((model) => !model.id.startsWith("combo:")));
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const modelOptions = useMemo(() => models.map((model) => model.id), [models]);
  const updateSelected = (patch: Partial<Combo>) => setSelected((current) => current ? { ...current, ...patch } : current);

  async function save() {
    if (!selected) return;
    setSaving(true); setError("");
    try {
      const result = await fetchApi<{ combo: Combo }>("/api/combos", { method: "PUT", body: JSON.stringify(selected) });
      setCombos((current) => [...current.filter((combo) => combo.name !== result.combo.name), result.combo].sort((a, b) => a.name.localeCompare(b.name)));
      setSelected(result.combo);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function remove(name: string) {
    await fetchApi(`/api/combos/${encodeURIComponent(name)}`, { method: "DELETE" });
    setCombos((current) => current.filter((combo) => combo.name !== name));
    if (selected?.name === name) setSelected(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-[var(--foreground)]">Model Combos</h1><p className="text-sm text-[var(--muted-foreground)] mt-1">Group models under one virtual model with fallback, rotation, fusion, or capacity routing.</p></div>
        <Button onClick={() => setSelected({ name: "", strategy: "fallback", models: [""], judgeModel: "" })}><Plus className="w-4 h-4 mr-2" /> New Combo</Button>
      </div>
      {error && <div className="rounded-md bg-red-500/10 text-red-400 px-4 py-2 text-sm">{error}</div>}
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card><CardHeader><CardTitle className="text-base">Saved combos</CardTitle></CardHeader><CardContent className="space-y-2">
          {combos.map((combo) => <div key={combo.name} className="flex items-center gap-2"><button onClick={() => setSelected({ ...combo, models: [...combo.models] })} className={`flex-1 text-left rounded px-3 py-2 text-sm ${selected?.name === combo.name ? "bg-[var(--primary)]/15 text-[var(--primary)]" : "hover:bg-[var(--secondary)] text-[var(--foreground)]"}`}><div className="font-medium">combo:{combo.name}</div><div className="text-xs text-[var(--muted-foreground)]">{combo.strategy} · {combo.models.length} models</div></button><button title="Delete combo" onClick={() => remove(combo.name)} className="p-2 text-[var(--muted-foreground)] hover:text-red-400"><Trash2 className="w-4 h-4" /></button></div>)}
          {combos.length === 0 && <p className="text-sm text-[var(--muted-foreground)]">No combos yet.</p>}
        </CardContent></Card>
        {selected ? <Card><CardHeader><CardTitle className="text-base">Combo editor</CardTitle></CardHeader><CardContent className="space-y-5">
          <div><label className="text-sm text-[var(--foreground)]">Name</label><div className="flex items-center gap-2 mt-1"><span className="text-sm text-[var(--muted-foreground)]">combo:</span><input value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} placeholder="smart" className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]" /></div></div>
          <div><label className="text-sm text-[var(--foreground)]">Strategy</label><div className="grid gap-2 sm:grid-cols-2 mt-2">{strategies.map((strategy) => <button key={strategy.id} onClick={() => updateSelected({ strategy: strategy.id })} className={`text-left rounded-md border p-3 ${selected.strategy === strategy.id ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-[var(--border)] hover:bg-[var(--secondary)]"}`}><div className="text-sm font-medium text-[var(--foreground)]">{strategy.title}</div><div className="text-xs text-[var(--muted-foreground)] mt-1">{strategy.description}</div></button>)}</div></div>
          <div><label className="text-sm text-[var(--foreground)]">Panel models</label><div className="space-y-2 mt-2">{selected.models.map((model, index) => <div key={`${index}-${model}`} className="flex gap-2"><select value={model} onChange={(e) => { const next = [...selected.models]; next[index] = e.target.value; updateSelected({ models: next }); }} className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"><option value="">Select model...</option>{modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select><Button variant="outline" onClick={() => updateSelected({ models: selected.models.filter((_, i) => i !== index) })}><Trash2 className="w-4 h-4" /></Button></div>)}<Button variant="outline" onClick={() => updateSelected({ models: [...selected.models, ""] })}><Plus className="w-4 h-4 mr-2" /> Add model</Button></div></div>
          {selected.strategy === "fusion" && <div><label className="text-sm text-[var(--foreground)]">Judge model</label><select value={selected.judgeModel || ""} onChange={(e) => updateSelected({ judgeModel: e.target.value })} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"><option value="">Select judge...</option>{modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select><p className="text-xs text-amber-400 mt-1">Fusion bills every panel model plus judge: N+1 upstream calls.</p></div>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button><Button onClick={save} disabled={saving}><Save className="w-4 h-4 mr-2" />{saving ? "Saving..." : "Save combo"}</Button></div>
        </CardContent></Card> : <Card><CardContent className="py-16 text-center text-sm text-[var(--muted-foreground)]">Select combo or create new.</CardContent></Card>}
      </div>
    </div>
  );
}
