import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

const baseField =
  "flex w-full rounded-md border border-[var(--border)] bg-[var(--background)] text-sm text-[var(--foreground)] " +
  "transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
  "placeholder:text-[var(--muted-foreground)] " +
  "hover:border-[var(--muted-foreground)]/40 " +
  "focus-visible:outline-none focus-visible:border-[var(--ring)] " +
  "focus-visible:ring-2 focus-visible:ring-[var(--ring)]/25 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Leading icon slot. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Render as invalid (red border + ring). */
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon: Icon, invalid, ...props }, ref) => {
    const field = (
      <input
        type={type}
        aria-invalid={invalid || undefined}
        className={cn(
          baseField,
          "h-9 px-3 py-1 min-h-[44px] md:min-h-0",
          Icon && "pl-9",
          invalid &&
            "border-[var(--error)] focus-visible:border-[var(--error)] focus-visible:ring-[var(--error)]/25",
          className
        )}
        ref={ref}
        {...props}
      />
    );

    if (!Icon) return field;

    return (
      <div className="relative w-full">
        <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
        {field}
      </div>
    );
  }
);
Input.displayName = "Input";

/**
 * Search field with a magnifier and a clear button. Standardizes the
 * "relative + absolute Search icon + pl-9" pattern repeated on every page.
 */
export interface SearchInputProps extends Omit<InputProps, "icon" | "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
}

const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, value, onValueChange, placeholder = "Search…", ...props }, ref) => (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          baseField,
          "h-9 pl-9 pr-9 min-h-[44px] md:min-h-0 [&::-webkit-search-cancel-button]:hidden",
          className
        )}
        {...props}
      />
      {value.length > 0 && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange("")}
          className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
);
SearchInput.displayName = "SearchInput";

/** Label + optional hint/error wrapper for form rows. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  className,
  children,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1 text-xs font-medium text-[var(--foreground)]"
        >
          {label}
          {required && <span className="text-[var(--error)]">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[11px] text-[var(--error)]">{error}</p>
      ) : hint ? (
        <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">{hint}</p>
      ) : null}
    </div>
  );
}

export { Input, SearchInput, baseField };
