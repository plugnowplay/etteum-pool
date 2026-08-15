import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { decrypt, encrypt } from "../../utils/crypto";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { eq } from "drizzle-orm";
import { pool } from "../pool";

// Logger dari hono — tersedia di semua service
import { logger } from "hono/logger";

// ============================================================================
// Grok CLI Provider — Grok Build (cli-chat-proxy.grok.com)
//
// Source of truth: wire capture of official @xai-official/grok 0.2.99
// talking to https://cli-chat-proxy.grok.com (OpenAI Responses API).
//
// Distinct from `grok` (api.x.ai — API key, Chat Completions):
//   - Endpoint:  cli-chat-proxy.grok.com/v1/responses  (NOT /chat/completions)
//   - Auth:      OAuth device-code access token (NOT API key)
//   - Format:    OpenAI Responses API (input[], instructions) (NOT messages[])
//   - Models:    grok-build, grok-4.5*, grok-4.6*  (500K context!)
//   - Streaming: forced SSE (always stream=true)
//   - Headers:   x-grok-client-identifier, x-grok-client-version, x-grok-turn-idx, etc.
//
// Auth flow:
//   1. POST auth.x.ai/oauth2/device/code → device_code + user verification URL
//   2. User visits URL, enters code, approves
//   3. POST auth.x.ai/oauth2/token (grant_type=device_code) → access_token + refresh_token
//   4. Token stored in account.tokens (encrypted at rest via password field)
//   5. Auto-refresh 5 min before expiry via refreshToken()
// ============================================================================

const GROK_CLI_BASE = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_RESPONSES_URL = `${GROK_CLI_BASE}/responses`;
const GROK_CLI_MODELS_URL = `${GROK_CLI_BASE}/models`;
const GROK_CLI_USER_URL = `${GROK_CLI_BASE}/user`;
const GROK_CLI_BILLING_URL = `${GROK_CLI_BASE}/billing`;

const GROK_CLI_VERSION = "0.2.99";
const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

// OAuth config (same client_id as xAI, different scope + referrer)
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

// Refresh token 5 minutes before expiry
const REFRESH_LEAD_MS = 5 * 60 * 1000;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];

// ── Plenger probe ─────────────────────────────────────────────────────────
// On-demand account validation probe (adapted from plugnowplay/9router).
// Before serving a chat request, we send a control prompt asking the model to
// reply with exactly "407". If it does → account is valid. If it returns
// anything else → account is flagged (plenger) and disabled for 5 hours.
// Transport/upstream errors never become plenger — only a wrong answer does.

const PLENGER_PROMPT = "reply exactly with number : 407";
const PLENGER_EXPECTED = "407";
const PLENGER_DISABLE_MS = 5 * 60 * 60 * 1000; // 5 hours
const PLENGER_PROBE_TIMEOUT_MS = 90_000;
const PLENGER_PROBE_MODEL = "grok-4.6";

interface PlengerMeta {
  plenger?: boolean;
  plengerCheckedAt?: string;
  plengerProbeAnswer?: string;
  plengerDisabledUntil?: string;
}

function getPlengerMeta(account: Account): PlengerMeta {
  const raw = account.metadata;
  if (!raw) return {};
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return (obj || {}) as PlengerMeta;
  } catch {
    return {};
  }
}

function isPlengerActive(account: Account, now = Date.now()): boolean {
  const meta = getPlengerMeta(account);
  if (meta.plenger !== true) return false;
  const until = Date.parse(meta.plengerDisabledUntil || "");
  return Number.isFinite(until) && until > now;
}

/** Parse SSE stream text from Responses API and return final answer text. */
function finalTextFromSse(raw: string): string {
  const deltas: string[] = [];
  let doneText: string | null = null;
  let completedText: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    if (event.type === "response.output_text.delta") {
      deltas.push(event.delta || "");
    } else if (event.type === "response.output_text.done") {
      doneText = event.text;
    } else if (event.type === "response.completed" || event.type === "response.done") {
      const texts: string[] = [];
      for (const item of event.response?.output || []) {
        for (const part of item?.content || []) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            texts.push(part.text);
          }
        }
      }
      if (texts.length) completedText = texts.join("");
    }
  }

  return String(completedText ?? doneText ?? deltas.join("")).trim();
}

/** Dedup inflight probes per account id */
const plengerInflight = new Map<number, Promise<PlengerProbeResult>>();

interface PlengerProbeResult {
  status: "valid" | "plenger" | "error";
  answer?: string;
  disabledUntil?: string;
  error?: string;
}

