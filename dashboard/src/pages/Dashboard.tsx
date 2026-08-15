import TokenUsage from "@/components/dashboard/TokenUsage";
import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle, RefreshCw, Users, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { fetchDashboardStats, fetchModelUsage } from "@/lib/api";
import { modelColor } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

/** Compact token formatting used by the headline stat tiles. */
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [modelStats, setModelStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    await Promise.all([
      fetchDashboardStats(undefined, "all").then(setStats).catch(() => setStats(null)),
      fetchModelUsage(undefined, "all").then((res: { data: any[] }) => setModelStats(res.data || [])).catch(() => setModelStats([])),
    ]);
    setLoading(false);
  }

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 500);
  };

  useEffect(() => {
    load();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, []);

  useWsEvent(
    [
      "request_log",
      "request_error",
      "account_status",
      "account_updated",
      "account_created",
      "account_deleted",
      "accounts_updated",
      "accounts_bulk_created",
      "provider_toggled",
    ],
    scheduleReload,
  );

  const totalRequests = Number(stats?.requests?.total || 0);
  const successRequests = Number(stats?.requests?.success || 0);
  const dashboardStats = {
    accounts: {
      active: Number(stats?.pool?.active || 0),
      total: Number(stats?.pool?.total || 0),
    },
    requests: totalRequests,
    successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(1)) : 0,
    totalTokens: Number(stats?.tokens?.total || 0),
  };

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  const modelUsage = modelStats.filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.credits || 0) > 0).slice(0, 8).map((m, idx) => ({
    provider: m.provider || "unknown",
    model: m.model || "unknown",
    tokens: Number(m.totalTokens || 0),
    promptTokens: Number(m.promptTokens || 0),
    completionTokens: Number(m.completionTokens || 0),
    credits: Number(m.credits || 0),
    requests: Number(m.totalRequests || 0),
    creditSource: m.creditSource || "estimated",
    color: modelColor(`${m.provider || "unknown"}/${m.model || "unknown"}`, idx),
  }));

  const successTone =
    dashboardStats.successRate >= 95
      ? "success"
      : dashboardStats.successRate >= 80
        ? "warning"
        : "error";

  return (
    <PageShell>
      <PageHeader
        title="Dashboard"
        description="Overview of your proxy pool status — accounts, throughput, and token spend."
        actions={
          <Button variant="outline" size="sm" onClick={load} loading={loading}>
            {!loading && <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading && !stats ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard
              label="Accounts"
              value={
                <span className="tabular">
                  {dashboardStats.accounts.active}/{dashboardStats.accounts.total}
                </span>
              }
              hint="active"
              icon={Users}
              tone="info"
            />
            <StatCard
              label="Requests"
              value={<span className="tabular">{dashboardStats.requests.toLocaleString()}</span>}
              hint="All time"
              icon={Activity}
              tone="primary"
            />
            <StatCard
              label="Success Rate"
              value={<span className="tabular">{dashboardStats.successRate}%</span>}
              hint="All time"
              icon={CheckCircle}
              tone={successTone}
            />
            <StatCard
              label="Total Tokens"
              value={<span className="tabular">{formatTokens(dashboardStats.totalTokens)}</span>}
              hint="All time"
              icon={Zap}
              tone="warning"
            />
          </>
        )}
      </div>

      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />
    </PageShell>
  );
}
