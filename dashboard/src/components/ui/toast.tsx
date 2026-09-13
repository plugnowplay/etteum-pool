import * as React from "react";
import { Toaster as SonnerToaster, toast as sonner } from "sonner";
import { useTheme } from "@/hooks/useTheme";

/**
 * Toast system — a thin adapter over `sonner`.
 *
 * The public API is intentionally identical to the previous hand-rolled
 * implementation, so every existing `const toast = useToast(); toast.success()`
 * call site keeps working untouched. Sonner gives us stacking, swipe-to-dismiss,
 * hover-to-pause, reduced-motion support, and SR announcements for free.
 */
type ToastTone = "success" | "error" | "warning" | "info";

interface ToastApi {
  show: (message: string, tone?: ToastTone, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  /** Kept for API compatibility. Omit the id to clear everything. */
  dismiss: (id?: number | string) => void;
  /** Tie a toast to a promise: loading → success/error automatically. */
  promise: <T>(
    promise: Promise<T>,
    msgs: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((err: unknown) => string);
    }
  ) => void;
}

/** `0` meant "sticky" in the old API; sonner spells that Infinity. */
function normalizeDuration(duration?: number): number | undefined {
  if (duration === undefined) return undefined;
  return duration === 0 ? Infinity : duration;
}

const api: ToastApi = {
  show: (message, tone = "info", duration) => api[tone](message, duration),
  success: (message, duration) =>
    void sonner.success(message, { duration: normalizeDuration(duration) }),
  error: (message, duration) =>
    void sonner.error(message, { duration: normalizeDuration(duration ?? 5000) }),
  warning: (message, duration) =>
    void sonner.warning(message, { duration: normalizeDuration(duration ?? 4200) }),
  info: (message, duration) =>
    void sonner.info(message, { duration: normalizeDuration(duration) }),
  dismiss: (id) => void sonner.dismiss(id),
  promise: (promise, msgs) => void sonner.promise(promise, msgs),
};

/**
 * Mounts the toast viewport. Still a provider component so `main.tsx` keeps its
 * shape, but there is no context anymore — the API is module-level.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();

  return (
    <>
      {children}
      <SonnerToaster
        position="bottom-right"
        theme={theme === "light" ? "light" : "dark"}
        closeButton
        richColors={false}
        gap={10}
        offset={20}
        duration={3200}
        toastOptions={{
          // Drive sonner entirely from our design tokens so toasts match the
          // Soft/Notion surfaces in both colour schemes.
          classNames: {
            toast:
              "!rounded-[var(--radius)] !border !border-[var(--border)] !bg-[var(--popover)] " +
              "!text-[var(--popover-foreground)] !shadow-[var(--es-3)] !text-sm",
            title: "!font-medium",
            description: "!text-[var(--muted-foreground)]",
            actionButton:
              "!rounded-md !bg-[var(--primary)] !text-[var(--primary-foreground)] !font-medium",
            cancelButton:
              "!rounded-md !bg-[var(--secondary)] !text-[var(--secondary-foreground)]",
            closeButton:
              "!border-[var(--border)] !bg-[var(--card)] !text-[var(--muted-foreground)]",
            success: "!text-[var(--success)]",
            error: "!text-[var(--error)]",
            warning: "!text-[var(--warning)]",
            info: "!text-[var(--info)]",
          },
        }}
      />
    </>
  );
}

/** Access the toast API. Safe to call from any component. */
export function useToast(): ToastApi {
  return api;
}

/** Imperative escape hatch for non-component code (api clients, handlers). */
export { api as toast };
