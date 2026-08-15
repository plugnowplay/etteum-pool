import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Right-side slide-over panel. Replaces the hand-rolled
 * `fixed inset-0 flex justify-end` overlays used in Requests/Accounts.
 *
 * Handles: backdrop click, Escape key, body scroll lock, focus restore.
 */
interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Sticky header row under the title (badges, meta). */
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  width?: "sm" | "md" | "lg";
  children?: React.ReactNode;
}

const widthMap = {
  sm: "max-w-[420px]",
  md: "max-w-[560px]",
  lg: "max-w-[720px]",
};

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  meta,
  footer,
  width = "md",
  children,
}: DrawerProps) {
  // Escape to close
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className={cn(
          "animate-slide-in-right flex h-full w-full flex-col border-l border-[var(--border)]",
          "bg-[var(--card)] shadow-[var(--es-4)]",
          widthMap[width]
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {(title || subtitle) && (
          <header className="shrink-0 border-b border-[var(--border)] px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {title && (
                  <h2 className="truncate text-sm font-semibold text-[var(--foreground)]">
                    {title}
                  </h2>
                )}
                {subtitle && (
                  <p className="tabular mt-0.5 text-xs text-[var(--muted-foreground)]">
                    {subtitle}
                  </p>
                )}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="focus-ring -mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
          </header>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="shrink-0 border-t border-[var(--border)] px-5 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}

/** Labeled row for drawer detail sections. */
export function KeyValue({
  label,
  value,
  mono = false,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5", className)}>
      <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-xs text-[var(--foreground)]",
          mono && "tabular font-mono"
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Grouped section inside a drawer. */
export function DrawerSection({
  title,
  actions,
  className,
  children,
}: {
  title?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("mt-5 first:mt-0", className)}>
      {(title || actions) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && (
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              {title}
            </p>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
