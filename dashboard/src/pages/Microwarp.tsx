import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, RotateCw, Server, Activity, Timer, Globe } from "lucide-react";
import { fetchApi } from "@/lib/api";

interface WarpStatus {
  n: number;
  container: string;
  containerState: "running" | "restarting" | "stopped" | "unknown";
  containerUptime: string | null;
  socksPort: number;
  httpPort: number;
  poolLabel: string;
  ip: string | null;
  ipLatencyMs: number | null;
  bridgeOk: boolean;
  error: string | null;
}

interface MicrowarpStatus {
  count: number;
  runningCount: number;
  healthyCount: number;
  autoRotate: {
    enabled: boolean;
    intervalMinutes: number;
    strategy: string;
    nextAt: string | number | null;
    lastAt: string | number | null;
  };
  warps: WarpStatus[];
}

function formatRelative(raw: string | number | null): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  let t: number;
  if (typeof raw === "number") {
    // systemd epoch is microseconds; convert if too large for ms
    t = raw > 1e15 ? Math.floor(raw / 1000) : raw;
  } else {
    // Try as ISO first
    const parsed = new Date(raw).getTime();
    if (!isNaN(parsed)) {
      t = parsed;
    } else {
      // Try as numeric string (microseconds)
      const num = Number(raw);
      if (isNaN(num)) return String(raw);
      t = num > 1e15 ? Math.floor(num / 1000) : num;
    }
  }
  const diffSec = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec > 0;
  let str: string;
  if (abs < 60) str = `${abs}s`;
  else if (abs < 3600) str = `${Math.floor(abs / 60)}m`;
  else if (abs < 86400) str = `${Math.floor(abs / 3600)}h${Math.floor((abs % 3600) / 60)}m`;
  else str = `${Math.floor(abs / 86400)}d`;
  return future ? `in ${str}` : `${str} ago`;
}

function StateBadge({ state, bridgeOk }: { state: WarpStatus["containerState"]; bridgeOk: boolean }) {
  if (state === "running" && bridgeOk) {
    return <Badge variant="success" dot>healthy</Badge>;
  }
  if (state === "running" && !bridgeOk) {
    return <Badge variant="error" dot>bridge down</Badge>;
  }
  if (state === "restarting") {
    return <Badge variant="warning" dot>restarting</Badge>;
  }
  if (state === "stopped") {
    return <Badge variant="error" dot>stopped</Badge>;
  }
  return <Badge variant="muted">unknown</Badge>;
}

export default function Microwarp() {
  const [data, setData] = useState<MicrowarpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rotatingN, setRotatingN] = useState<number | null>(null);
  const [rotatingAll, setRotatingAll] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetchApi<MicrowarpStatus>("/api/microwarp/status");
      setData(res);
    } catch (err: any) {
      toast({ title: "Gagal memuat status warp", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const rotateOne = async (n: number) => {
    setRotatingN(n);
    try {
      const res = await fetchApi<{ warp: number; oldIp: string | null; newIp: string | null; changed: boolean; bridgeOk: boolean }>(
        `/api/microwarp/rotate/${n}`,
        { method: "POST" },
      );
      if (res.bridgeOk) {
        toast({
          title: `warp${n} rotated`,
          description: res.changed
            ? `IP: ${res.oldIp} → ${res.newIp}`
            : `IP tetap ${res.newIp} (jarang, coba rotate lagi)`,
        });
      } else {
        toast({ title: `warp${n} rotate: bridge belum ready`, description: "Coba refresh sebentar lagi", variant: "destructive" });
      }
      await load(true);
    } catch (err: any) {
      toast({ title: `Gagal rotate warp${n}`, description: err.message, variant: "destructive" });
    } finally {
      setRotatingN(null);
    }
  };

  const rotateAll = async () => {
    if (!confirm("Rotate SEMUA 10 warp berurutan? Butuh ~2 menit total.")) return;
    setRotatingAll(true);
    try {
      const res = await fetchApi<{ results: Array<{ warp: number; changed: boolean; ok: boolean }> }>(
        "/api/microwarp/rotate-all",
        { method: "POST" },
      );
      const okCount = res.results.filter((r) => r.ok).length;
      const changedCount = res.results.filter((r) => r.changed).length;
      toast({ title: "Rotate all selesai", description: `${okCount}/10 healthy, ${changedCount}/10 IP berubah` });
      await load(true);
    } catch (err: any) {
      toast({ title: "Gagal rotate all", description: err.message, variant: "destructive" });
    } finally {
      setRotatingAll(false);
    }
  };

  const columns: Column<WarpStatus>[] = [
    {
      key: "n",
      header: "Warp",
      cell: (w) => (
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">warp{w.n}</span>
          <span className="text-xs text-[var(--muted-foreground)]">({w.container})</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (w) => (
        <div className="flex items-center gap-2">
          <StateBadge state={w.containerState} bridgeOk={w.bridgeOk} />
          {w.containerUptime && (
            <span className="text-xs text-[var(--muted-foreground)]">up {w.containerUptime}</span>
          )}
        </div>
      ),
    },
    {
      key: "ip",
      header: "Egress IP",
      cell: (w) =>
        w.ip ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">{w.ip}</span>
            {w.ipLatencyMs !== null && (
              <span className="text-xs text-[var(--muted-foreground)]">{w.ipLatencyMs}ms</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-[var(--muted-foreground)]">—</span>
        ),
    },
    {
      key: "ports",
      header: "Ports",
      cell: (w) => (
        <div className="text-xs font-mono text-[var(--muted-foreground)]">
          socks5 :{w.socksPort} · http :{w.httpPort}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      cell: (w) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() => rotateOne(w.n)}
          disabled={rotatingN !== null || rotatingAll}
        >
          <RotateCw className={`w-3.5 h-3.5 mr-1.5 ${rotatingN === w.n ? "animate-spin" : ""}`} />
          {rotatingN === w.n ? "Rotating…" : "Rotate"}
        </Button>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Microwarp"
        description="10 container Cloudflare WARP (MASQUE) sebagai proxy pool. Setiap restart = IP baru."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="destructive" size="sm" onClick={rotateAll} disabled={rotatingAll || rotatingN !== null}>
              <RotateCw className={`w-4 h-4 mr-1.5 ${rotatingAll ? "animate-spin" : ""}`} />
              Rotate all
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total containers" value={String(data.count)} icon={Server} />
            <StatCard label="Running" value={`${data.runningCount}/${data.count}`} icon={Activity} />
            <StatCard label="Healthy (bridge OK)" value={`${data.healthyCount}/${data.count}`} icon={Globe} />
            <StatCard
              label="Auto-rotate"
              value={data.autoRotate.enabled ? data.autoRotate.strategy : "off"}
              icon={Timer}
              hint={
                data.autoRotate.nextAt
                  ? `next ${formatRelative(data.autoRotate.nextAt)}`
                  : data.autoRotate.lastAt
                    ? `last ${formatRelative(data.autoRotate.lastAt)}`
                    : undefined
              }
            />
          </div>

          <Card>
            <CardContent className="p-0">
              {data.warps.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title="Belum ada warp container"
                  description="Pastikan docker-compose.yml di ~/microwarp/ sudah up."
                />
              ) : (
                <DataTable columns={columns} rows={data.warps} rowKey={(w) => w.n} />
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}
