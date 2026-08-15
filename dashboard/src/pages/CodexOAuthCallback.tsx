import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { completeCodexOAuth } from "@/lib/api";

type Status = "pending" | "success" | "error";

export default function CodexOAuthCallback() {
  const [message, setMessage] = useState("Completing Codex login...");
  const [done, setDone] = useState(false);
  // Presentation-only: drives the icon/tone. Never gates the OAuth flow.
  const [status, setStatus] = useState<Status>("pending");

  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  useEffect(() => {
    let active = true;

    async function run() {
      const code = params.get("code") || "";
      const state = params.get("state") || "";
      const error = params.get("error") || "";
      const errorDescription = params.get("error_description") || error;

      if (error) {
        setMessage(errorDescription || "OAuth login failed");
        setStatus("error");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: errorDescription || error, state }, window.location.origin);
        setDone(true);
        return;
      }

      if (!code || !state) {
        setMessage("Missing authorization code or state");
        setStatus("error");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: "Missing authorization code or state", state }, window.location.origin);
        setDone(true);
        return;
      }

      try {
        const result = await completeCodexOAuth({ code, state });
        if (!active) return;
        setMessage(`Connected as ${result.connection?.displayName || result.connection?.email || "Codex"}`);
        setStatus("success");
        window.opener?.postMessage({ type: "codex_oauth_result", success: true, state }, window.location.origin);
      } catch (error) {
        if (!active) return;
        const text = error instanceof Error ? error.message : String(error);
        setMessage(text);
        setStatus("error");
        window.opener?.postMessage({ type: "codex_oauth_result", success: false, error: text, state }, window.location.origin);
      } finally {
        if (active) setDone(true);
        setTimeout(() => window.close(), 1200);
      }
    }

    run();
    return () => {
      active = false;
    };
  }, [params]);

  const ring =
    status === "success"
      ? "bg-[var(--success)]/12 text-[var(--success)]"
      : status === "error"
        ? "bg-[var(--error)]/12 text-[var(--error)]"
        : "bg-[var(--info)]/12 text-[var(--info)]";
  const textTone =
    status === "success" ? "text-[var(--success)]" : "text-[var(--error)]";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6">
      <Card className="animate-scale-in w-full max-w-md shadow-[var(--es-3)]">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <span
            className={`flex h-12 w-12 items-center justify-center rounded-full ${ring}`}
          >
            {status === "pending" ? (
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
            ) : status === "success" ? (
              <CheckCircle2 className="h-6 w-6" aria-hidden />
            ) : (
              <XCircle className="h-6 w-6" aria-hidden />
            )}
          </span>

          <h1 className="text-base font-semibold tracking-tight text-[var(--foreground)]">
            Codex Login
          </h1>

          {status === "pending" ? (
            <div className="w-full space-y-2" role="status" aria-live="polite">
              <p className="text-xs text-[var(--muted-foreground)]">{message}</p>
              <Skeleton className="mx-auto h-3 w-48" />
              <Skeleton className="mx-auto h-3 w-32" />
            </div>
          ) : (
            <p
              className={`break-words text-sm leading-relaxed ${textTone}`}
              role="status"
              aria-live="polite"
            >
              {message}
            </p>
          )}

          {done && (
            <p className="text-[11px] text-[var(--muted-foreground)]">
              You can close this window.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
