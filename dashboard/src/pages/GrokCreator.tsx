import { Fragment, useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useWsEvent } from "@/hooks/useWebSocket";
import { fetchApi } from "@/lib/api";
import { Loader2, Plus, Trash2, RefreshCw, Mail, Server, Users, Send, Terminal, Rocket } from "lucide-react";

interface ImapServer {
  id: number;
  label: string | null;
  host: string;
  port: number;
  username: string;
  catchAllDomain: string | null;
  status: string;
}

interface GrokAccount {
  id: number;
  email: string;
  username: string | null;
  status: string;
  imapServerId: number | null;
  proxyId: number | null;
  token: string | null;
  errorMessage: string | null;
  metadata: string | null;
  createdAt: string | number;
  updatedAt: string | number | null;
}

type Tab = "imap" | "create" | "accounts" | "logs";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-300",
  registering: "bg-blue-500/20 text-blue-300",
  registered: "bg-purple-500/20 text-purple-300",
  verified: "bg-emerald-500/20 text-emerald-300",
  error: "bg-red-500/20 text-red-300",
};

export default function GrokCreator() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("imap");
  const [imapServers, setImapServers] = useState<ImapServer[]>([]);
  const [accounts, setAccounts] = useState<GrokAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Create form
  const [imapId, setImapId] = useState<number>(0);
  const [count, setCount] = useState(1);
  const [lastPasswords, setLastPasswords] = useState<string[]>([]);

  // Live logs
  const [liveLogs, setLiveLogs] = useState<{ id: number; email: string; step: string; detail?: string; ts: string }[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const MAX_LIVE_LOGS = 200;

  // ── WebSocket: listen for progress + account updates ──
  useWsEvent("grok_creator.account_updated", (msg: any) => {
    const d = msg.data;
    if (!d?.id) return;
    void load();
  });

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [accRes, imapRes] = await Promise.all([
        fetchApi("/grok-creator/accounts"),
        fetchApi("/grok-creator/imap"),
      ]);
      setAccounts(accRes.accounts || []);
      setImapServers(imapRes.servers || []);
      // default imapId
      setImapId((prev) => {
        if (prev) return prev;
        return imapRes.servers?.[0]?.id || 0;
      });
    } catch (e) {
      toast.error("Gagal load Grok Creator: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [liveLogs]);

  // ── Actions ──
  async function createAccounts() {
    if (!imapId || count < 1) {
      toast.error("Pilih IMAP server dan count minimal 1");
      return;
    }
    setBusy((p) => ({ ...p, create: true }));
    try {
      const res = await fetchApi("/grok-creator/accounts", {
        method: "POST",
        body: JSON.stringify({ imap_server_id: imapId, count }),
      });
      if (!res.created) throw new Error("Create gagal");
      toast.success(`${res.created} akun dibuat (email siap di-farm)`);
      setLastPasswords(res.password ? [res.password] : []);
      void load();
    } catch (e) {
      toast.error("Gagal create: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy((p) => ({ ...p, create: false }));
    }
  }

  async function registerAccount(id: number) {
    setBusy((p) => ({ ...p, [`reg-${id}`]: true }));
    try {
      const res = await fetchApi(`/grok-creator/accounts/${id}/register`, { method: "POST" });
      toast.success(`Akun #${id}: ${res.status}`);
      void load();
    } catch (e) {
      toast.error("Register gagal: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy((p) => ({ ...p, [`reg-${id}`]: false }));
    }
  }

  async function retryAccount(id: number) {
    setBusy((p) => ({ ...p, [`retry-${id}`]: true }));
    try {
      const res = await fetchApi(`/grok-creator/accounts/${id}/retry`, { method: "POST" });
      toast.success(`Akun #${id} retry: ${res.status}`);
      void load();
    } catch (e) {
      toast.error("Retry gagal: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy((p) => ({ ...p, [`retry-${id}`]: false }));
    }
  }

  async function deleteAccount(id: number) {
    if (!confirm(`Hapus akun #${id}?`)) return;
    try {
      await fetchApi(`/grok-creator/accounts/${id}`, { method: "DELETE" });
      toast.success(`Akun #${id} dihapus`);
      void load();
    } catch (e) {
      toast.error("Hapus gagal: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function statusBadge(status: string) {
    const cls = STATUS_COLORS[status] || "bg-gray-500/20 text-gray-300";
    return <Badge className={cls}>{status}</Badge>;
  }

  const tabs: { key: Tab; label: string; icon: any }[] = [
    { key: "imap", label: "IMAP", icon: Server },
    { key: "create", label: "Buat Akun", icon: Plus },
    { key: "accounts", label: `Akun (${accounts.length})`, icon: Users },
    { key: "logs", label: "Live Logs", icon: Terminal },
  ];

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Rocket className="w-5 h-5" /> Grok Creator
          </h1>
          <p className="text-sm text-muted-foreground">
            Auto-farm akun x.ai (Grok) via Camoufox + OAuth → inject ke grok-cli
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-4 gap-2">
        {tabs.map((t) => (
          <Button
            key={t.key}
            variant={tab === t.key ? "default" : "outline"}
            size="sm"
            className="flex items-center gap-1 justify-center"
            onClick={() => setTab(t.key)}
          >
            <t.icon className="w-4 h-4" />
            <span className="hidden sm:inline">{t.label}</span>
            {t.key === "accounts" && <span className="sm:hidden">{accounts.length}</span>}
          </Button>
        ))}
      </div>

      {/* ── TAB: IMAP ── */}
      {tab === "imap" && (
        <div className="space-y-2">
          <h2 className="font-semibold text-sm flex items-center gap-2"><Server className="w-4 h-4" /> IMAP Server</h2>
          {imapServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada IMAP server.</p>
          ) : (
            imapServers.map((s) => (
              <div key={s.id} className="rounded-xl border p-3 space-y-1">
                <div className="flex items-center gap-2 justify-between">
                  <span className="font-medium">{s.label || s.username}</span>
                  <Badge variant="outline">{s.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {s.host}:{s.port} · {s.username}
                </p>
                <p className="text-xs text-muted-foreground">
                  Catch-all domain: <span className="font-mono">{s.catchAllDomain || "-"}</span>
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── TAB: CREATE ── */}
      {tab === "create" && (
        <div className="rounded-xl border p-4 space-y-3">
          <h2 className="font-semibold text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> Buat Akun Grok</h2>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">IMAP Server</label>
            <select
              className="w-full rounded-lg border bg-background p-2"
              value={imapId}
              onChange={(e) => setImapId(Number(e.target.value))}
            >
              {imapServers.length === 0 && <option value={0}>Tidak ada IMAP</option>}
              {imapServers.map((s) => (
                <option key={s.id} value={s.id}>{s.label || s.username} ({s.catchAllDomain})</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Jumlah akun</label>
            <input
              type="number"
              min={1}
              max={100}
              className="w-full rounded-lg border bg-background p-2"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </div>
          <Button onClick={() => void createAccounts()} disabled={busy.create || !imapId} className="w-full">
            {busy.create ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Buat {count} Akun
          </Button>
          {lastPasswords.length > 0 && (
            <div className="rounded-lg bg-muted p-3 text-xs space-y-1">
              <p className="font-semibold">Password akun (simpan!):</p>
              {lastPasswords.map((p, i) => (
                <p key={i} className="font-mono break-all">{p}</p>
              ))}
              <p className="text-muted-foreground">Email & password tampil juga di list akun.</p>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: ACCOUNTS ── */}
      {tab === "accounts" && (
        <div className="space-y-2">
          {loading ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada akun. Buat dulu di tab "Buat Akun".</p>
          ) : (
            accounts.map((a) => (
              <div key={a.id} className="rounded-xl border p-3 space-y-2">
                <div className="flex items-center gap-2 justify-between">
                  <span className="font-medium text-sm break-all">{a.email}</span>
                  {statusBadge(a.status)}
                </div>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {a.username || "-"} · pass: {a.passwordHidden !== undefined ? "***" : "-"}
                </p>
                {a.token && (
                  <p className="text-xs font-mono break-all bg-muted rounded p-1.5 text-emerald-300">
                    ✓ Token didapat (inject ke grok-cli)
                  </p>
                )}
                {a.errorMessage && (
                  <p className="text-xs text-red-300 break-all">{a.errorMessage}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => void registerAccount(a.id)} disabled={busy[`reg-${a.id}`]}>
                    {busy[`reg-${a.id}`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Register
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void retryAccount(a.id)} disabled={busy[`retry-${a.id}`]}>
                    {busy[`retry-${a.id}`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" className="text-red-400" onClick={() => void deleteAccount(a.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── TAB: LOGS ── */}
      {tab === "logs" && (
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-sm">Live Logs</h2>
            <Button variant="ghost" size="sm" onClick={() => setLiveLogs([])}>Clear</Button>
          </div>
          <div className="h-80 overflow-y-auto space-y-1 font-mono text-xs">
            {liveLogs.length === 0 ? (
              <p className="text-muted-foreground">Belum ada log. Register akun untuk lihat progress.</p>
            ) : (
              liveLogs.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-muted-foreground">{l.ts}</span>
                  <span className="text-blue-300">#{l.id}</span>
                  <span className="text-muted-foreground">{l.email}</span>
                  <span>{l.step}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