interface GrokCliModelDef {
  /** Proxy-facing id (gcli-*) */
  id: string;
  /** Real upstream id passed in the request body */
  upstream: string;
  context_window: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
  /** USD cost per 1k tokens — used for credit accounting (estimated). */
  creditRate: number;
}

/**
 * Curated catalog of Grok CLI / Grok Build models.
 *
 * The cli-chat-proxy endpoint exposes grok-build (500K context!) and
 * grok-4.5 variants with reasoning effort support.
 *
 * Pricing (per M tokens, input/output blended for creditRate estimate):
 *   grok-build:    subscription credits (not per-token) → $0 estimated
 *   grok-4.5:      $3.00 / $15.00 → avg ≈ $0.009 / 1k
 *   grok-4.6:      $3.00 / $15.00 → avg ≈ $0.009 / 1k
 */
const GROK_CLI_MODELS: GrokCliModelDef[] = [
  {
    id: "gcli-build",
    upstream: "grok-build",
    context_window: 500000,
    max_output: 64000,
    thinking: false,
    vision: false,
    creditRate: 0,
  },
  {
    id: "gcli-4.6",
    upstream: "grok-4.6",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.6-high",
    upstream: "grok-4.6",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.6-medium",
    upstream: "grok-4.6",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.6-low",
    upstream: "grok-4.6",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.5",
    upstream: "grok-4.5",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: false,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.5-high",
    upstream: "grok-4.5",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: false,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.5-medium",
    upstream: "grok-4.5",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: false,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gcli-4.5-low",
    upstream: "grok-4.5",
    context_window: 500000,
    max_output: 64000,
    thinking: true,
    vision: false,
    creditRate: 0.009 / 1000,
  },
];

export const MODEL_BY_ID: Record<string, GrokCliModelDef> = Object.fromEntries(
  GROK_CLI_MODELS.map((m) => [m.id, m]),
);

// Allowlist of fields accepted by cli-chat-proxy Responses API
const RESPONSES_API_ALLOWLIST = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "metadata",
  "prompt_cache_key",
]);

// ── Token helpers ──────────────────────────────────────────────────────────

interface GrokCliTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at?: string; // ISO string
  email?: string;
  user_id?: string;
  subscription_tier?: string;
}

/**
 * Parse and decrypt tokens from the account's tokens field.
 * The tokens are stored as JSON in the `tokens` column (encrypted at rest
 * via the `password` field which holds the XOR key).
 */
function getTokens(account: Account): GrokCliTokens | null {
  if (!account.tokens) return null;
  try {
    const raw = typeof account.tokens === "string"
      ? JSON.parse(account.tokens as string)
      : account.tokens;
    return raw as GrokCliTokens;
  } catch {
    return null;
  }
}

/**
 * Check if the access token is expired or about to expire (within REFRESH_LEAD_MS).
 */
function isTokenExpiring(tokens: GrokCliTokens, now = Date.now()): boolean {
  if (!tokens.expires_at) return false; // no expiry info → assume valid
  const expiresAtMs = new Date(tokens.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - now < REFRESH_LEAD_MS;
}

// ── Responses API conversion ───────────────────────────────────────────────

/**
 * Convert Chat Completions messages[] to Responses API input[].
 *
 * Responses API uses a flat array of typed items:
 *   - { type: "message", role: "user|assistant|system", content: [{type:"input_text", text}] }
 *   - { type: "function_call", call_id, name, arguments }
 *   - { type: "function_call_output", call_id, output }
 *   - { type: "reasoning", id, encrypted_content } (passthrough only)
 *
 * System messages → extracted as `instructions` field (separate from input[]).
 */
function messagesToResponsesInput(messages: ChatMessage[]): {
  instructions: string | undefined;
  input: any[];
} {
  const input: any[] = [];
  const systemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : contentBlocksToText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      // Tool results → function_call_output items
      const callId = msg.tool_call_id || "";
      const output = typeof msg.content === "string"
        ? msg.content
        : contentBlocksToText(msg.content);
      input.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
      continue;
    }

    // User or assistant message
    const textParts: string[] = [];
    const toolCalls: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const b of msg.content as any[]) {
        if (!b || typeof b !== "object") continue;

        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
          continue;
        }

        if (b.type === "tool_use") {
          toolCalls.push({
            type: "function_call",
            call_id: b.id || `call_${toolCalls.length}`,
            name: b.name || "",
            arguments: typeof b.input === "string"
              ? b.input
              : JSON.stringify(b.input || {}),
          });
          continue;
        }

        if (b.type === "tool_result") {
          input.push({
            type: "function_call_output",
            call_id: b.tool_use_id || b.id || "",
            output: contentBlocksToText(b.content),
          });
          continue;
        }

        // Drop thinking/image blocks — Responses API handles them differently
        if (b.type === "thinking" || b.type === "redacted_thinking") continue;
        if (b.type === "image" || b.type === "image_url") continue;

        // Unknown block — coerce to text
        if (typeof b.text === "string") textParts.push(b.text);
      }
    } else if (typeof msg.content === "string") {
      textParts.push(msg.content);
    }

    // Assistant tool calls → emit function_call items
    if (msg.role === "assistant" && toolCalls.length > 0) {
      // If there's text, emit it as a message first
      const text = textParts.join("\n");
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      input.push(...toolCalls);
      continue;
    }

    // Regular message
    const text = textParts.join("\n");
    if (text || msg.role === "user") {
      input.push({
        type: "message",
        role: msg.role,
        content: [{
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text: text || " ",
        }],
      });
    }
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    input,
  };
}

