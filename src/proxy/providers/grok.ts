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
import { decrypt } from "../../utils/crypto";

// ============================================================================
// Grok Provider — xAI OpenAI-compatible API (https://api.x.ai)
//
// xAI exposes a standard OpenAI Chat Completions endpoint at
//   /v1/chat/completions
// and a models listing at
//   /v1/models
//
// Auth: Authorization: Bearer xai-...
//
// All upstream-facing model IDs are exposed under the `grok-` prefix. The
// resolveModel() dispatcher maps each proxy-facing id to its real upstream id.
// Adding/removing a model = touching GROK_MODELS only.
// ============================================================================

const XAI_BASE = "https://api.x.ai";
const XAI_CHAT_URL = `${XAI_BASE}/v1/chat/completions`;
const XAI_MODELS_URL = `${XAI_BASE}/v1/models`;

interface GrokModelDef {
  /** Proxy-facing id (grok-*) */
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
 * Curated catalog of Grok models. xAI exposes grok-4-fast and grok-3 variants
 * via the OpenAI-compatible endpoint. Vision is supported on grok-4-fast and
 * grok-3. Thinking is supported on reasoning-capable models.
 *
 * Pricing (per M tokens, input/output blended for creditRate estimate):
 *   grok-4-fast:        $0.20 / $0.50  → avg ≈ $0.00035 / 1k
 *   grok-4:             $3.00 / $15.00 → avg ≈ $0.009 / 1k
 *   grok-3:             $3.00 / $15.00 → avg ≈ $0.009 / 1k
 *   grok-3-mini:        $0.30 / $0.80  → avg ≈ $0.00055 / 1k
 *   grok-2-vision:      $2.00 / $10.00 → avg ≈ $0.006 / 1k
 *   grok-code-fast:     $0.20 / $0.50  → avg ≈ $0.00035 / 1k
 *   grok-4.6:           $2.00 / $6.00  → avg ≈ $0.004 / 1k
 */
const GROK_MODELS: GrokModelDef[] = [
  {
    id: "grok-4.6",
    upstream: "grok-4.6",
    context_window: 500000,
    max_output: 0,
    thinking: true,
    vision: true,
    creditRate: 0.004 / 1000,
  },
  {
    id: "grok-4-fast",
    upstream: "grok-4-fast",
    context_window: 256000,
    max_output: 64000,
    thinking: false,
    vision: true,
    creditRate: 0.00035 / 1000,
  },
  {
    id: "grok-4-fast-non-reasoning",
    upstream: "grok-4-fast-non-reasoning",
    context_window: 256000,
    max_output: 64000,
    thinking: false,
    vision: true,
    creditRate: 0.00035 / 1000,
  },
  {
    id: "grok-4",
    upstream: "grok-4",
    context_window: 256000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "grok-3",
    upstream: "grok-3",
    context_window: 131072,
    max_output: 16384,
    thinking: false,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "grok-3-mini",
    upstream: "grok-3-mini",
    context_window: 131072,
    max_output: 16384,
    thinking: true,
    vision: true,
    creditRate: 0.00055 / 1000,
  },
  {
    id: "grok-2-vision",
    upstream: "grok-2-vision-1212",
    context_window: 32768,
    max_output: 4096,
    thinking: false,
    vision: true,
    creditRate: 0.006 / 1000,
  },
  {
    id: "grok-code-fast",
    upstream: "grok-code-fast",
    context_window: 256000,
    max_output: 64000,
    thinking: false,
    vision: false,
    creditRate: 0.00035 / 1000,
  },
];

const MODEL_BY_ID: Record<string, GrokModelDef> = Object.fromEntries(
  GROK_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

export class GrokProvider extends BaseProvider {
  name = "grok";
  override alias = "xai";

  /**
   * Native wire format. Grok uses OpenAI-compatible Chat Completions API.
   */
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    return this.resolveModel(model) !== null;
  }

  supportedModels: ModelInfo[] = GROK_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "grok",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "token" as const,
    creditRate: m.creditRate,
    creditSource: "estimated" as const,
  }));

  // ── Helpers ────────────────────────────────────────────────────────

  private resolveModel(model: string): GrokModelDef | null {
    return MODEL_BY_ID[model.toLowerCase()] ?? null;
  }

  /**
   * The real API key lives in `password` (XOR-encrypted at rest). We never
   * store it elsewhere.
   */
  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      return "";
    }
  }

  // ── Provider Interface ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Grok model: ${request.model}` };
    return this.chatCompletionOpenAI(account, def, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Grok model: ${request.model}` };
    return this.chatCompletionStreamOpenAI(account, def, request);
  }

  /** Grok API keys are static — user manages rotation in xAI console. */
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  /**
   * xAI doesn't expose per-account credit numbers in its public API. We probe
   * the models listing endpoint as a cheap liveness check — it returns 401 if
   * the key is revoked. Quota is reported as `-1` (sentinel for "unlimited /
   * unknown") so the warmup runner won't flip the account to exhausted on a
   * real positive limit.
   */
  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    try {
      const resp = await this.fetchWithTimeout(XAI_MODELS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `expired: HTTP ${resp.status}` };
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `Grok quota probe HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      // Drain body — even if we don't use the data, leaving the socket dirty
      // can leak fd handles under bun's keepalive.
      await resp.text().catch(() => "");
      return {
        success: true,
        quota: { limit: -1, remaining: -1, used: 0, resetAt: null },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── OpenAI relay ───────────────────────────────────────────────────

  private async chatCompletionOpenAI(
    account: Account,
    def: GrokModelDef,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toOpenAIRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(XAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp, "Grok");
      if (errResult) return errResult;

      const data = (await resp.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(request.messages);
      const completionTokens =
        data.usage?.completion_tokens ??
        this.estimateTokens(typeof choice.message?.content === "string" ? choice.message.content : "");

      // Return the original grok- prefixed model id to the client.
      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamOpenAI(
    account: Account,
    def: GrokModelDef,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toOpenAIRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(XAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      const errResult = await this.handleErrorResponse(resp, "Grok stream");
      if (errResult) return errResult;
      if (!resp.body) return { success: false, error: "Grok response missing body" };

      const stream = this.passthroughOpenAIStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Error handling ─────────────────────────────────────────────────

  /**
   * Single source of truth for upstream HTTP error mapping. Returns a
   * ProviderResult when the response should NOT proceed; returns null when
   * the caller should keep parsing the body.
   */
  private async handleErrorResponse(
    resp: Response,
    label: string,
  ): Promise<ProviderResult | null> {
    if (resp.ok) return null;
    if (resp.status === 401 || resp.status === 403) {
      return { success: false, error: `expired: HTTP ${resp.status}` };
    }
    if (resp.status === 429) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: text || "Rate limited", rateLimited: true };
    }
    const text = await resp.text().catch(() => "");
    return { success: false, error: `${label} HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  // ── OpenAI request shaping ─────────────────────────────────────────

  /**
   * Build the OpenAI Chat Completions body. Sanitizes the message array to
   * the canonical OpenAI shape — agentic clients may send Anthropic-style
   * content blocks that xAI rejects.
   */
  private toOpenAIRequest(
    request: ChatCompletionRequest,
    def: GrokModelDef,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = this.sanitizeMessages(request.messages);

    const body: Record<string, unknown> = {
      model: def.upstream,
      messages,
      stream,
    };

    if (stream) body.stream_options = { include_usage: true };

    if (request.max_tokens !== undefined) {
      body.max_tokens = Math.min(request.max_tokens, def.max_output);
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;

    if (request.tools && request.tools.length > 0) {
      body.tools = this.normalizeToolsForOpenAI(request.tools);
    }
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;

    return body;
  }

  /**
   * Sanitize messages to canonical OpenAI shape. Converts Anthropic-style
   * content blocks (tool_use, tool_result, image) into OpenAI equivalents.
   */
  private sanitizeMessages(messages: ChatMessage[]): any[] {
    const out: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system" || msg.role === "tool") {
        const content = typeof msg.content === "string" ? msg.content : this.contentBlocksToText(msg.content);
        out.push({ role: msg.role, content });
        continue;
      }

      const textParts: string[] = [];
      const toolCalls: any[] = [];
      const toolResults: { id: string; content: string }[] = [];
      const imageParts: any[] = [];

      if (Array.isArray(msg.content)) {
        for (const b of msg.content as any[]) {
          if (!b || typeof b !== "object") continue;

          if (b.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
            continue;
          }

          if (b.type === "tool_use") {
            toolCalls.push({
              id: b.id || `call_${toolCalls.length}`,
              type: "function",
              function: {
                name: b.name || "",
                arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
              },
            });
            continue;
          }

          if (b.type === "tool_result") {
            toolResults.push({
              id: b.tool_use_id || b.id || "",
              content: this.contentBlocksToText(b.content),
            });
            continue;
          }

          // Anthropic image source → OpenAI image_url data URL
          if (b.type === "image" || b.type === "image_url") {
            const src = b.source ?? b.image_url;
            if (src?.data && src?.media_type) {
              imageParts.push({
                type: "image_url",
                image_url: { url: `data:${src.media_type};base64,${src.data}` },
              });
            } else if (src?.url) {
              imageParts.push({ type: "image_url", image_url: { url: src.url } });
            }
            continue;
          }

          // Thinking blocks — drop silently; OpenAI has no equivalent
          if (b.type === "thinking" || b.type === "redacted_thinking") continue;

          // Unknown block — coerce to text
          if (typeof (b as any).text === "string") textParts.push((b as any).text);
        }
      } else if (typeof msg.content === "string") {
        textParts.push(msg.content);
      }

      // Emit tool_results FIRST (one role:"tool" message per result)
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }

      // Then emit the actual user/assistant message
      const text = textParts.join("\n");

      if (msg.role === "assistant" && toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls,
        });
        continue;
      }

      // Multimodal user content stays as an array; otherwise collapse to string
      if (imageParts.length > 0 && msg.role === "user") {
        const content: any[] = [];
        if (text) content.push({ type: "text", text });
        content.push(...imageParts);
        out.push({ role: "user", content });
        continue;
      }

      // Plain text
      if (text || msg.role !== "assistant" || toolCalls.length === 0) {
        out.push({ role: msg.role, content: text });
      }
    }

    return out;
  }

  /** Collapse mixed content blocks down to a single string. */
  private contentBlocksToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as any[])
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "tool_result") return this.contentBlocksToText(b.content);
        if (typeof b.text === "string") return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Tools may also arrive in Anthropic shape (`{name, description,
   * input_schema}`) when the client is Anthropic-native. The OpenAI relay
   * needs `{type:"function", function:{name, description, parameters}}`.
   */
  private normalizeToolsForOpenAI(tools: any[]): any[] {
    return tools
      .map((t) => {
        if (t?.type === "function" && t.function?.name) return t;
        if (t?.name) {
          return {
            type: "function",
            function: {
              name: t.name,
              description: t.description || "",
              parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
            },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Pass through an OpenAI-compatible SSE stream, rewriting `id` and `model`
   * to the proxy-facing values so clients see a stable id and the original
   * `grok-*` model echo'd back. We intentionally don't re-parse deltas — the
   * upstream is fully OpenAI-compatible and only needs id/model normalization.
   */
  private passthroughOpenAIStream(
    upstream: ReadableStream<Uint8Array>,
    originalModel: string,
  ): ReadableStream<Uint8Array> {
    const id = this.generateId();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finishEmitted = false;

        const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: originalModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (!finishEmitted) controller.enqueue(makeChunk({}, "stop"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;

              const payload = trimmed.slice(5).trim();
              if (!payload) continue;
              if (payload === "[DONE]") {
                if (!finishEmitted) controller.enqueue(makeChunk({}, "stop"));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              try {
                const event = JSON.parse(payload);
                const choice = event?.choices?.[0];
                if (choice?.finish_reason) {
                  finishEmitted = true;
                  controller.enqueue(makeChunk({}, choice.finish_reason));
                  continue;
                }
                // Rewrite id/model, pass delta through
                const chunk = {
                  id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: originalModel,
                  choices: [{ index: 0, delta: choice?.delta || {}, finish_reason: null }],
                  ...(event?.usage ? { usage: event.usage } : {}),
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // Skip malformed chunks rather than tearing down the stream
              }
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        } finally {
          try { reader.releaseLock(); } catch { /* noop */ }
        }
      },
    });
  }

  // ── Health check ───────────────────────────────────────────────────

  /**
   * Override the default healthCheck. fetchQuota already validates auth +
   * liveness via the models listing endpoint.
   */
  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key" };
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
        ? { ...quota.quota, source: "grok.models" }
        : undefined,
    };
  }
}

// ============================================================================
// Public helpers (used by accounts API for add-account flow)
// ============================================================================

export interface GrokActivation {
  email: string;
  metadata: Record<string, unknown>;
}

/**
 * Validate a Grok API key and derive a stable email-like identifier from
 * the models listing response. We don't have access to the user's real
 * email via the xAI API surface, so we synthesize a deterministic label
 * keyed on the key tail. That guarantees idempotent upserts: pasting the
 * same key twice updates the same row.
 *
 * Throws a human-readable Error on validation failure.
 */
export async function activateGrokKey(apiKey: string): Promise<GrokActivation> {
   const trimmed = apiKey.trim();
   if (!trimmed.startsWith("xai-")) {
     throw new Error("Grok API key must start with xai-");
   }
 
   // Probe 1 — validate the key against the models listing endpoint
   const resp = await fetch(XAI_MODELS_URL, {
     headers: { Authorization: `Bearer ${trimmed}` },
   });
 
   if (resp.status === 401 || resp.status === 403) {
     const text = await resp.text().catch(() => "");
     throw new Error(`Invalid Grok API key (HTTP ${resp.status}): ${text.slice(0, 160)}`);
   }
   if (!resp.ok) {
     const text = await resp.text().catch(() => "");
     throw new Error(`Grok API key validation failed (HTTP ${resp.status}): ${text.slice(0, 160)}`);
   }
 
   // Probe 2 — best-effort models list. Used only to enrich metadata; a
   // failure here is non-fatal (key was already validated by probe 1).
   let availableModels: string[] = [];
   try {
     const modelsData = (await resp.json().catch(() => null)) as
       | { data?: Array<{ id?: string }> }
       | null;
     if (modelsData?.data) {
       availableModels = modelsData.data.map((m) => m.id || "").filter(Boolean);
     }
   } catch { /* non-fatal */ }
 
   // Derive a stable email-like label from the key tail so different keys
   // produce distinct rows but the same key always maps to the same row.
   const email = `grok-${trimmed.slice(-12)}@apikey`;
 
   const metadata: Record<string, unknown> = {
     available_models: availableModels,
     validated_at: new Date().toISOString(),
   };
 
   return { email, metadata };
 }

// ============================================================================
// Import via JSON (mirip G2A)
// ============================================================================

export async function importGrokAccountsFromJson(jsonPath: string): Promise<{
  success: boolean;
  count: number;
  message: string;
}> {
  try {
    const fs = await import("fs/promises");
    const data = await fs.readFile(jsonPath, "utf-8");
    const accounts = JSON.parse(data);

    if (!Array.isArray(accounts)) {
      return { success: false, count: 0, message: "JSON harus berupa array objek" };
    }

    const { db } = await import("../../db/index");
    const { accounts: accountsTable } = await import("../../db/schema");

    let imported = 0;
    const errors: string[] = [];

    for (const acc of accounts) {
      const email = acc.email?.trim();
      const password = acc.password?.trim() || acc.token || "";
      const token = acc.token || "";

      if (!email || !password) continue;

      // Cek duplikat
      const existing = await db
        .select()
        .from(accountsTable)
        .where(eq(accountsTable.email, email))
        .limit(1);

      if (existing.length > 0) continue;

      await db.insert(accountsTable).values({
        provider: "grok",
        email,
        password: token || password,   // simpan password terenkripsi nanti
        tokens: JSON.stringify({ source: "json_import", imported_at: new Date().toISOString() }),
        status: "active",
        enabled: true,
        created_at: new Date(),
      });

      imported++;
    }

    return {
      success: true,
      count: imported,
      message: `Berhasil import ${imported} akun Grok`,
    };
  } catch (err) {
    return {
      success: false,
      count: 0,
      message: `Import gagal: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

