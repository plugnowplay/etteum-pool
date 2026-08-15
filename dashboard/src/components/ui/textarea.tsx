import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Grow with content up to maxRows (uncontrolled height). */
  autoResize?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, autoResize, onInput, ...props }, ref) => {
    const handleInput: React.FormEventHandler<HTMLTextAreaElement> = (e) => {
      if (autoResize) {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }
      onInput?.(e as Parameters<NonNullable<typeof onInput>>[0]);
    };

    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        onInput={handleInput}
        className={cn(
          "flex w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm",
          "text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]",
          "transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          "hover:border-[var(--muted-foreground)]/40 resize-y",
          "focus-visible:outline-none focus-visible:border-[var(--ring)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/25",
          "disabled:cursor-not-allowed disabled:opacity-50",
          invalid &&
            "border-[var(--error)] focus-visible:border-[var(--error)] focus-visible:ring-[var(--error)]/25",
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
