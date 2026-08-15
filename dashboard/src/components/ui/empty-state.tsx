import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Centered empty / zero-data state. Replaces the ad-hoc
 * "No X yet" <td> strings scattered across pages.
 */
interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Tighter padding for use inside a table cell. */
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-10" : "px-6 py-16",
        className
      )}
      {...props}
    >
      {Icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--secondary)] text-[var(--muted-foreground)]">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <p className="text-sm font-medium text-[var(--foreground)]">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-[var(--muted-foreground)]">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
