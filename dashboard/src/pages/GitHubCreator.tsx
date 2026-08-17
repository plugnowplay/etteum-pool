import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { fetchApi } from "@/lib/api";
import { Loader2, Plus, Trash2, RefreshCw, Mail, Server, Users, Send } from "lucide-react";

interface ImapServer {
  id: number;
  label: string | null;
  host: string;
  port: number;
  username: string;
  catch_all_domain: string | null;
  status: string;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
}

interface GithubAccount {
  id: number;
  email: string;
  username: string;
  status: string;
  imap_server_id: number | null;
  proxy_id: number | null;
  verification_code: string | null;
  error_message: string | null;
  imapLabel: string | null;
  proxyUrl: string | null;
  created_at: string;
}

type Tab = "imap" | "bulk" | "accounts";

export default function GitHubCreator() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("imap");
  const [imapServers, setImapServers] = useState<ImapServer[]>([]);
  const [accounts, setAccounts] = useState<GithubAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [imapRes, accRes] = await Promise.all([
        fetchApi<{ data: ImapServer[] }>("/api/github-creator/imap"),
        fetchApi<{ data: GithubAccount[] }>("/api/github-creator/accounts"),
      ]);
      setImapServers(imapRes.data || []);
      setAccounts(accRes.data || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  // ── IMAP form state ──
  const [imapForm, setImapForm] = useState({
    label: "", host: "", port: "993", username: "", password: "", catch_all_domain: "",
  });
  const [showImapForm, setShowImapForm] = useState(false);

  async function handleAddImap() {
    if (!imapForm.host || !imapForm.username || !imapForm.password) {
      toast.warning("Host, username, and password are required");
      return;
    }
    setBusy(b => ({ ...b, addImap: true }));
    try {
      await fetchApi("/api/github-creator/imap", {
        method: "POST",
        body: JSON.stringify({
          ...imapForm,
          port: Number(imapForm.port) || 993,
        }),
      });
      toast.success("IMAP server added");
      setImapForm({ label: "", host: "", port: "993", username: "", password: "", catch_all_domain: "" });
      setShowImapForm(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setBusy(b => ({ ...b, addImap: false }));
    }
  }

  async function handleTestImap(id: number) {
    setBusy(b => ({ ...b, [`test-${id}`]: true }));
    try {
      const res = await fetchApi<{ ok: boolean; messages?: number; error?: string }>(
        `/api/github-creator/imap/${id}/test`, { method: "POST" }
      );
      if (res.ok) toast.success(`IMAP OK — ${res.messages ?? 0} messages in INBOX`);
      else toast.error(res.error || "IMAP test failed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(b => ({ ...b, [`test-${id}`]: false }));
    }
  }

  async function handleDeleteImap(id: number) {
    if (!confirm("Delete this IMAP server?")) return;
    try {
      await fetchApi(`/api/github-creator/imap/${id}`, { method: "DELETE" });
      toast.success("IMAP server deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  // ── Bulk create state ──
  const [bulkForm, setBulkForm] = useState({
    imap_server_id: "", count: "5", username_prefix: "user", password: "",
  });

  async function handleBulkCreate() {
    if (!bulkForm.imap_server_id || !bulkForm.count || !bulkForm.username_prefix) {
      toast.warning("Select IMAP server, count, and username prefix");
      return;
    }
    setBusy(b => ({ ...b, bulk: true }));
    try {
      const res = await fetchApi<{ created: number; emails: string[] }>(
        "/api/github-creator/accounts",
        { method: "POST", body: JSON.stringify({
          imap_server_id: Number(bulkForm.imap_server_id),
          count: Number(bulkForm.count),
          username_prefix: bulkForm.username_prefix,
          password: bulkForm.password || undefined,
        })}
      );
      toast.success(`${res.created} accounts created`);
      setBulkForm(f => ({ ...f, count: "5", password: "" }));
      setTab("accounts");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk create failed");
    } finally {
      setBusy(b => ({ ...b, bulk: false }));
    }
  }

  async function handleRegister(id: number) {
    setBusy(b => ({ ...b, [`reg-${id}`]: true }));
    try {
      const res = await fetchApi<{ success: boolean; status: string; error?: string; verification_code?: string }>(
        `/api/github-creator/accounts/${id}/register`, { method: "POST" }
      );
      if (res.success) toast.success(`Account registered (code: ${res.verification_code || "n/a"})`);
      else toast.error(res.error || "Registration failed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(b => ({ ...b, [`reg-${id}`]: false }));
    }
  }

  async function handleRetry(id: number) {
    setBusy(b => ({ ...b, [`retry-${id}`]: true }));
    try {
      const res = await fetchApi<{ success: boolean; error?: string }>(
        `/api/github-creator/accounts/${id}/retry`, { method: "POST" }
      );
      if (res.success) toast.success("Retry successful");
      else toast.error(res.error || "Retry failed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(b => ({ ...b, [`retry-${id}`]: false }));
    }
  }

  async function handleDeleteAccount(id: number) {
    if (!confirm("Delete this account?")) return;
    try {
      await fetchApi(`/api/github-creator/accounts/${id}`, { method: "DELETE" });
      toast.success("Account deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function statusBadge(status: string) {
    const map: Record<string, { variant: "default" | "success" | "warning" | "error" | "info" }> = {
      pending: { variant: "warning" },
      registered: { variant: "info" },
      verified: { variant: "success" },
      error: { variant: "error" },
    };
    const v = map[status] || { variant: "default" as const };
    return <Badge variant={v.variant}>{status.toUpperCase()}</Badge>;
  }

  const inputCls = "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";
  const labelCls = "text-xs font-medium text-[var(--muted-foreground)]";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--foreground)]">GitHub Creator</h1>
          <p className="text-sm text-[var(--muted-foreground)]">Auto-register GitHub accounts with IMAP catch-all + proxy rotation</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span className="ml-2">Refresh</span>
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
        <button onClick={() => setTab("imap")}
          className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${tab === "imap" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Server className="w-3.5 h-3.5" /> IMAP Servers
        </button>
        <button onClick={() => setTab("bulk")}
          className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${tab === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Plus className="w-3.5 h-3.5" /> Bulk Create
        </button>
        <button onClick={() => setTab("accounts")}
          className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${tab === "accounts" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Users className="w-3.5 h-3.5" /> Accounts ({accounts.length})
        </button>
      </div>

      {/* ── IMAP Tab ── */}
      {tab === "imap" && (
        <div className="space-y-4">
          {!showImapForm ? (
            <Button onClick={() => setShowImapForm(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add IMAP Server
            </Button>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
              <h3 className="text-sm font-semibold">New IMAP Server</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Label</label>
                  <input className={inputCls} value={imapForm.label} onChange={e => setImapForm(f => ({ ...f, label: e.target.value }))} placeholder="catch-all domain1.com" />
                </div>
                <div>
                  <label className={labelCls}>Host *</label>
                  <input className={inputCls} value={imapForm.host} onChange={e => setImapForm(f => ({ ...f, host: e.target.value }))} placeholder="imap.gmail.com" />
                </div>
                <div>
                  <label className={labelCls}>Port</label>
                  <input className={inputCls} type="number" value={imapForm.port} onChange={e => setImapForm(f => ({ ...f, port: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Catch-all Domain</label>
                  <input className={inputCls} value={imapForm.catch_all_domain} onChange={e => setImapForm(f => ({ ...f, catch_all_domain: e.target.value }))} placeholder="domain1.com" />
                </div>
                <div>
                  <label className={labelCls}>Username *</label>
                  <input className={inputCls} value={imapForm.username} onChange={e => setImapForm(f => ({ ...f, username: e.target.value }))} placeholder="user@domain1.com" />
                </div>
                <div>
                  <label className={labelCls}>Password *</label>
                  <input className={inputCls} type="password" value={imapForm.password} onChange={e => setImapForm(f => ({ ...f, password: e.target.value }))} placeholder="••••••••" />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowImapForm(false)}>Cancel</Button>
                <Button onClick={handleAddImap} disabled={busy.addImap}>
                  {busy.addImap ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Add Server
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Label</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Host</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Port</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Username</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Domain</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Status</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-[var(--muted-foreground)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {imapServers.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--muted-foreground)]">No IMAP servers yet</td></tr>
                ) : imapServers.map(s => (
                  <tr key={s.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2 text-[var(--foreground)]">{s.label || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--foreground)]">{s.host}</td>
                    <td className="px-3 py-2 text-[var(--muted-foreground)]">{s.port}</td>
                    <td className="px-3 py-2 text-[var(--muted-foreground)]">{s.username}</td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--foreground)]">{s.catch_all_domain || "—"}</td>
                    <td className="px-3 py-2">
                      {s.last_test_ok === true && <Badge variant="success">OK</Badge>}
                      {s.last_test_ok === false && <Badge variant="error">FAIL</Badge>}
                      {s.last_test_ok === null && <Badge variant="default">UNTESTED</Badge>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => handleTestImap(s.id)} disabled={busy[`test-${s.id}`]}>
                          {busy[`test-${s.id}`] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteImap(s.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Bulk Create Tab ── */}
      {tab === "bulk" && (
        <div className="max-w-lg rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-4">
          <h3 className="text-sm font-semibold">Bulk Create GitHub Accounts</h3>
          <p className="text-xs text-[var(--muted-foreground)]">
            Generates <code className="text-[var(--foreground)]">prefix+001@domain</code>, <code className="text-[var(--foreground)]">prefix+002@domain</code>, etc.
            Each gets a random username and password.
          </p>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>IMAP Server</label>
              <select className={inputCls} value={bulkForm.imap_server_id} onChange={e => setBulkForm(f => ({ ...f, imap_server_id: e.target.value }))}>
                <option value="">Select IMAP server…</option>
                {imapServers.map(s => (
                  <option key={s.id} value={s.id}>{s.label || s.host} ({s.catch_all_domain || "no domain"})</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Count</label>
                <input className={inputCls} type="number" min="1" max="100" value={bulkForm.count} onChange={e => setBulkForm(f => ({ ...f, count: e.target.value }))} />
              </div>
              <div>
                <label className={labelCls}>Username Prefix</label>
                <input className={inputCls} value={bulkForm.username_prefix} onChange={e => setBulkForm(f => ({ ...f, username_prefix: e.target.value }))} placeholder="user" />
              </div>
            </div>
            <div>
              <label className={labelCls}>Password (optional — auto-generate if empty)</label>
              <input className={inputCls} type="password" value={bulkForm.password} onChange={e => setBulkForm(f => ({ ...f, password: e.target.value }))} placeholder="Auto-generate" />
            </div>
          </div>
          <Button onClick={handleBulkCreate} disabled={busy.bulk} className="w-full">
            {busy.bulk ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            Create Accounts
          </Button>
        </div>
      )}

      {/* ── Accounts Tab ── */}
      {tab === "accounts" && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Email</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Username</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Status</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Code</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Proxy</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Error</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-[var(--muted-foreground)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--muted-foreground)]">No accounts yet — use Bulk Create tab</td></tr>
              ) : accounts.map(a => (
                <tr key={a.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-[var(--foreground)]">{a.email}</td>
                  <td className="px-3 py-2 text-[var(--muted-foreground)]">{a.username}</td>
                  <td className="px-3 py-2">{statusBadge(a.status)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--foreground)]">{a.verification_code || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--muted-foreground)]">
                    {a.proxyUrl ? a.proxyUrl.match(/@([^:/]+)/)?.[1] || a.proxyUrl.slice(0, 20) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--error)] max-w-[200px] truncate" title={a.error_message || ""}>
                    {a.error_message || "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {a.status !== "verified" && (
                        <Button variant="ghost" size="sm" onClick={() => handleRegister(a.id)} disabled={busy[`reg-${a.id}`]}>
                          {busy[`reg-${a.id}`] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </Button>
                      )}
                      {a.status === "error" && (
                        <Button variant="ghost" size="sm" onClick={() => handleRetry(a.id)} disabled={busy[`retry-${a.id}`]}>
                          {busy[`retry-${a.id}`] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteAccount(a.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
