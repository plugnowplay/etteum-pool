import { describe, expect, test } from "bun:test";
import { ByokProvider } from "../../src/proxy/providers/byok";
import { getProviderForModel, providers } from "../../src/proxy/providers/registry";

describe("BYOK-shaped model routing (combo → kiro fallback bug)", () => {
  test("unknown prefix/<model> ids route to byok, never the kiro catch-all", () => {
    expect(getProviderForModel("openrouter/claude-sonnet-4.6")).toBe("byok");
    expect(getProviderForModel("mylabel/gpt-4o")).toBe("byok");
    expect(getProviderForModel("vendor/meta/llama-4")).toBe("byok");
  });

  test("byok wins even when its sync prefix cache is cold", () => {
    const cold = new ByokProvider();
    expect(cold.ownsModel("openrouter/claude-sonnet-4.6")).toBe(false);
    expect(getProviderForModel("openrouter/claude-sonnet-4.6")).toBe("byok");
  });

  test("kiro standard no longer claims slash-prefixed ids, still owns bare ones", () => {
    expect(providers.kiro.ownsModel("openrouter/claude-sonnet-4.6")).toBe(false);
    expect(providers.kiro.ownsModel("claude-sonnet-4.6")).toBe(true);
    expect(providers.kiro.ownsModel("claude-sonnet-4.6-thinking")).toBe(true);
    expect(providers.kiro.ownsModel("auto")).toBe(true);
    expect(providers.kiro.ownsModel("minimax-m2")).toBe(true);
  });

  test("explicit provider prefixes keep their routing", () => {
    expect(getProviderForModel("gcli/grok-4.6")).toBe("grok-cli");
    expect(getProviderForModel("kiro/claude-sonnet-4.5")).toBe("kiro");
    expect(getProviderForModel("byok/anything")).toBe("byok");
  });
});
