import { QueryClient } from "@tanstack/react-query";

/**
 * Shared QueryClient for the dashboard.
 *
 * Defaults are tuned for an ops dashboard that ALSO receives websocket pushes:
 * - `staleTime` is short but non-zero so navigating between pages reuses the
 *   cache instead of re-firing the same request (this is what removed the
 *   long runs of duplicate `GET /api/stats/requests` in the server log).
 * - No `refetchInterval` by default — the websocket invalidates queries when
 *   something actually changed, which beats blind polling.
 * - Retries are conservative: an infra dashboard should surface a failure fast
 *   rather than hammer a struggling backend.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * Centralised query keys. Keeping them in one place means websocket handlers
 * can invalidate precisely (`qk.requests()`) instead of nuking the whole cache.
 */
export const qk = {
  accounts: () => ["accounts"] as const,
  byokAccounts: () => ["accounts", "byok"] as const,
  combos: () => ["combos"] as const,
  models: () => ["models"] as const,
  settings: () => ["settings"] as const,
  providers: () => ["settings", "providers"] as const,
  filters: () => ["filters"] as const,
  keys: () => ["keys"] as const,
  managedKeys: () => ["keys", "managed"] as const,
  proxyPool: () => ["proxy-pool"] as const,
  authQueue: () => ["auth", "queue"] as const,
  authLogs: (limit: number) => ["auth", "logs", limit] as const,
  warmupSchedule: () => ["auth", "warmup-schedule"] as const,
  warmupQueue: () => ["accounts", "warmup-queue"] as const,
  requests: (page: number, limit: number, provider: string) =>
    ["requests", { page, limit, provider }] as const,
  requestDetail: (id: number) => ["requests", "detail", id] as const,
  stats: (hours: number | undefined, range: string | undefined) =>
    ["stats", { hours, range }] as const,
  modelUsage: (hours: number | undefined, range: string | undefined) =>
    ["stats", "models", { hours, range }] as const,
  usage: (hours: number, timeZone: string) =>
    ["stats", "usage", { hours, timeZone }] as const,
};
