import { describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import { GrokCliProvider } from "../../src/proxy/providers/grok-cli";
import { grokCliSessionId } from "../../src/proxy/providers/grok-cli-protocol";

class TestGrokCliProvider extends GrokCliProvider {
  readonly urls: string[] = [];
  lastInit: RequestInit | undefined;

  constructor(
    private readonly responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    super();
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    this.urls.push(url);
    this.lastInit = init;
    return this.responder(url, init);
  }
}

const account = {
  id: 1,
  provider: "grok-cli",
  email: "gcli@test.local",
  tokens: { access_token: "access-token", user_id: "user-1" },
  metadata: {
    plenger: false,
    plengerCheckedAt: new Date().toISOString(),
  },
} as Account;

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("GrokCliProvider grok2api wire", () => {
  test("sends stable session headers and encrypted-reasoning include", async () => {
    const provider = new TestGrokCliProvider(() => sseResponse("ok"));
    const result = await provider.chatCompletionStream(account, {
      model: "grok-4.6",
      stream: true,
      prompt_cache_key: "etteum-abc-grok-4.6",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.success).toBe(true);
    const headers = thisHeaders(provider.lastInit);
    const sessionId = grokCliSessionId("etteum-abc-grok-4.6");
    expect(sessionId).toBeTruthy();
    expect(headers["x-grok-session-id"]).toBe(sessionId ?? undefined);
    expect(headers["x-grok-conv-id"]).toBe(headers["x-grok-session-id"]);
    expect(headers["x-grok-turn-idx"]).toBeUndefined();
    expect(headers["x-grok-agent-id"]).toBeTruthy();
    expect(headers["x-authenticateresponse"]).toBe("authenticate-response");

    const body = JSON.parse(String(provider.lastInit?.body || "{}")) as {
      include?: string[];
      store?: boolean;
    };
    expect(body.store).toBe(false);
    expect(body.include).toContain("reasoning.encrypted_content");
  });

  test("retries a generic 403 on api.x.ai", async () => {
    const provider = new TestGrokCliProvider((url) => {
      if (url.includes("cli-chat-proxy")) {
        return new Response("forbidden", { status: 403 });
      }
      return sseResponse("fallback-ok");
    });

    const result = await provider.chatCompletionStream(account, {
      model: "grok-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.success).toBe(true);
    expect(provider.urls).toEqual([
      "https://cli-chat-proxy.grok.com/v1/responses",
      "https://api.x.ai/v1/responses",
    ]);
  });

  test("does not retry a blocked-user 403 on api.x.ai", async () => {
    const provider = new TestGrokCliProvider(
      () => new Response(JSON.stringify({ code: "blocked-user" }), { status: 403 }),
    );

    const result = await provider.chatCompletionStream(account, {
      model: "grok-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.success).toBe(false);
    expect(provider.urls).toEqual(["https://cli-chat-proxy.grok.com/v1/responses"]);
  });
});

function thisHeaders(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw || Array.isArray(raw) || raw instanceof Headers) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
