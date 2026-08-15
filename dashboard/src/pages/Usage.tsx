import TokenUsage from "@/components/dashboard/TokenUsage";
import { useEffect, useState, useRef } from "react";
import { Coins, RefreshCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { fetchDashboardStats, fetchModelUsage } from "@/lib/api";
import { formatNumber, modelColor } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

export default function Usage() {
  const [stats, setStats] = useState<any>(null);
  const [modelStats, setModelStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    setLoading(true);
    await Promise.all([
      fetchDashboardStats().then(setStats).catch(() => setStats(null)),
      fetchModelUsage().then((res: { data: any[] }) => setModelStats(res.data || [])).catch(() => setModelStats([])),
    ]);
    setLoading(false);
  }

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 500);
  };

  useEffect(() => {
    load();
    return () => { if (reloadRef.current) clearTimeout(reloadRef.current); };
  }, []);

  useWsEvent(["request_log", "request_error"], scheduleReload);

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  const modelUsage = modelStats.map((m, idx) => ({
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

  return (
    <PageShell>
      <PageHeader
        title="Usage"
        description="Detailed token and credit usage analytics across every model in the pool."
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
              label="Total tokens"
              value={<span className="tabular">{formatNumber(tokenStats.total)}</span>}
              icon={Zap}
              tone="primary"
            />
            <StatCard
              label="Prompt"
              value={<span className="tabular">{formatNumber(tokenStats.prompt)}</span>}
              icon={Zap}
              tone="success"
            />
            <StatCard
              label="Completion"
              value={<span className="tabular">{formatNumber(tokenStats.completion)}</span>}
              icon={Zap}
              tone="info"
            />
            <StatCard
              label="Credits"
              value={<span className="tabular">{tokenStats.credits.toFixed(2)}</span>}
              icon={Coins}
              tone="warning"
            />
          </>
        )}
      </div>

      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />
    </PageShell>
  );
}
