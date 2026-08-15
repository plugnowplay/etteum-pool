import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/**
 * Native <select> styled to match Input. Wrapped in a relative div so we can
 * draw our own chevron (native arrows differ wildly across platforms).
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative inline-flex w-full">
        <select
          ref={ref}
          className={cn(
            "h-9 w-full appearance-none rounded-md border border-[var(--border)] bg-[var(--background)]",
            "pl-3 pr-9 text-sm text-[var(--foreground)] min-h-[44px] md:min-h-0 cursor-pointer",
            "transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
            "hover:border-[var(--muted-foreground)]/40",
            "focus-visible:outline-none focus-visible:border-[var(--ring)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/25",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
      </div>
    );
  }
);
Select.displayName = "Select";

export { Select };
