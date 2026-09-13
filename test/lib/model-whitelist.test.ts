import { describe, expect, test } from "bun:test";
import { isModelAllowed, parseModelWhitelist } from "../../src/lib/model-whitelist";

describe("parseModelWhitelist", () => {
  test("splits, trims, and lowercases entries", () => {
    expect(parseModelWhitelist(" GLM-5.3 , gpt-4o ")).toEqual(["glm-5.3", "gpt-4o"]);
  });

  test("empty / null input yields an empty list (allow-all)", () => {
    expect(parseModelWhitelist("")).toEqual([]);
    expect(parseModelWhitelist(null)).toEqual([]);
    expect(parseModelWhitelist(undefined)).toEqual([]);
    expect(parseModelWhitelist(" , , ")).toEqual([]);
  });
});

describe("isModelAllowed", () => {
  test("an empty whitelist allows every model", () => {
    expect(isModelAllowed("gcli/grok-4.6-medium", [])).toBe(true);
    expect(isModelAllowed("anything", [])).toBe(true);
  });

  // The bug that motivated this module: "me" matched "grok-4.6-mediuM"
  // because plain substring search hit the middle of the word "medium".
  test("does NOT match a substring in the middle of a word", () => {
    const wl = parseModelWhitelist("me");
    expect(isModelAllowed("gcli/grok-4.6-medium", wl)).toBe(false);
    expect(isModelAllowed("gcli/grok-4.5-medium", wl)).toBe(false);
  });

  test("other accidental mid-word substrings stay blocked", () => {
    expect(isModelAllowed("cb/glm-5.3", parseModelWhitelist("lm"))).toBe(false);
    expect(isModelAllowed("claude-sonnet-4.5", parseModelWhitelist("son"))).toBe(false);
    expect(isModelAllowed("gpt-4o", parseModelWhitelist("pt"))).toBe(false);
  });

  test("exact model id matches", () => {
    const wl = parseModelWhitelist("gcli/grok-4.6-medium");
    expect(isModelAllowed("gcli/grok-4.6-medium", wl)).toBe(true);
  });

  test("whole-token entries match", () => {
    const wl = parseModelWhitelist("glm");
    expect(isModelAllowed("cb/glm-5.3", wl)).toBe(true);
    expect(isModelAllowed("glm-5.2", wl)).toBe(true);
    // "glm" is not a token of these, so they stay out.
    expect(isModelAllowed("gpt-4o", wl)).toBe(false);
  });

  test("consecutive token runs match (prefix-style entries)", () => {
    const wl = parseModelWhitelist("claude-sonnet-4");
    expect(isModelAllowed("claude-sonnet-4", wl)).toBe(true);
    expect(isModelAllowed("kiro/claude-sonnet-4", wl)).toBe(true);
    // Token run must be contiguous and in order.
    expect(isModelAllowed("claude-opus-4", wl)).toBe(false);
  });

  test("provider prefixes are ignored on both sides", () => {
    expect(isModelAllowed("cb/glm-5.2", parseModelWhitelist("glm-5.2"))).toBe(true);
    expect(isModelAllowed("glm-5.2", parseModelWhitelist("cb/glm-5.2"))).toBe(true);
  });

  test("explicit globs give opt-in loose matching", () => {
    expect(isModelAllowed("gcli/grok-4.6-medium", parseModelWhitelist("grok*"))).toBe(true);
    expect(isModelAllowed("gcli/grok-4.6-medium", parseModelWhitelist("*medium"))).toBe(true);
    expect(isModelAllowed("gcli/grok-4.6-medium", parseModelWhitelist("*4.6*"))).toBe(true);
    expect(isModelAllowed("cb/glm-5.3", parseModelWhitelist("grok*"))).toBe(false);
  });

  test("a glob does not silently match unrelated models", () => {
    expect(isModelAllowed("cb/gpt-4o", parseModelWhitelist("claude-*"))).toBe(false);
  });

  test("matching is case-insensitive", () => {
    expect(isModelAllowed("CB/GLM-5.3", parseModelWhitelist("glm-5.3"))).toBe(true);
    expect(isModelAllowed("cb/glm-5.3", parseModelWhitelist("GLM-5.3"))).toBe(true);
  });

  test("blank model ids are rejected when a whitelist exists", () => {
    expect(isModelAllowed("", parseModelWhitelist("glm"))).toBe(false);
    expect(isModelAllowed("   ", parseModelWhitelist("glm"))).toBe(false);
  });

  test("multiple entries behave as OR", () => {
    const wl = parseModelWhitelist("glm-5.3, gpt-4o");
    expect(isModelAllowed("cb/glm-5.3", wl)).toBe(true);
    expect(isModelAllowed("cb/gpt-4o", wl)).toBe(true);
    expect(isModelAllowed("kiro/claude-sonnet-4", wl)).toBe(false);
  });
});
