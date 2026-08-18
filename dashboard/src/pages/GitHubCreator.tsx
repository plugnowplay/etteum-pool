import { Fragment, useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useWsEvent } from "@/hooks/useWebSocket";
import { fetchApi } from "@/lib/api";
import { Loader2, Plus, Trash2, RefreshCw, Mail, Server, Users, Send, Terminal, Trash } from "lucide-react";

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

type Tab = "imap" | "bulk" | "accounts" | "logs";

export default function GitHubCreator() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("imap");
  const [imapServers, setImapServers] = useState<ImapServer[]>([]);
  const [accounts, setAccounts] = useState<GithubAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [progressLogs, setProgressLogs] = useState<Record<number, { step: string; detail?: string; ts: string }[]>>({});

  // Global live log feed — all accounts, newest at bottom, auto-scroll
  const [liveLogs, setLiveLogs] = useState<{ id: number; email: string; step: string; detail?: string; ts: string }[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const MAX_LIVE_LOGS = 200;

  // ── WebSocket: listen for progress + account updates ──
  useWsEvent("github_creator.progress", (msg: any) => {
    const d = msg.data;
    if (!d?.id) return;
    // Append to per-account logs
    setProgressLogs(prev => {
      const logs = prev[d.id] || [];
      return { ...prev, [d.id]: [...logs, { step: d.step, detail: d.detail, ts: d.ts }] };
    });
    // Append to global live feed
    setLiveLogs(prev => {
      const next = [...prev, { id: d.id, email: d.email || "", step: d.step, detail: d.detail, ts: d.ts }];
      return next.length > MAX_LIVE_LOGS ? next.slice(-MAX_LIVE_LOGS) : next;
    });
  });

  useWsEvent(["github_creator.account_updated", "github_creator.imap_created", "github_creator.imap_updated", "github_creator.imap_deleted", "github_creator.account_deleted"], () => {
    // Reload data on any account/imap change
    void load();
  });

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (tab === "logs" && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [liveLogs, tab]);

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
    imap_server_id: "", count: "5", password: "",
  });

  async function handleBulkCreate() {
    if (!bulkForm.imap_server_id || !bulkForm.count) {
      toast.warning("Select IMAP server and count");
      return;
    }
    setBusy(b => ({ ...b, bulk: true }));
    try {
      const res = await fetchApi<{ created: number; emails: string[] }>(
        "/api/github-creator/accounts",
        { method: "POST", body: JSON.stringify({
          imap_server_id: Number(bulkForm.imap_server_id),
          count: Number(bulkForm.count),
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
    <div className="space-y-4 md:space-y-6">
      {/* ── Header: stack on mobile, row on desktop ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--foreground)]">GitHub Creator</h1>
          <p className="text-sm text-[var(--muted-foreground)]">Auto-register GitHub accounts with IMAP catch-all + proxy rotation</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading} className="shrink-0 self-start sm:self-auto">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span className="ml-2">Refresh</span>
        </Button>
      </div>

      {/* ── Tabs: scrollable horizontal, no overflow ── */}
      <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <button onClick={() => setTab("imap")}
          className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${tab === "imap" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Server className="w-3.5 h-3.5" /> IMAP Servers
        </button>
        <button onClick={() => setTab("bulk")}
          className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${tab === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Plus className="w-3.5 h-3.5" /> Bulk Create
        </button>
        <button onClick={() => setTab("accounts")}
          className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${tab === "accounts" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Users className="w-3.5 h-3.5" /> Accounts ({accounts.length})
        </button>
        <button onClick={() => setTab("logs")}
          className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${tab === "logs" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>
          <Terminal className="w-3.5 h-3.5" /> Live Logs {liveLogs.length > 0 && <span className="ml-1 inline-flex items-center justify-center rounded-full bg-[var(--info)] px-1.5 py-0.5 text-[10px] font-bold text-white">{liveLogs.length}</span>}
        </button>
      </div>

      {/* ── IMAP Tab ── */}
      {tab === "imap" && (
        <div className="space-y-4">
          {!showImapForm ? (
            <Button onClick={() => setShowImapForm(true)} className="w-full sm:w-auto">
              <Plus className="w-4 h-4 mr-2" /> Add IMAP Server
            </Button>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
              <h3 className="text-sm font-semibold">New IMAP Server</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setShowImapForm(false)} className="w-full sm:w-auto">Cancel</Button>
                <Button onClick={handleAddImap} disabled={busy.addImap} className="w-full sm:w-auto">
                  {busy.addImap ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Add Server
                </Button>
              </div>
            </div>
          )}

          {/* Desktop: table | Mobile: card list — no hidden columns */}
          {imapServers.length === 0 ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
              No IMAP servers yet
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
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
                    {imapServers.map(s => (
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

              {/* Mobile card list — same data, nothing hidden */}
              <div className="md:hidden space-y-3">
                {imapServers.map(s => (
                  <div key={s.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[var(--foreground)] truncate">{s.label || s.host}</span>
                      {s.last_test_ok === true && <Badge variant="success">OK</Badge>}
                      {s.last_test_ok === false && <Badge variant="error">FAIL</Badge>}
                      {s.last_test_ok === null && <Badge variant="default">UNTESTED</Badge>}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-[var(--muted-foreground)]">Host: </span>
                        <span className="font-mono text-[var(--foreground)] break-all">{s.host}</span>
                      </div>
                      <div>
                        <span className="text-[var(--muted-foreground)]">Port: </span>
                        <span className="text-[var(--foreground)]">{s.port}</span>
                      </div>
                      <div className="col-span-2">
                        <span className="text-[var(--muted-foreground)]">Username: </span>
                        <span className="text-[var(--foreground)] break-all">{s.username}</span>
                      </div>
                      <div className="col-span-2">
                        <span className="text-[var(--muted-foreground)]">Domain: </span>
                        <span className="font-mono text-[var(--foreground)]">{s.catch_all_domain || "—"}</span>
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1 border-t border-[var(--border)]">
                      <Button variant="outline" size="sm" onClick={() => handleTestImap(s.id)} disabled={busy[`test-${s.id}`]} className="flex-1">
                        {busy[`test-${s.id}`] ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Mail className="w-3.5 h-3.5 mr-1" />}
                        Test
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleDeleteImap(s.id)} className="flex-1">
                        <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Bulk Create Tab ── */}
      {tab === "bulk" && (
        <div className="w-full sm:max-w-lg rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-4">
          <h3 className="text-sm font-semibold">Bulk Create GitHub Accounts</h3>
          <p className="text-xs text-[var(--muted-foreground)]">
            Generates human-like emails: <code className="text-[var(--foreground)]">john.smith847@domain</code>, <code className="text-[var(--foreground)]">maria.garcia312@domain</code>, etc.
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
            <div>
              <label className={labelCls}>Count</label>
              <input className={inputCls} type="number" min="1" max="100" value={bulkForm.count} onChange={e => setBulkForm(f => ({ ...f, count: e.target.value }))} />
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
        <>
          {accounts.length === 0 ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted-foreground)]">
              No accounts yet — use Bulk Create tab
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
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
                    {accounts.map(a => (
                      <Fragment key={a.id}>
                        <tr className="border-b border-[var(--border)] last:border-0">
                          <td className="px-3 py-2 font-mono text-xs text-[var(--foreground)] break-all">{a.email}</td>
                          <td className="px-3 py-2 text-[var(--muted-foreground)]">{a.username}</td>
                          <td className="px-3 py-2">{statusBadge(a.status)}</td>
                          <td className="px-3 py-2 font-mono text-xs text-[var(--foreground)]">{a.verification_code || "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs text-[var(--muted-foreground)]">
                            {a.proxyUrl ? a.proxyUrl.match(/@([^:/]+)/)?.[1] || a.proxyUrl.slice(0, 20) : "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-[var(--error)] max-w-[200px] break-words" title={a.error_message || ""}>
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
                        {progressLogs[a.id]?.length > 0 && (
                          <tr key={`${a.id}-log`} className="bg-[var(--surface-2)]">
                            <td colSpan={7} className="px-3 py-2">
                              <div className="space-y-0.5">
                                {progressLogs[a.id].map((log, i) => (
                                  <div key={i} className="text-[10px] font-mono text-[var(--muted-foreground)]">
                                    <span className="text-[var(--info)]">{new Date(log.ts).toLocaleTimeString()}</span>{" "}
                                    <span className="text-[var(--foreground)]">{log.step}</span>
                                    {log.detail && <span className="text-[var(--muted-foreground)]"> — {log.detail}</span>}
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile card list — same data, nothing hidden */}
              <div className="md:hidden space-y-3">
                {accounts.map(a => (
                  <div key={a.id} className="space-y-0">
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-[var(--foreground)] break-all">{a.email}</span>
                        {statusBadge(a.status)}
                      </div>
                      <div className="grid grid-cols-1 gap-1 text-xs">
                        <div>
                          <span className="text-[var(--muted-foreground)]">Username: </span>
                          <span className="text-[var(--foreground)]">{a.username}</span>
                        </div>
                        <div>
                          <span className="text-[var(--muted-foreground)]">Code: </span>
                          <span className="font-mono text-[var(--foreground)]">{a.verification_code || "—"}</span>
                        </div>
                        <div>
                          <span className="text-[var(--muted-foreground)]">Proxy: </span>
                          <span className="font-mono text-[var(--muted-foreground)] break-all">
                            {a.proxyUrl ? a.proxyUrl.match(/@([^:/]+)/)?.[1] || a.proxyUrl.slice(0, 20) : "—"}
                          </span>
                        </div>
                        {a.error_message && (
                          <div className="text-[var(--error)] break-words">
                            <span className="text-[var(--muted-foreground)]">Error: </span>
                            {a.error_message}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2 pt-2 border-t border-[var(--border)]">
                        {a.status !== "verified" && (
                          <Button variant="outline" size="sm" onClick={() => handleRegister(a.id)} disabled={busy[`reg-${a.id}`]} className="flex-1">
                            {busy[`reg-${a.id}`] ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                            Register
                          </Button>
                        )}
                        {a.status === "error" && (
                          <Button variant="outline" size="sm" onClick={() => handleRetry(a.id)} disabled={busy[`retry-${a.id}`]} className="flex-1">
                            {busy[`retry-${a.id}`] ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
                            Retry
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => handleDeleteAccount(a.id)} className="flex-1">
                          <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                        </Button>
                      </div>
                    </div>
                    {progressLogs[a.id]?.length > 0 && (
                      <div className="rounded-lg border border-t-0 border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-0.5">
                        {progressLogs[a.id].map((log, i) => (
                          <div key={i} className="text-[10px] font-mono text-[var(--muted-foreground)]">
                            <span className="text-[var(--info)]">{new Date(log.ts).toLocaleTimeString()}</span>{" "}
                            <span className="text-[var(--foreground)]">{log.step}</span>
                            {log.detail && <span className="text-[var(--muted-foreground)]"> — {log.detail}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ── Live Logs Tab ── */}
      {tab === "logs" && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          {/* Header bar with clear button */}
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[var(--info)]" />
              <span className="text-xs font-semibold text-[var(--foreground)]">Live Progress Logs</span>
              <span className="text-[10px] text-[var(--muted-foreground)]">({liveLogs.length} entries, real-time via WebSocket)</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setLiveLogs([])} className="h-7 px-2">
              <Trash className="w-3.5 h-3.5 mr-1" /> Clear
            </Button>
          </div>

          {/* Terminal-style log feed */}
          {liveLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Terminal className="w-8 h-8 text-[var(--muted-foreground)] mb-2 opacity-50" />
              <p className="text-sm text-[var(--muted-foreground)]">
                No logs yet. Logs appear here in real-time when a registration is running.
              </p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Register an account from the Accounts tab, then switch back here.
              </p>
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto bg-[var(--background)] p-3 font-mono text-xs leading-relaxed">
              {liveLogs.map((log, i) => {
                const isErr = log.step === "error" || log.step.includes("error") || log.step.includes("failed");
                const isOk = log.step.includes("resolved") || log.step.includes("success") || log.step.includes("verified") || log.step.includes("code_found");
                const isWarn = log.step.includes("waiting") || log.step.includes("datadome_waiting");
                return (
                  <div key={i} className="flex gap-2 py-0.5 hover:bg-[var(--surface-2)] rounded px-1 -mx-1">
                    <span className="text-[var(--muted-foreground)] shrink-0">
                      {new Date(log.ts).toLocaleTimeString()}
                    </span>
                    <span className="shrink-0 text-[var(--info)]">[{log.id}]</span>
                    {log.email && (
                      <span className="shrink-0 text-[var(--foreground)] opacity-70 hidden sm:inline">
                        {log.email.length > 25 ? log.email.slice(0, 22) + "…" : log.email}
                      </span>
                    )}
                    <span className={`shrink-0 font-semibold ${isErr ? "text-[var(--error)]" : isOk ? "text-green-500" : isWarn ? "text-yellow-500" : "text-[var(--foreground)]"}`}>
                      {log.step}
                    </span>
                    {log.detail && (
                      <span className="text-[var(--muted-foreground)] break-all">
                        — {log.detail}
                      </span>
                    )}
                  </div>
                );
              })}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
