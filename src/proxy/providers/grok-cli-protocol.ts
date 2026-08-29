import { createHash } from "node:crypto";

/**
 * Grok Build wire contract ported from chenyme/grok2api v3.1.5
 * (backend/internal/infra/provider/cli/{adapter,normalize,fallback,responses_reasoning_recovery}.go).
 *
 * Keep this file protocol-only: no Account, no fetch, no provider class.
 */

export const GROK_CLI_XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

const UUID_NAMESPACE_URL = Uint8Array.from([
  0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1,
  0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASONING_DECODE_MARKERS = [
  "could not decode the compaction blob",
  "could not decrypt the provided encrypted_content",
] as const;

export interface GrokCliInferenceHeaderInput {
  readonly accessToken: string;
  readonly agentId: string;
  readonly model?: string;
  readonly promptCacheKey?: string;
  readonly userId?: string;
  readonly requestId?: string;
  readonly turnIndex?: string;
}

/**
 * Stable x-grok-session-id from a prompt-cache key.
 * Empty key → no session (stateless). A UUID key is used as-is.
 * Otherwise UUID v8 hashed with the URL namespace, matching grok2api.
 */
export function grokCliSessionId(promptCacheKey: string | undefined): string | null {
  const key = promptCacheKey?.trim() ?? "";
  if (!key) return null;
  if (UUID_RE.test(key)) return key.toLowerCase();

  const digest = createHash("sha256")
    .update(UUID_NAMESPACE_URL)
    .update(`grok2api:session:${key}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function normalizeGrokTurnIndex(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || raw.length > 20) return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    BigInt(raw);
  } catch {
    return null;
  }
  return raw;
}

export function grokCliInferenceHeaders(
  input: GrokCliInferenceHeaderInput,
  constants: {
    readonly userAgent: string;
    readonly clientVersion: string;
    readonly clientIdentifier: string;
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.accessToken}`,
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
    "User-Agent": constants.userAgent,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": constants.clientVersion,
    "x-grok-client-identifier": constants.clientIdentifier,
    "x-grok-client-mode": "headless",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-agent-id": input.agentId,
    "x-grok-req-id": input.requestId ?? crypto.randomUUID(),
  };

  const sessionId = grokCliSessionId(input.promptCacheKey);
  if (sessionId) {
    headers["x-grok-session-id"] = sessionId;
    headers["x-grok-conv-id"] = sessionId;
    const turn = normalizeGrokTurnIndex(input.turnIndex);
    if (turn) headers["x-grok-turn-idx"] = turn;
  }

  if (input.userId) headers["x-grok-user-id"] = input.userId;
  if (input.model) headers["x-grok-model-override"] = input.model;

  const traceId = randomHex(16);
  const spanId = randomHex(8);
  headers.traceparent = `00-${traceId}-${spanId}-01`;

  return headers;
}

export function applyGrokCliResponseDefaults(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  if (next.store === undefined || next.store === null) next.store = false;

  const include = Array.isArray(next.include) ? [...next.include] : [];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
  }
  next.include = include;

  const reasoning = asRecord(next.reasoning);
  if (reasoning && (reasoning.summary === undefined || reasoning.summary === null)) {
    next.reasoning = { ...reasoning, summary: "concise" };
  }

  return next;
}

export function isReasoningDecodeFailure(body: string): boolean {
  const lower = body.toLowerCase();
  return REASONING_DECODE_MARKERS.some((marker) => lower.includes(marker));
}

export function shouldSkipXaiFallback(body: string): boolean {
  const lower = body.toLowerCase();
  if (lower.includes("blocked-user") || lower.includes("user is blocked")) return true;
  if (lower.includes("content violates usage guidelines")) return true;
  if (lower.includes("safety_check_type_")) return true;
  return false;
}

/**
 * Drop opaque reasoning ciphertext so a 400 decode failure can retry in-session.
 * Returns null when nothing changed.
 */
export function stripReasoningEncryptedContent(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return null;

  let changed = false;
  const rebuilt: unknown[] = [];
  for (const raw of input) {
    const item = asRecord(raw);
    if (!item || item.type !== "reasoning") {
      rebuilt.push(raw);
      continue;
    }
    const encrypted = item.encrypted_content;
    if (typeof encrypted !== "string" || encrypted.trim() === "") {
      rebuilt.push(raw);
      continue;
    }
    changed = true;
    const cleaned: Record<string, unknown> = { ...item };
    delete cleaned.encrypted_content;
    delete cleaned.id;
    delete cleaned.status;
    if (hasReadableReasoning(cleaned)) rebuilt.push(cleaned);
  }
  if (!changed) return null;
  return { ...body, input: rebuilt };
}

function hasReadableReasoning(item: Record<string, unknown>): boolean {
  for (const field of ["summary", "content"] as const) {
    const parts = item[field];
    if (!Array.isArray(parts)) continue;
    for (const raw of parts) {
      const part = asRecord(raw);
      if (part && typeof part.text === "string" && part.text.trim() !== "") return true;
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}
