import { useQueryClient } from "@tanstack/react-query";
import { useWsEvent } from "@/hooks/useWebSocket";
import { qk } from "@/lib/queryClient";

/**
 * Bridges websocket events to React Query cache invalidation.
 *
 * Previously every page ran its own `setTimeout` + refetch loop, which is why
 * the backend log showed the same endpoint being hit over and over. Now the
 * socket is the single source of "something changed", and React Query decides
 * whether an actual network call is needed (deduped, cached, and only for
 * queries that are currently mounted).
 *
 * Mount this ONCE, inside both the QueryClientProvider and WebSocketProvider.
 */
export function WsQuerySync() {
  const qc = useQueryClient();

  // Request traffic → the requests list plus every stats aggregate.
  useWsEvent(["request_log", "request_error"], () => {
    qc.invalidateQueries({ queryKey: ["requests"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
  });

  // Anything that mutates the account pool.
  useWsEvent(
    [
      "account_status",
      "account_updated",
      "account_created",
      "account_deleted",
      "accounts_updated",
      "accounts_bulk_created",
      "provider_toggled",
    ],
    () => {
      qc.invalidateQueries({ queryKey: qk.accounts() });
      qc.invalidateQueries({ queryKey: qk.providers() });
      qc.invalidateQueries({ queryKey: ["stats"] });
    }
  );

  // Auth / warm-up bot activity.
  useWsEvent(["auth_log", "auth_queue", "warmup_log", "warmup_queue"], () => {
    qc.invalidateQueries({ queryKey: ["auth"] });
    qc.invalidateQueries({ queryKey: qk.warmupQueue() });
  });

  // Proxy pool edits made from another tab / the API.
  useWsEvent(["proxy_pool_updated", "proxy_status"], () => {
    qc.invalidateQueries({ queryKey: qk.proxyPool() });
  });

  return null;
}