/** Collapse mixed content blocks down to a single string. */
function contentBlocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "tool_result") return contentBlocksToText(b.content);
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Convert Anthropic-style tools to Responses API function tools.
 * Responses API uses: { type: "function", name, description, parameters }
 */
function normalizeToolsForResponses(tools: any[]): any[] {
  return tools
    .map((t) => {
      // Already in Responses format
      if (t?.type === "function" && t.name) {
        return {
          type: "function",
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || t.input_schema || { type: "object", properties: {} },
        };
      }
      // OpenAI Chat format
      if (t?.type === "function" && t.function?.name) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object", properties: {} },
        };
      }
      // Anthropic format
      if (t?.name) {
        return {
          type: "function",
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
        };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Parse the Responses API SSE stream and convert to OpenAI Chat Completions
 * chunk format so the proxy can pass it through to clients.
 *
 * Responses API SSE events:
 *   - response.output_item.added
 *   - response.output_text.delta
 *   - response.output_text.done
 *   - response.function_call_arguments.delta
 *   - response.function_call_arguments.done
 *   - response.completed
 *   - response.usage
 *   - error
 */
function responsesStreamToChatStream(
  upstream: ReadableStream<Uint8Array>,
  originalModel: string,
): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishEmitted = false;
      let currentToolCallId: string | null = null;
      let currentToolCallName: string | null = null;
      let toolCallIndex = 0;

      const makeChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null = null,
      ) => {
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: originalModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              if (!finishEmitted) {
                makeChunk({}, "stop");
                finishEmitted = true;
              }
              continue;
            }

            let event: any;
            try {
              event = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const eventType = event.type || "";

            // Text delta
            if (eventType === "response.output_text.delta") {
              const text = event.delta || "";
              if (text) makeChunk({ content: text });
              continue;
            }

            // Function call arguments delta
            if (eventType === "response.function_call_arguments.delta") {
              const args = event.delta || "";
              if (args && currentToolCallId) {
                makeChunk({
                  tool_calls: [{
                    index: toolCallIndex,
                    id: currentToolCallId,
                    function: { arguments: args },
                  }],
                });
              }
              continue;
            }

            // Output item added — detect function calls
            if (eventType === "response.output_item.added") {
              const item = event.item;
              if (item?.type === "function_call") {
                currentToolCallId = item.call_id || `call_${toolCallIndex}`;
                currentToolCallName = item.name || "";
                makeChunk({
                  tool_calls: [{
                    index: toolCallIndex,
                    id: currentToolCallId,
                    type: "function",
                    function: {
                      name: currentToolCallName,
                      arguments: "",
                    },
                  }],
                });
                toolCallIndex++;
              }
              continue;
            }

            // Function call arguments done
            if (eventType === "response.function_call_arguments.done") {
              currentToolCallId = null;
              currentToolCallName = null;
              continue;
            }

            // Response completed
            if (eventType === "response.completed" || eventType === "response.done") {
              if (!finishEmitted) {
                // Check if we have tool calls → finish_reason should be "tool_calls"
                const finishReason = toolCallIndex > 0 ? "tool_calls" : "stop";
                makeChunk({}, finishReason);
                finishEmitted = true;
              }
              // Emit usage if present
              if (event.response?.usage || event.usage) {
                const usage = event.response?.usage || event.usage;
                const usageChunk = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: originalModel,
                  choices: [],
                  usage: {
                    prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
                    completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
                    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                  },
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
              }
              continue;
            }

            // Error event
            if (eventType === "error" || eventType === "response.failed") {
              const errorMsg = event.error?.message || event.message || "Upstream error";
              makeChunk({ content: `\n[Error: ${errorMsg}]` }, "stop");
              finishEmitted = true;
              continue;
            }
          }
        }

        if (!finishEmitted) {
          makeChunk({}, "stop");
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: originalModel,
          choices: [{
            index: 0,
            delta: { content: `\n[Stream error: ${errorMsg}]` },
            finish_reason: "stop",
          }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Parse a non-streaming Responses API response and convert to Chat Completions format.
 */
function responsesToChatCompletion(data: any, originalModel: string): ChatCompletionResponse {
  const output = data.output || [];
  let textContent = "";
  const toolCalls: any[] = [];

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block.type === "output_text" && typeof block.text === "string") {
          textContent += block.text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments || "{}",
        },
      });
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  const usage = data.usage || {};

  return {
    id: data.id || `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

// ── Provider ───────────────────────────────────────────────────────────────

export class GrokCliProvider extends BaseProvider {
  name = "grok-cli";
  alias = "gcli";

  /**
   * Native wire format. Grok CLI uses OpenAI Responses API which we translate
   * to/from Chat Completions for the proxy surface.
   */
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("gcli-");
  }

  supportedModels: ModelInfo[] = GROK_CLI_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "grok-cli",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "token" as const,
    creditRate: m.creditRate,
    creditSource: "estimated" as const,
  }));

  // ── Helpers ─────────────────────────────────────────────────────────

  private resolveModel(model: string): GrokCliModelDef | null {
    return MODEL_BY_ID[model.toLowerCase()] ?? null;
  }

  private getAccessToken(account: Account): string {
    const tokens = getTokens(account);
    return tokens?.access_token || "";
  }

  /**
   * Build the headers required by cli-chat-proxy.grok.com.
   * These mirror the official @xai-official/grok CLI wire format.
   */
  private buildHeaders(account: Account, model?: string): Record<string, string> {
    const accessToken = this.getAccessToken(account);
    const tokens = getTokens(account);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
      "User-Agent": GROK_CLI_USER_AGENT,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
      "x-grok-client-mode": "headless",
    };

    // Identity headers — surface email/userId from tokens
    const email = tokens?.email;
    const userId = tokens?.user_id;
    if (email) headers["x-email"] = email;
    if (userId) headers["x-userid"] = userId;

    // Session/turn tracking — use random UUIDs per request
    // (the official CLI uses persistent session IDs, but per-request is safe
    // for a proxy that serves multiple clients)
    const sessionId = crypto.randomUUID();
    headers["x-grok-session-id"] = sessionId;
    headers["x-grok-conv-id"] = sessionId;
    headers["x-grok-req-id"] = crypto.randomUUID();
    headers["x-grok-turn-idx"] = "1";

    // Model override
    if (model) headers["x-grok-model-override"] = model;

    return headers;
  }

  /**
   * Build the Responses API request body from a Chat Completions request.
   */
  private toResponsesBody(request: ChatCompletionRequest, def: GrokCliModelDef): any {
    const { instructions, input } = messagesToResponsesInput(request.messages);

    const body: any = {
      model: def.upstream,
      input,
      stream: true, // cli-chat-proxy forces streaming
      store: false,
    };

    if (instructions) body.instructions = instructions;

    // Reasoning effort for grok-4.5*
    if (def.thinking) {
      const effort = this.resolveEffort(request, def);
      if (effort) {
        body.reasoning = { effort };
      }
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = normalizeToolsForResponses(request.tools);
    }
    if (request.tool_choice !== undefined) {
      body.tool_choice = request.tool_choice;
    }

    // Max output tokens
    if (request.max_tokens !== undefined) {
      body.max_output_tokens = Math.min(request.max_tokens, def.max_output);
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    // Filter to allowlist only
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }

  /**
   * Resolve reasoning effort from request or model id.
   * Model ids like "gcli-4.5-high" embed the effort level.
   */
  private resolveEffort(
    request: ChatCompletionRequest,
    def: GrokCliModelDef,
  ): string | null {
    // Check explicit request.thinking.effort
    if (request.thinking?.effort) {
      const effort = request.thinking.effort.toLowerCase();
      if (effort === "max") return "xhigh";
      if (EFFORT_LEVELS.includes(effort)) return effort;
    }

    // Check model id suffix (e.g. gcli-4.5-high → "high")
    for (const level of EFFORT_LEVELS) {
      if (def.id.endsWith(`-${level}`)) return level;
    }

    // Default for thinking models
    return "high";
  }

  /**
   * Handle upstream error responses.
   */
  private async handleErrorResponse(
    resp: Response,
  ): Promise<ProviderResult | null> {
    if (resp.ok) return null;

    const text = await resp.text().catch(() => "");

    if (resp.status === 401 || resp.status === 403) {
      return {
        success: false,
        error: `expired: Grok CLI token invalid or expired (HTTP ${resp.status})`,
      };
    }

    if (resp.status === 429) {
      return {
        success: false,
        error: `Rate limited by Grok CLI (HTTP 429): ${text.slice(0, 160)}`,
        rateLimited: true,
      };
    }

    if (resp.status === 402) {
      return {
        success: false,
        error: `Grok Build credits exhausted (HTTP 402): ${text.slice(0, 160)}`,
        quotaExhausted: true,
      };
    }

    return {
      success: false,
      error: `Grok CLI error (HTTP ${resp.status}): ${text.slice(0, 200)}`,
    };
  }

  // ── Plenger probe ──────────────────────────────────────────────────

  /**
   * On-demand plenger probe. Sends a control prompt ("reply exactly with
   * number : 407") to cli-chat-proxy.grok.com. If the answer is "407" the
   * account is valid. Otherwise the account is flagged plenger and disabled
   * for 5 hours. Transport/upstream errors never become plenger.
   *
   * Result is cached in account.metadata and persisted to DB.
   * Inflight dedup: concurrent calls for the same account share one probe.
   */
  async checkGrokCliPlenger(account: Account): Promise<PlengerProbeResult> {
    const accountId = account.id;
    if (!accountId) return { status: "error", error: "missing account id" };

    // Return cached result if still active
    if (isPlengerActive(account)) {
      const meta = getPlengerMeta(account);
      return {
        status: "plenger",
        cached: true as any,
        disabledUntil: meta.plengerDisabledUntil,
      } as PlengerProbeResult;
    }

    // Dedup inflight probes
    if (plengerInflight.has(accountId)) {
      return plengerInflight.get(accountId)!;
    }

    const promise = this._runPlengerProbe(account).finally(() =>
      plengerInflight.delete(accountId),
    );
    plengerInflight.set(accountId, promise);
    return promise;
  }

  private async checkGrokCliPlenger(account: Account): Promise<PlengerProbeResult> {
    const accountId = account.id;
    if (!accountId) return { status: "error", error: "missing account id" };

    // Return cached result if still active
    if (isPlengerActive(account)) {
      const meta = getPlengerMeta(account);
      return {
        status: "plenger",
        cached: true as any,
        disabledUntil: meta.plengerDisabledUntil,
      } as PlengerProbeResult;
    }

    // Dedup inflight probes
    if (plengerInflight.has(accountId)) {
      return plengerInflight.get(accountId)!;
    }

    const promise = this._runPlengerProbe(account).finally(() =>
      plengerInflight.delete(accountId),
    );
    plengerInflight.set(accountId, promise);
    return promise;
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Grok CLI model: ${request.model}` };

    const accessToken = this.getAccessToken(account);
    if (!accessToken) return { success: false, error: "No access token" };

    // Check plenger probe before serving (DISABLED)
    // const plengerResult = await this.checkGrokCliPlenger(account);
    // if (plengerResult.status === "plenger") {
    //   return {
    //     success: false,
    //     error: `Account disabled by plenger probe (until ${plengerResult.disabledUntil})`,
    //   };
    // }
    // if (plengerResult.status === "error") {
    //   // Transport errors don't block the account
    //   logger.log("PLENGER", `${account.email}: plenger probe failed but not disabling: ${plengerResult.error}`);
    // }

    // cli-chat-proxy forces streaming, so we make a streaming request and
    // aggregate the full response.
    const body = this.toResponsesBody(request, def);
    const headers = this.buildHeaders(account, def.upstream);

    try {
      const resp = await this.fetchWithTimeout(GROK_CLI_RESPONSES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp);
      if (errResult) return errResult;

      // Read the full SSE stream and aggregate
      const fullText = await this.aggregateStream(resp, def.upstream);
      return fullText;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Run the actual plenger probe with timeout and SSE parsing */
  private async _runPlengerProbe(account: Account): Promise<PlengerProbeResult> {
    const accessToken = this.getAccessToken(account);
    if (!accessToken) return { status: "error", error: "No access token" };

    const sessionId = crypto.randomUUID();
    const body = {
      model: PLENGER_PROBE_MODEL,
      input: [{ type: "message", role: "user", content: PLENGER_PROMPT }],
      stream: true,
      store: false,
      reasoning: { summary: "concise", effort: "low" },
      max_output_tokens: 512,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
      "User-Agent": GROK_CLI_USER_AGENT,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
      "x-grok-client-mode": "headless",
      "x-grok-session-id": sessionId,
      "x-grok-conv-id": sessionId,
      "x-grok-req-id": crypto.randomUUID(),
      "x-grok-turn-idx": "1",
      "x-grok-model-override": PLENGER_PROBE_MODEL,
    };

    const tokens = getTokens(account);
    if (tokens?.email) headers["x-email"] = tokens.email;
    if (tokens?.user_id) headers["x-userid"] = String(tokens.user_id);

    try {
      const resp = await this.fetchWithTimeout(
        GROK_CLI_RESPONSES_URL,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        PLENGER_PROBE_TIMEOUT_MS,
      );

      const raw = await resp.text();

      if (!resp.ok) {
        // Transport/upstream errors never become plenger
        return {
          status: "error",
          error: `HTTP ${resp.status}: ${raw.slice(0, 300)}`,
        };
      }

      const answer = finalTextFromSse(raw);
      const checkedAt = new Date().toISOString();

      if (answer === PLENGER_EXPECTED) {
        // Account is valid — clear plenger flag
        await pool.updateMetadata(account.id, {
          plenger: false,
          plengerCheckedAt: checkedAt,
          plengerProbeAnswer: answer,
          plengerDisabledUntil: null,
        });
        return { status: "valid", answer };
      }

      // Account is plenger — disable for 5 hours
      const until = new Date(Date.now() + PLENGER_DISABLE_MS).toISOString();
      await pool.updateMetadata(account.id, {
        plenger: true,
        plengerCheckedAt: checkedAt,
        plengerProbeAnswer: answer,
        plengerDisabledUntil: until,
      });
      return { status: "plenger", answer, disabledUntil: until };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Read the SSE stream from cli-chat-proxy and aggregate into a single
   * ChatCompletionResponse.
   */
  private async aggregateStream(
    resp: Response,
    originalModel: string,
  ): Promise<ProviderResult> {
    if (!resp.body) {
      return { success: false, error: "No response body from Grok CLI" };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textContent = "";
    const toolCalls: any[] = [];
    let usage: any = null;
    let currentToolCallId: string | null = null;
    let currentToolCallName: string | null = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") continue;

          let event: any;
          try {
            event = JSON.parse(dataStr);
          } catch {
            continue;
          }

          const eventType = event.type || "";

          if (eventType === "response.output_text.delta") {
            textContent += event.delta || "";
          } else if (eventType === "response.output_item.added") {
            const item = event.item;
            if (item?.type === "function_call") {
              currentToolCallId = item.call_id || `call_${toolCalls.length}`;
              currentToolCallName = item.name || "";
              toolCalls.push({
                id: currentToolCallId,
                type: "function",
                function: { name: currentToolCallName, arguments: "" },
              });
            }
          } else if (eventType === "response.function_call_arguments.delta") {
            if (currentToolCallId && toolCalls.length > 0) {
              toolCalls[toolCalls.length - 1].function.arguments += event.delta || "";
            }
          } else if (eventType === "response.function_call_arguments.done") {
            currentToolCallId = null;
            currentToolCallName = null;
          } else if (eventType === "response.completed" || eventType === "response.done") {
            usage = event.response?.usage || event.usage || null;
          }
        }
      }
    } catch (err) {
      return {
        success: false,
        error: `Stream read error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    const response: ChatCompletionResponse = {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: usage?.input_tokens || 0,
        completion_tokens: usage?.output_tokens || 0,
        total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
      },
    };

    return {
      success: true,
      response,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      creditsUsed: 0, // subscription credits, not per-token
    };
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Grok CLI model: ${request.model}` };

    const accessToken = this.getAccessToken(account);
    if (!accessToken) return { success: false, error: "No access token" };

    // Check plenger probe before serving (DISABLED)
    // const plengerResult = await this.checkGrokCliPlenger(account);
    // if (plengerResult.status === "plenger") {
    //   return {
    //     success: false,
    //     error: `Account disabled by plenger probe (until ${plengerResult.disabledUntil})`,
    //   };
    // }
    // if (plengerResult.status === "error") {
    //   logger.log("PLENGER", `${account.email}: plenger probe failed but not disabling: ${plengerResult.error}`);
    // }

    const body = this.toResponsesBody(request, def);
    const headers = this.buildHeaders(account, def.upstream);

    try {
      const resp = await this.fetchWithTimeout(GROK_CLI_RESPONSES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp);
      if (errResult) return errResult;

      if (!resp.body) {
        return { success: false, error: "No response body from Grok CLI" };
      }

      const stream = responsesStreamToChatStream(resp.body, def.upstream);

      return {
        success: true,
        stream,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Refresh the OAuth access token using the refresh token.
   * xAI issues a new refresh_token on every refresh (rotating refresh tokens).
   */
  async refreshToken(account: Account): Promise<{
    success: boolean;
    tokens?: string;
    error?: string;
  }> {
    const tokens = getTokens(account);
    if (!tokens?.refresh_token) {
      return { success: false, error: "No refresh token" };
    }

    try {
      const resp = await fetch(XAI_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": GROK_CLI_USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: XAI_OAUTH_CLIENT_ID,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const isInvalidGrant = text.includes("invalid_grant") || text.includes("invalid_request");
        return {
          success: false,
          error: isInvalidGrant
            ? `expired: Refresh token invalid or expired`
            : `Token refresh failed (HTTP ${resp.status}): ${text.slice(0, 160)}`,
        };
      }

      const data = await resp.json() as any;

      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined;

      const newTokens: GrokCliTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || tokens.refresh_token,
        id_token: data.id_token || tokens.id_token,
        expires_at: expiresAt,
        email: tokens.email,
        user_id: tokens.user_id,
        subscription_tier: tokens.subscription_tier,
      };

      return {
        success: true,
        tokens: JSON.stringify(newTokens),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = getTokens(account);
    return !!tokens?.access_token;
  }

  /**
   * Probe the billing endpoint for credit/subscription status.
   * Also checks user endpoint for subscription info.
   */
  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const accessToken = this.getAccessToken(account);
    if (!accessToken) return { success: false, error: "No access token" };

    try {
      // Probe 1 — billing/credits
      const billingResp = await this.fetchWithTimeout(
        `${GROK_CLI_BILLING_URL}?format=credits`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "User-Agent": GROK_CLI_USER_AGENT,
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": GROK_CLI_VERSION,
            "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
          },
        },
      );

      if (billingResp.status === 401 || billingResp.status === 403) {
        return { success: false, error: `expired: HTTP ${billingResp.status}` };
      }

      if (!billingResp.ok) {
        // Billing might not be available for all accounts — fall back to models probe
        const modelsResp = await this.fetchWithTimeout(GROK_CLI_MODELS_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "User-Agent": GROK_CLI_USER_AGENT,
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": GROK_CLI_VERSION,
            "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
          },
        });

        if (modelsResp.status === 401 || modelsResp.status === 403) {
          return { success: false, error: `expired: HTTP ${modelsResp.status}` };
        }
        if (!modelsResp.ok) {
          const text = await modelsResp.text().catch(() => "");
          return { success: false, error: `Grok CLI quota probe HTTP ${modelsResp.status}: ${text.slice(0, 160)}` };
        }
        await modelsResp.text().catch(() => "");
        return {
          success: true,
          quota: { limit: -1, remaining: -1, used: 0, resetAt: null },
        };
      }

      // Parse billing data
      const billingData = await billingResp.json().catch(() => null) as any;
      const remaining = Number(billingData?.remaining ?? billingData?.credits_remaining ?? -1);
      const limit = Number(billingData?.limit ?? billingData?.total_credits ?? -1);
      const used = limit > 0 && remaining >= 0 ? limit - remaining : 0;

      return {
        success: true,
        quota: { limit, remaining, used, resetAt: null },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Override the default healthCheck. fetchQuota already validates auth +
   * liveness via the billing/models endpoint.
   */
  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = getTokens(account);
    if (!tokens?.access_token) {
      return { kind: "missing_tokens", success: false, error: "No access token" };
    }

    // Check token expiry
    if (isTokenExpiring(tokens)) {
      // Try refresh
      const refreshResult = await this.refreshToken(account);
      if (!refreshResult.success) {
        return {
          kind: "session_expired",
          success: false,
          error: refreshResult.error || "Token refresh failed",
        };
      }
      // Update tokens in DB
      if (refreshResult.tokens) {
        try {
          await db.update(accounts).set({
            tokens: refreshResult.tokens,
            updatedAt: new Date(),
          }).where(eq(accounts.id, account.id));
        } catch { /* non-fatal */ }
      }
    }

    const quota = await this.fetchQuota(account);
    if (!quota.success) {
      const msg = quota.error || "quota check failed";
      if (/^expired:/i.test(msg)) {
        return { kind: "session_expired", success: false, error: msg };
      }
      return { kind: "transient_error", success: false, retryable: true, error: msg };
    }

    return {
      kind: "healthy",
      success: true,
      quota: quota.quota
        ? { ...quota.quota, source: "grok-cli.billing" }
        : undefined,
    };
  }
}

// ── OAuth Device Code Flow ─────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Step 1: Request a device code from xAI OAuth.
 * Returns the device code + verification URL for the user.
 */
export async function requestGrokCliDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });
  // Official CLI sends referrer=grok-build
  body.set("referrer", "grok-build");

  const resp = await fetch(XAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": GROK_CLI_USER_AGENT,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Device code request failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }

  return await resp.json() as DeviceCodeResponse;
}

