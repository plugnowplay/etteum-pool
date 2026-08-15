import * as React from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Minimal toast system. Replaces the per-page `message` state + inline
 * colored <div> pattern that differed on every page.
 *
 * Wrap the app once:  <ToastProvider>…</ToastProvider>
 * Then anywhere:      const toast = useToast(); toast.success("Saved");
 */
type ToastTone = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  /** ms; 0 keeps it until dismissed. */
  duration: number;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

const toneStyles: Record<ToastTone, { icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  success: {
    icon: CheckCircle2,
    cls: "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]",
  },
  error: {
    icon: XCircle,
    cls: "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]",
  },
  warning: {
    icon: AlertTriangle,
    cls: "border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]",
  },
  info: {
    icon: Info,
    cls: "border-[var(--info)]/30 bg-[var(--info)]/10 text-[var(--info)]",
  },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = React.useCallback(
    (message: string, tone: ToastTone = "info", duration = 3200) => {
      const id = nextId.current++;
      setItems((list) => [...list, { id, tone, message, duration }].slice(-4));
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss]
  );

  const api = React.useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (m, d) => show(m, "success", d),
      error: (m, d) => show(m, "error", d ?? 5000),
      warning: (m, d) => show(m, "warning", d ?? 4200),
      info: (m, d) => show(m, "info", d),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
        aria-live="polite"
        role="status"
      >
        {items.map((t) => {
          const { icon: Icon, cls } = toneStyles[t.tone];
          return (
            <div
              key={t.id}
              className={cn(
                "animate-slide-up pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-3",
                "shadow-[var(--es-3)] backdrop-blur-sm",
                cls
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-[var(--foreground)]">
                {t.message}
              </p>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="focus-ring -mr-1 -mt-0.5 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (ctx) return ctx;
  // Non-throwing fallback so a page can render outside the provider (tests).
  return {
    show: (m) => console.log("[toast]", m),
    success: (m) => console.log("[toast:success]", m),
    error: (m) => console.error("[toast:error]", m),
    warning: (m) => console.warn("[toast:warning]", m),
    info: (m) => console.log("[toast:info]", m),
    dismiss: () => {},
  };
}
