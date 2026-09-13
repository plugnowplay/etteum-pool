import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "primary" | "success" | "warning" | "error" | "info";

const toneMap: Record<Tone, { text: string; bg: string; border: string }> = {
  default: {
    text: "text-[var(--foreground)]",
    bg: "bg-transparent",
    border: "border-[var(--border)]",
  },
  primary: {
    text: "text-[var(--primary)]",
    bg: "bg-transparent",
    border: "border-[var(--primary)]/60",
  },
  success: {
    text: "text-[var(--success)]",
    bg: "bg-transparent",
    border: "border-[var(--success)]/60",
  },
  warning: {
    text: "text-[var(--warning)]",
    bg: "bg-transparent",
    border: "border-[var(--warning)]/60",
  },
  error: {
    text: "text-[var(--error)]",
    bg: "bg-transparent",
    border: "border-[var(--error)]/60",
  },
  info: {
    text: "text-[var(--info)]",
    bg: "bg-transparent",
    border: "border-[var(--info)]/60",
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
        // Dense one-line readout with a single left rule — a row in a status
        // strip, not a boxed tile. Full borders on six of these made the top of
        // every page read as a wall of little boxes.
        "group relative flex items-center gap-2 overflow-hidden",
        "border-l-2 border-[var(--border)] bg-transparent pl-2.5 pr-1 py-1",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:border-[var(--primary)]",
        className
      )}
      {...props}
    >
      {Icon && (
        <Icon className={cn("h-3 w-3 shrink-0 opacity-70", t.text)} aria-hidden />
      )}
      <p className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
        {label}
      </p>
      <p className={cn("tabular shrink-0 text-sm font-semibold leading-none", t.text)}>
        {value}
      </p>

      {(hint || typeof delta === "number") && (
        <div className="flex shrink-0 items-center gap-1.5 text-[10px]">
          {typeof delta === "number" && (
            <span className={cn("tabular font-medium", deltaTone)}>
              {delta > 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </span>
          )}
          {hint && (
            <span className="hidden text-[var(--muted-foreground)] lg:inline">{hint}</span>
          )}
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
