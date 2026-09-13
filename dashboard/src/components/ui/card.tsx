import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Terminal section, not a boxed card. A single rule on top separates
        // sections the way `── TITLE ────` does on the public Share page.
        // Full borders on every panel made pages read as nested boxes.
        "border-t border-[var(--border)] bg-transparent pt-3 text-[var(--card-foreground)]",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

/** Clickable tile — keeps a full frame because it must read as one hit target. */
const CardInteractive = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "cursor-pointer border border-[var(--border)] bg-[var(--card)] text-[var(--card-foreground)]",
      "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
      // Terminals don't lift — the phosphor just burns brighter.
      "hover:border-[var(--primary)] hover:bg-[var(--secondary)]",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]",
      className
    )}
    {...props}
  />
));
CardInteractive.displayName = "CardInteractive";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // No side padding: without side borders the content should align to the
    // page grid, not sit inset from an invisible edge.
    <div ref={ref} className={cn("flex flex-col space-y-1 pb-2", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        "font-display text-[11px] leading-none text-[var(--muted-foreground)]",
        className
      )}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-xs leading-relaxed text-[var(--muted-foreground)]", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center pt-2", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardInteractive, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
