import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shimmer placeholder. The `.skeleton` class (index.css) carries the gradient
 * + animation and already respects prefers-reduced-motion.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-md", className)} {...props} />;
}

/** N rows of table-shaped skeletons — used as table loading state. */
export function SkeletonRows({
  rows = 5,
  cols = 4,
  className,
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <div className={cn("divide-y divide-[var(--border)]", className)}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn(
                "h-3.5",
                c === 0 ? "w-32" : c === cols - 1 ? "ml-auto w-16" : "w-24"
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Card-shaped skeleton for stat grids. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--border)] bg-[var(--card)] p-4",
        className
      )}
    >
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-3 h-7 w-24" />
      <Skeleton className="mt-2 h-2.5 w-16" />
    </div>
  );
}
