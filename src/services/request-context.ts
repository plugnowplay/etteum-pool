/**
 * Per-request context via AsyncLocalStorage — untuk carry api_key_id dari
 * middleware /v1/* sampai ke handler proxy yang deep di call graph,
 * tanpa ubah signature function existing.
 *
 * Usage:
 *   1. middleware set: requestContext.run({ apiKeyId }, next)
 *   2. handler baca:   const ctx = requestContext.getStore()
 *                      logEntry.apiKeyId = ctx?.apiKeyId ?? null
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScopeData {
  apiKeyId: number | null;
  apiKeyType: "master" | "managed" | null;
}

export const requestContext = new AsyncLocalStorage<RequestScopeData>();

export function getRequestApiKeyId(): number | null {
  return requestContext.getStore()?.apiKeyId ?? null;
}