/**
 * Step 2: Poll the token endpoint until the user authorizes.
 * Returns the token response, or null if still pending.
 */
export async function pollGrokCliToken(deviceCode: string): Promise<{
  pending: boolean;
  tokens?: TokenResponse;
  error?: string;
}> {
  const resp = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": GROK_CLI_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: XAI_OAUTH_CLIENT_ID,
    }),
  });

  let data: any;
  try {
    data = await resp.json();
  } catch {
    const text = await resp.text();
    data = { error: "invalid_response", error_description: text };
  }

  // Device flow: 400 + authorization_pending is expected while user authorizes
  const pending =
    data?.error === "authorization_pending" || data?.error === "slow_down";

  if (pending) {
    return { pending: true };
  }

  if (data?.error) {
    return { pending: false, error: data.error_description || data.error };
  }

  return { pending: false, tokens: data as TokenResponse };
}

/**
 * Step 3: Post-exchange — fetch user profile from cli-chat-proxy.
 * Best-effort: non-fatal if it fails.
 */
async function fetchGrokCliUserProfile(accessToken: string): Promise<{
  email?: string;
  userId?: string;
  subscriptionTier?: string;
}> {
  try {
    const resp = await fetch(GROK_CLI_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": GROK_CLI_USER_AGENT,
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": GROK_CLI_VERSION,
        "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
      },
    });

    if (!resp.ok) return {};
    const data = await resp.json() as any;

    // Try to extract email from id_token if not in user response
    let email = data?.email || "";
    let userId = data?.user_id || data?.userId || data?.principalId || "";

    return {
      email: email || undefined,
      userId: userId || undefined,
      subscriptionTier: data?.subscriptionTier || data?.subscription_tier || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Decode a JWT payload without verification (for extracting email/userId).
 */
function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

/**
 * Complete the OAuth device code flow and create/update an account.
 * Called after the user has authorized the device code.
 */
export async function activateGrokCliAccount(tokens: TokenResponse): Promise<{
  id: number;
  provider: string;
  email: string;
  status: string;
  updated: boolean;
}> {
  // Best-effort user profile
  const profile = await fetchGrokCliUserProfile(tokens.access_token);

  // Try to extract email from id_token
  let email = profile.email || "";
  let userId = profile.userId || "";
  if (!email && tokens.id_token) {
    const claims = decodeJwtPayload(tokens.id_token);
    email = claims.email || claims.preferred_username || "";
    userId = userId || claims.sub || "";
  }

  // Fallback: synthesize a stable email from token tail
  if (!email) {
    email = `grokcli-${tokens.access_token.slice(-12)}@oauth`;
  }

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;

  const accountTokens: GrokCliTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    expires_at: expiresAt,
    email,
    user_id: userId,
    subscription_tier: profile.subscriptionTier,
  };

  // password field stores a dummy value (OAuth accounts don't have a password)
  // but must be non-null per schema. We store a marker.
  const encryptedPassword = encrypt("grok-cli-oauth");

  // Check for existing account
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, email))
    .then((rows) => rows.find((r) => r.provider === "grok-cli"));

  if (existing) {
    await db.update(accounts).set({
      password: encryptedPassword,
      status: "active",
      tokens: accountTokens as unknown,
      errorMessage: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(accounts.id, existing.id));

    return {
      id: existing.id,
      provider: "grok-cli",
      email,
      status: "active",
      updated: true,
    };
  }

  const inserted = await db.insert(accounts).values({
    provider: "grok-cli",
    email,
    password: encryptedPassword,
    status: "active",
    tokens: accountTokens as unknown,
    metadata: {
      subscription_tier: profile.subscriptionTier,
      validated_at: new Date().toISOString(),
    } as unknown,
    quotaLimit: -1,
    quotaRemaining: -1,
    lastLoginAt: new Date(),
  }).returning();

  const created = inserted[0]!;
  return {
    id: created.id,
    provider: "grok-cli",
    email,
    status: "active",
    updated: false,
  };
}
