import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import {
  Copy, Eye, EyeOff, RefreshCw, Check, Save, ShieldCheck, Plus, Trash2, KeyRound, RotateCcw, Pencil,
} from "lucide-react";
import {
  fetchApiKey, regenerateApiKey, setApiKey, testApiKey,
  fetchManagedKeys, createManagedKey, updateManagedKey, deleteManagedKey, resetManagedKeyUsage,
  type ManagedKeyDTO,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useTimedMessage } from "@/hooks/useTimedMessage";

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ApiKey() {
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("api_key") || "");
  const [source, setSource] = useState("browser");
  const [showKey, setShowKey] = useState(false);
  const { message: copied, setMessage: setCopiedTimed } = useTimedMessage<boolean>(null, 2000);
  const [valid, setValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"load" | "test" | "regen" | "save" | null>(null);

  // Managed keys
  const [managedKeys, setManagedKeys] = useState<ManagedKeyDTO[]>([]);
  const [keysBusy, setKeysBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ManagedKeyDTO | null>(null);
  const [form, setForm] = useState({ name: "", key: "", modelWhitelist: "", rpmLimit: "", tokenLimit: "" });

  const toast = useToast();

  function notify(text: string) { toast.success(text); }
  function fail(err: unknown) { toast.error(err instanceof Error ? err.message : String(err)); }

  function saveToBrowser(key = apiKey) {
    localStorage.setItem("api_key", key);
    setApiKeyState(key);
  }

  async function loadKey() {
    setBusy("load");
    try {
      const res = await fetchApiKey() as { key: string; source: string };
      setApiKeyState(res.key);
      setSource(res.source);
      saveToBrowser(res.key);
      setValid(true);
    } catch (err) { fail(err); } finally { setBusy(null); }
  }

  const loadManagedKeys = useCallback(async () => {
    setKeysBusy(true);
    try {
      const res = await fetchManagedKeys();
      setManagedKeys(res.keys);
    } catch (err) { fail(err); } finally { setKeysBusy(false); }
  }, []);

  useEffect(() => {
    loadKey();
    loadManagedKeys();
  }, [loadManagedKeys]);

  const handleCopy = () => {
    copyText(apiKey).then(() => setCopiedTimed(true));
  };

  async function handleSave() {
    setBusy("save");
    try {
      const res = await setApiKey(apiKey) as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("API key saved to backend and browser.");
    } catch (err) { fail(err); } finally { setBusy(null); }
  }

  async function handleRegenerate() {
    if (!confirm("Regenerate master API key? Existing generated key will stop working.")) return;
    setBusy("regen");
    try {
      const res = await regenerateApiKey() as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("New master key generated, saved, and activated.");
    } catch (err) { fail(err); } finally { setBusy(null); }
  }

  async function handleTest() {
    setBusy("test");
    try {
      const res = await testApiKey(apiKey) as { valid: boolean };
      setValid(res.valid);
      notify(res.valid ? "API key is valid." : "API key is invalid.");
    } catch (err) { fail(err); } finally { setBusy(null); }
  }

  function openAdd() {
    setEditing(null);
    setForm({ name: "", key: "", modelWhitelist: "", rpmLimit: "", tokenLimit: "" });
    setShowAdd(true);
  }

  function openEdit(k: ManagedKeyDTO) {
    setEditing(k);
    setForm({
      name: k.name,
      key: k.key,
      modelWhitelist: k.modelWhitelist,
      rpmLimit: k.rpmLimit ? String(k.rpmLimit) : "",
      tokenLimit: k.tokenLimit ? String(k.tokenLimit) : "",
    });
    setShowAdd(true);
  }

  async function handleSubmitKey() {
    const payload = {
      name: form.name,
      modelWhitelist: form.modelWhitelist,
      rpmLimit: form.rpmLimit ? Number(form.rpmLimit) : 0,
      tokenLimit: form.tokenLimit ? Number(form.tokenLimit) : 0,
    };
    try {
      if (editing) {
        await updateManagedKey(editing.id, payload);
        notify("Key updated.");
      } else {
        const res = await createManagedKey({ ...payload, key: form.key || undefined });
        notify(`Key created: ${res.key.slice(0, 16)}…`);
      }
      setShowAdd(false);
      await loadManagedKeys();
    } catch (err) { fail(err); }
  }

  async function handleToggleKey(k: ManagedKeyDTO) {
    try {
      await updateManagedKey(k.id, { enabled: !k.enabled });
      await loadManagedKeys();
    } catch (err) { fail(err); }
  }

  async function handleDeleteKey(k: ManagedKeyDTO) {
    if (!confirm(`Delete key "${k.name || k.key.slice(0, 12)}…"? This cannot be undone.`)) return;
    try {
      await deleteManagedKey(k.id);
      notify("Key deleted.");
      await loadManagedKeys();
    } catch (err) { fail(err); }
  }

  async function handleResetUsage(k: ManagedKeyDTO) {
    if (!confirm(`Reset token usage for "${k.name || k.key.slice(0, 12)}…" to 0?`)) return;
    try {
      await resetManagedKeyUsage(k.id);
      notify("Usage reset.");
      await loadManagedKeys();
    } catch (err) { fail(err); }
  }

  return (
    <PageShell>
      <PageHeader
        title="API Keys"
        description="Master key + managed keys with per-key limits."
        badge={
          <Badge variant={valid === true ? "success" : valid === false ? "error" : "muted"} dot>
            {valid === true ? "master valid" : valid === false ? "invalid" : "not tested"}
          </Badge>
        }
      />

      {/* Master key */}
      <Card className="max-w-3xl border-[var(--border)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> Master Key
          </CardTitle>
          <CardDescription>
            Source: <span className="font-mono">{source}</span>. Master key bypasses all limits.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Key" htmlFor="api-key-input" hint="Stored in this browser and pushed to the backend on save.">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="api-key-input"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => { setApiKeyState(e.target.value); setValid(null); }}
                  className="pr-10 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button variant="outline" size="icon" onClick={handleCopy} aria-label="Copy API key" title="Copy">
                {copied ? <Check className="h-4 w-4 text-[var(--success)]" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </Field>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={loadKey} loading={busy === "load"}>Load Active</Button>
            <Button variant="outline" size="sm" onClick={handleTest} loading={busy === "test"}>Test</Button>
            <Button variant="outline" size="sm" onClick={handleRegenerate} loading={busy === "regen"}>
              {busy !== "regen" && <RefreshCw className="h-4 w-4" />} Generate
            </Button>
            <Button size="sm" onClick={handleSave} loading={busy === "save"}>
              {busy !== "save" && <Save className="h-4 w-4" />} Save &amp; Activate
            </Button>
          </div>

          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <h4 className="mb-2 text-sm font-medium text-[var(--foreground)]">Usage Example</h4>
            <pre className="overflow-x-auto rounded-md bg-[var(--surface-inset)] p-3 text-xs leading-relaxed text-[var(--muted-foreground)]">
{`curl https://etteum.miotcore.com/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Managed keys */}
      <Card className="max-w-5xl border-[var(--border)]">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" /> Managed Keys
            </CardTitle>
            <CardDescription>
              Create keys with model whitelist, RPM and token limits.
            </CardDescription>
          </div>
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-4 w-4" /> Add Key
          </Button>
        </CardHeader>
        <CardContent>
          {keysBusy && managedKeys.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--muted-foreground)]">Loading…</p>
          ) : managedKeys.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--muted-foreground)]">
              No managed keys yet. Click "Add Key" to create one.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
                    <th className="px-2 py-2">Name</th>
                    <th className="px-2 py-2">Key</th>
                    <th className="px-2 py-2">Models</th>
                    <th className="px-2 py-2">RPM</th>
                    <th className="px-2 py-2">Tokens</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {managedKeys.map((k) => {
                    const pct = k.tokenLimit > 0 ? Math.min(100, (k.tokensUsed / k.tokenLimit) * 100) : 0;
                    const exhausted = k.tokenLimit > 0 && k.tokensUsed >= k.tokenLimit;
                    return (
                      <tr key={k.id} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-2 py-2 font-medium">{k.name || "—"}</td>
                        <td className="px-2 py-2 font-mono text-xs">
                          <span className="inline-flex items-center gap-1">
                            {k.key.slice(0, 18)}…
                            <button
                              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                              onClick={() => copyText(k.key).then(() => notify("Copied"))}
                              aria-label="Copy key"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </span>
                        </td>
                        <td className="px-2 py-2 text-xs">
                          {k.modelWhitelist ? (
                            <div className="flex max-w-[220px] flex-wrap gap-1">
                              {k.modelWhitelist.split(",").map((m) => (
                                <span key={m} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11px]">
                                  {m.trim()}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--muted-foreground)]">all</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-xs">{k.rpmLimit > 0 ? k.rpmLimit : "∞"}</td>
                        <td className="px-2 py-2">
                          <div className="text-xs">
                            <span className={exhausted ? "text-[var(--danger)]" : ""}>
                              {formatTokens(k.tokensUsed)}
                            </span>
                            {k.tokenLimit > 0 && (
                              <span className="text-[var(--muted-foreground)]"> / {formatTokens(k.tokenLimit)}</span>
                            )}
                          </div>
                          {k.tokenLimit > 0 && (
                            <div className="mt-1 h-1 w-24 overflow-hidden rounded bg-[var(--surface-2)]">
                              <div
                                className={`h-full ${exhausted ? "bg-[var(--danger)]" : "bg-[var(--primary)]"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant={k.enabled ? (exhausted ? "warning" : "success") : "muted"} dot>
                            {!k.enabled ? "disabled" : exhausted ? "exhausted" : "active"}
                          </Badge>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" size="icon" title="Edit" aria-label="Edit" onClick={() => openEdit(k)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline" size="icon" title={k.enabled ? "Disable" : "Enable"} aria-label="Toggle"
                              onClick={() => handleToggleKey(k)}
                            >
                              <EyeOff className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline" size="icon" title="Reset usage" aria-label="Reset usage"
                              onClick={() => handleResetUsage(k)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline" size="icon" title="Delete" aria-label="Delete"
                              className="text-[var(--danger)] hover:text-[var(--danger)]"
                              onClick={() => handleDeleteKey(k)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowAdd(false)}>
          <div
            className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-base font-semibold">{editing ? "Edit Key" : "Add Key"}</h3>
            <p className="mb-4 text-xs text-[var(--muted-foreground)]">
              {editing ? `Editing key ${editing.key.slice(0, 16)}…` : "Key will be auto-generated if left blank."}
            </p>

            <div className="space-y-3">
              <Field label="Name" htmlFor="mk-name">
                <Input id="mk-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. team-b, prod-bot" />
              </Field>

              {!editing && (
                <Field label="Key (optional)" htmlFor="mk-key" hint="Min 16 chars. Blank = auto-generate.">
                  <Input id="mk-key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="sk-miot-…" className="font-mono text-sm" />
                </Field>
              )}

              <Field label="Model whitelist" htmlFor="mk-models" hint="Comma-separated model names. Empty = all models allowed.">
                <Input id="mk-models" value={form.modelWhitelist} onChange={(e) => setForm({ ...form, modelWhitelist: e.target.value })} placeholder="glm-5.3, claude-sonnet-4, gpt-4o" className="font-mono text-sm" />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="RPM limit" htmlFor="mk-rpm" hint="Requests per minute. 0 = unlimited.">
                  <Input id="mk-rpm" type="number" min={0} value={form.rpmLimit} onChange={(e) => setForm({ ...form, rpmLimit: e.target.value })} placeholder="60" />
                </Field>
                <Field label="Token limit" htmlFor="mk-tokens" hint="Lifetime token cap. 0 = unlimited.">
                  <Input id="mk-tokens" type="number" min={0} value={form.tokenLimit} onChange={(e) => setForm({ ...form, tokenLimit: e.target.value })} placeholder="100000000" />
                </Field>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSubmitKey}>{editing ? "Save Changes" : "Create Key"}</Button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
