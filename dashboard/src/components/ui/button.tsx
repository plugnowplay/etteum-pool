import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Inline-flex + gap so icon+label align; focus-ring keeps the keyboard halo
  // consistent with every other custom control in the design system.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-all duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] " +
    "disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none " +
    "active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[var(--es-1)] hover:bg-[var(--primary)]/90 hover:shadow-[var(--es-2)]",
        destructive:
          "bg-[var(--destructive)] text-[var(--destructive-foreground)] shadow-[var(--es-1)] hover:bg-[var(--destructive)]/90 hover:shadow-[var(--es-2)]",
        outline:
          "border border-[var(--border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)] hover:border-[var(--muted-foreground)]/40",
        secondary:
          "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--secondary)]/80",
        ghost:
          "text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]",
        link:
          "text-[var(--primary)] underline-offset-4 hover:underline active:scale-100",
        // Subtle filled-danger for delete-inside-row actions.
        danger:
          "bg-[var(--destructive)]/10 text-[var(--destructive)] hover:bg-[var(--destructive)]/20 border border-[var(--destructive)]/25",
      },
      size: {
        // 44px touch targets on mobile, compact on desktop.
        default: "h-9 px-4 py-2 min-h-[44px] md:min-h-0",
        sm: "h-8 rounded-md px-3 text-xs min-h-[44px] md:min-h-0",
        lg: "h-10 rounded-md px-8 min-h-[44px] md:min-h-0",
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
