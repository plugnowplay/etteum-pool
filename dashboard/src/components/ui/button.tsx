import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Retro terminal buttons: square, hairline border, uppercase wide-tracked
  // mono label, and invert-on-hover (fill floods with phosphor) — the same
  // interaction the public Share page uses for [CP] / [OK!].
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-xs font-medium " +
    "font-mono uppercase tracking-[0.14em] border " +
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] " +
    "focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)] " +
    "disabled:pointer-events-none disabled:opacity-40 cursor-pointer select-none",
  {
    variants: {
      variant: {
        default:
          "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-transparent hover:text-[var(--primary)]",
        // Loudest action — outlined at rest, floods solid on hover.
        cta:
          "border-[var(--accent)] bg-transparent text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
        destructive:
          "border-[var(--destructive)] bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-transparent hover:text-[var(--destructive)]",
        outline:
          "border-[var(--border)] bg-transparent text-[var(--foreground)] hover:border-[var(--primary)] hover:bg-[var(--primary)] hover:text-[var(--primary-foreground)]",
        secondary:
          "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]",
        ghost:
          "border-transparent text-[var(--muted-foreground)] hover:border-[var(--border)] hover:text-[var(--foreground)]",
        link:
          "border-transparent text-[var(--primary)] underline-offset-4 hover:underline",
        // Subtle filled-danger for delete-inside-row actions.
        danger:
          "border-[var(--destructive)]/50 bg-transparent text-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-[var(--destructive-foreground)]",
      },
      size: {
        // 44px touch targets on mobile, compact on desktop.
        default: "h-9 px-4 py-2 min-h-[44px] md:min-h-0",
        sm: "h-8 px-3 text-[11px] min-h-[44px] md:min-h-0",
        lg: "h-10 px-6 text-sm min-h-[44px] md:min-h-0",
        icon: "h-9 w-9 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Show a spinner and block the click while an action is running. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {children}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
