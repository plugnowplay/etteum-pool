import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "primary" | "success" | "warning" | "error" | "info";

const toneMap: Record<Tone, { text: string; bg: string; ring: string }> = {
  default: {
    text: "text-[var(--foreground)]",
    bg: "bg-[var(--secondary)]",
    ring: "ring-[var(--border)]",
  },
  primary: {
    text: "text-[var(--primary)]",
    bg: "bg-[var(--primary)]/10",
    ring: "ring-[var(--primary)]/25",
  },
  success: {
    text: "text-[var(--success)]",
    bg: "bg-[var(--success)]/10",
    ring: "ring-[var(--success)]/25",
  },
  warning: {
    text: "text-[var(--warning)]",
    bg: "bg-[var(--warning)]/10",
    ring: "ring-[var(--warning)]/25",
  },
  error: {
    text: "text-[var(--error)]",
    bg: "bg-[var(--error)]/10",
    ring: "ring-[var(--error)]/25",
  },
  info: {
    text: "text-[var(--info)]",
    bg: "bg-[var(--info)]/10",
    ring: "ring-[var(--info)]/25",
  },
};

interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  /** Small text under the value (context, delta, subtitle). */
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  /** Trend delta, e.g. +12.4% — colored by sign unless tone is given. */
  delta?: number | null;
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  delta,
  className,
  ...props
}: StatCardProps) {
  const t = toneMap[tone];
  const deltaTone =
    typeof delta === "number"
      ? delta > 0
        ? "text-[var(--success)]"
        : delta < 0
          ? "text-[var(--error)]"
          : "text-[var(--muted-foreground)]"
      : "";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] p-4",
        "shadow-[var(--es-1)] transition-all duration-[var(--dur-base)] ease-[var(--ease-out)]",
        "hover:-translate-y-0.5 hover:border-[var(--border)] hover:shadow-[var(--es-3)]",
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
          {label}
        </p>
        {Icon && (
          <div
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1",
              t.bg,
              t.ring,
              t.text
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
        )}
      </div>

      <p className={cn("tabular mt-2 text-2xl font-semibold leading-none", t.text)}>
        {value}
      </p>

      {(hint || typeof delta === "number") && (
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          {typeof delta === "number" && (
            <span className={cn("tabular font-medium", deltaTone)}>
              {delta > 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </span>
          )}
          {hint && <span className="text-[var(--muted-foreground)]">{hint}</span>}
        </div>
      )}
    </div>
  );
}

/** Compact inline metric — used inside drawers and detail panels. */
export function Metric({
  label,
  value,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const t = toneMap[tone];
  return (
    <div className={cn("rounded-md px-3 py-2", t.bg, className)}>
      <p className="text-[10px] uppercase tracking-wide opacity-70">{label}</p>
      <p className={cn("tabular mt-0.5 text-sm font-semibold", t.text)}>{value}</p>
    </div>
  );
}
