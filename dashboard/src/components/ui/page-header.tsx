import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Standard page title block. Every page uses this so the title size, spacing,
 * and action alignment are identical across the dashboard.
 *
 * <PageHeader title="Requests" description="..." actions={<Button/>} />
 */
interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  /** Right-aligned action slot (buttons, refresh, filters). */
  actions?: React.ReactNode;
  /** Optional inline node right after the title (badge, count, live dot). */
  badge?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  badge,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
      {...props}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="truncate text-xl font-semibold tracking-tight text-[var(--foreground)] sm:text-2xl">
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted-foreground)]">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** Consistent vertical rhythm wrapper for page content. */
export function PageShell({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("animate-fade-in space-y-6", className)} {...props}>
      {children}
    </div>
  );
}

/** Section heading inside a page (smaller than PageHeader). */
export function SectionHeader({
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-between gap-2", className)}
      {...props}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
