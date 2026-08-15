import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { modelColor } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";

interface UsageChartProps {
  data?: any[];
  period?: string;
  colorsByModel?: Record<string, string>;
}

const defaultData: any[] = [];

function formatTokenCount(value: number) {
  const abs = Math.abs(value);
  const format = (num: number) => Number(num.toFixed(2)).toString();

  if (abs >= 1_000_000) return `${format(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${format(value / 1_000)}K`;
  return value.toString();
}

export default function UsageChart({ data = defaultData, colorsByModel = {} }: UsageChartProps) {
  const models = Object.keys(data[0] || {}).filter((k) => k !== "hour" && k !== "label");
  const colors = Object.fromEntries(
    models.map((model, index) => [model, colorsByModel[model] || modelColor(model, index)])
  );

  if (data.length === 0) {
    return (
      <div className="flex h-[300px] w-full items-center justify-center rounded-lg border border-dashed border-[var(--border)]">
        <EmptyState
          compact
          icon={BarChart3}
          title="No usage data yet"
          description="Token usage appears here once requests start flowing."
        />
      </div>
    );
  }

  // Chart chrome reads from theme tokens instead of hardcoded hex so the chart
  // stays legible in light mode.
  const axisColor = "var(--muted-foreground)";
  const gridColor = "var(--border)";

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            {models.map((model) => (
              <linearGradient key={model} id={`gradient-${model}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors[model]} stopOpacity={0.32} />
                <stop offset="95%" stopColor={colors[model]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="label"
            stroke={axisColor}
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke={axisColor}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(value) => formatTokenCount(Number(value))}
          />
          <Tooltip
            cursor={{ stroke: gridColor, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const sorted = [...payload].sort(
                (a, b) => Number(b.value || 0) - Number(a.value || 0)
              );
              return (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--popover)] px-3 py-2 shadow-[var(--es-3)]">
                  <p className="mb-1 text-xs font-medium text-[var(--foreground)]">{label}</p>
                  <div className="space-y-0.5">
                    {sorted.map((entry) => (
                      <p
                        key={entry.name}
                        className="tabular flex items-center gap-2 text-xs"
                        style={{ color: entry.color }}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="text-[var(--muted-foreground)]">{entry.name}</span>
                        <span className="ml-auto font-medium">
                          {formatTokenCount(Number(entry.value || 0))}
                        </span>
                      </p>
                    ))}
                  </div>
                </div>
              );
            }}
          />
          <Legend
            iconType="circle"
            iconSize={7}
            wrapperStyle={{ fontSize: "11px", paddingTop: 8 }}
          />
          {models.map((model) => (
            <Area
              key={model}
              type="monotone"
              dataKey={model}
              stroke={colors[model]}
              fill={`url(#gradient-${model})`}
              strokeWidth={2}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
