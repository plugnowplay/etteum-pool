import { describe, expect, test } from "bun:test";
import {
  applyGrokCliResponseDefaults,
  grokCliInferenceHeaders,
  grokCliSessionId,
  isReasoningDecodeFailure,
  normalizeGrokTurnIndex,
  shouldSkipXaiFallback,
  stripReasoningEncryptedContent,
} from "../../src/proxy/providers/grok-cli-protocol";

const HEADER_CONSTANTS = {
  userAgent: "grok-shell/1.0.5 (linux; x86_64)",
  clientVersion: "1.0.5",
  clientIdentifier: "grok-shell",
} as const;

describe("grokCliSessionId", () => {
  test("returns null when the cache key is empty", () => {
    expect(grokCliSessionId(undefined)).toBeNull();
    expect(grokCliSessionId("")).toBeNull();
    expect(grokCliSessionId("   ")).toBeNull();
  });

  test("passes through a UUID cache key unchanged (lowercased)", () => {
    const id = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    expect(grokCliSessionId(id)).toBe(id.toLowerCase());
  });

  test("hashes a non-UUID key to a stable UUID", () => {
    const first = grokCliSessionId("etteum-abc-grok-4.6");
    const second = grokCliSessionId("etteum-abc-grok-4.6");
    const other = grokCliSessionId("etteum-xyz-grok-4.6");
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });
});

describe("normalizeGrokTurnIndex", () => {
  test("accepts non-negative decimal turns and rejects fabricated junk", () => {
    expect(normalizeGrokTurnIndex("0")).toBe("0");
    expect(normalizeGrokTurnIndex("12")).toBe("12");
    expect(normalizeGrokTurnIndex(" 7 ")).toBe("7");
    expect(normalizeGrokTurnIndex("")).toBeNull();
    expect(normalizeGrokTurnIndex("1.5")).toBeNull();
    expect(normalizeGrokTurnIndex("-1")).toBeNull();
    expect(normalizeGrokTurnIndex("turn-1")).toBeNull();
  });
});

describe("grokCliInferenceHeaders", () => {
  test("omits session headers when there is no cache key", () => {
    const headers = grokCliInferenceHeaders(
      {
        accessToken: "tok",
        agentId: "agent-1",
        requestId: "req-1",
        model: "grok-4.6",
      },
      HEADER_CONSTANTS,
    );
    expect(headers["x-grok-session-id"]).toBeUndefined();
    expect(headers["x-grok-conv-id"]).toBeUndefined();
    expect(headers["x-grok-turn-idx"]).toBeUndefined();
    expect(headers["x-grok-agent-id"]).toBe("agent-1");
    expect(headers["x-authenticateresponse"]).toBe("authenticate-response");
    expect(headers["Accept-Encoding"]).toBe("identity");
    expect(headers["x-grok-model-override"]).toBe("grok-4.6");
  });

  test("derives matching session and conv ids from the cache key and does not fabricate turn 1", () => {
    const headers = grokCliInferenceHeaders(
      {
        accessToken: "tok",
        agentId: "agent-1",
        requestId: "req-1",
        promptCacheKey: "etteum-abc-grok-4.6",
        userId: "user-9",
        turnIndex: "1",
      },
      HEADER_CONSTANTS,
    );
    const session = grokCliSessionId("etteum-abc-grok-4.6");
    expect(headers["x-grok-session-id"]).toBe(session);
    expect(headers["x-grok-conv-id"]).toBe(session);
    expect(headers["x-grok-turn-idx"]).toBe("1");
    expect(headers["x-grok-user-id"]).toBe("user-9");
    expect(headers["x-email"]).toBeUndefined();
    expect(headers["x-userid"]).toBeUndefined();
  });
});

describe("applyGrokCliResponseDefaults", () => {
  test("forces store=false and includes encrypted reasoning when absent", () => {
    const next = applyGrokCliResponseDefaults({
      model: "grok-4.6",
      input: [],
      reasoning: { effort: "high" },
    });
    expect(next.store).toBe(false);
    expect(next.include).toEqual(["reasoning.encrypted_content"]);
    expect(next.reasoning).toEqual({ effort: "high", summary: "concise" });
  });

  test("does not duplicate include or overwrite an explicit store=true", () => {
    const next = applyGrokCliResponseDefaults({
      store: true,
      include: ["reasoning.encrypted_content", "file_search_call.results"],
      reasoning: { effort: "low", summary: "detailed" },
    });
    expect(next.store).toBe(true);
    expect(next.include).toEqual(["reasoning.encrypted_content", "file_search_call.results"]);
    expect(next.reasoning).toEqual({ effort: "low", summary: "detailed" });
  });
});

describe("isReasoningDecodeFailure", () => {
  test("matches only grok2api decode-failure markers", () => {
    expect(isReasoningDecodeFailure("Could not decrypt the provided encrypted_content")).toBe(true);
    expect(isReasoningDecodeFailure("could not decode the compaction blob")).toBe(true);
    expect(isReasoningDecodeFailure("invalid_request: bad model")).toBe(false);
  });
});

describe("shouldSkipXaiFallback", () => {
  test("skips blocked-user and safety 403s, not generic forbidden", () => {
    expect(shouldSkipXaiFallback('{"code":"blocked-user"}')).toBe(true);
    expect(shouldSkipXaiFallback("User is blocked.")).toBe(true);
    expect(shouldSkipXaiFallback("content violates usage guidelines")).toBe(true);
    expect(shouldSkipXaiFallback("safety_check_type_hate")).toBe(true);
    expect(shouldSkipXaiFallback("forbidden")).toBe(false);
  });
});

describe("stripReasoningEncryptedContent", () => {
  test("removes encrypted-only reasoning items and keeps readable summaries", () => {
    const stripped = stripReasoningEncryptedContent({
      model: "grok-4.6",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "reasoning", id: "rs_1", encrypted_content: "opaque", status: "completed" },
        {
          type: "reasoning",
          id: "rs_2",
          encrypted_content: "opaque-2",
          summary: [{ type: "summary_text", text: "thought" }],
        },
      ],
    });
    expect(stripped).not.toBeNull();
    expect(stripped!.input).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
    ]);
  });

  test("returns null when there is no encrypted_content to strip", () => {
    expect(
      stripReasoningEncryptedContent({
        input: [{ type: "message", role: "user", content: "hi" }],
      }),
    ).toBeNull();
  });
});
