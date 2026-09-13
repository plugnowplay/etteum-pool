import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // Retro terminal tag: square, hairline border, uppercase mono — reads like
  // the [THINK] / [VIS] flags on the public Share page.
  "inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10px] uppercase " +
    "tracking-[0.12em] " +
    "transition-colors duration-[var(--dur-fast)] " +
    "focus:outline-none focus:ring-1 focus:ring-[var(--ring)] focus:ring-offset-1 focus:ring-offset-[var(--background)]",
  {
    variants: {
      variant: {
        default: "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary: "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive: "border-[var(--destructive)] bg-[var(--destructive)] text-[var(--destructive-foreground)]",
        outline: "border-[var(--border)] text-[var(--foreground)]",
        // Status chips stay outlined — a terminal signals state with colour,
        // not with fills, so rows don't turn into blocks of solid colour.
        success: "border-[var(--success)]/60 text-[var(--success)]",
        warning: "border-[var(--warning)]/60 text-[var(--warning)]",
        error: "border-[var(--error)]/60 text-[var(--error)]",
        info: "border-[var(--info)]/60 text-[var(--info)]",
        // Muted — de-emphasized, for neutral metadata chips.
        muted: "border-[var(--border)] text-[var(--muted-foreground)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Show a small status dot before the label. */
  dot?: boolean;
}

// Rendered as <span> (not <div>) so badges are valid inside <p>, <label>,
// and other phrasing-content parents. `inline-flex` keeps layout identical.
function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
