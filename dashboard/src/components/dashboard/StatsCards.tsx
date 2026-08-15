import { Users, Activity, CheckCircle, Zap } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

interface StatsData {
  accounts: { active: number; total: number };
  requests: number;
  successRate: number;
  totalTokens: number;
}

interface StatsCardsProps {
  data?: StatsData;
}

const defaultData: StatsData = {
  accounts: { active: 0, total: 0 },
  requests: 0,
  successRate: 0,
  totalTokens: 0,
};

export default function StatsCards({ data = defaultData }: StatsCardsProps) {
  // Success rate drives its own tone so a degraded pool is visible at a glance.
  const successTone =
    data.successRate >= 95 ? "success" : data.successRate >= 80 ? "warning" : "error";

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Accounts"
        value={`${data.accounts.active}/${data.accounts.total}`}
        hint="active"
        icon={Users}
        tone="info"
      />
      <StatCard
        label="Requests"
        value={data.requests.toLocaleString("en-US")}
        hint="all time"
        icon={Activity}
        tone="primary"
      />
      <StatCard
        label="Success rate"
        value={`${data.successRate}%`}
        hint="all time"
        icon={CheckCircle}
        tone={successTone}
      />
      <StatCard
        label="Total tokens"
        value={formatTokens(data.totalTokens)}
        hint="all time"
        icon={Zap}
        tone="warning"
      />
    </div>
  );
}
