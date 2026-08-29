import { describe, expect, test } from "bun:test";
import { getProviderForModel } from "../../src/proxy/providers/registry";

describe("getProviderForModel grok routing", () => {
  test("bare grok-4.6 and grok-build go to grok-cli", () => {
    expect(getProviderForModel("grok-4.6")).toBe("grok-cli");
    expect(getProviderForModel("grok-build")).toBe("grok-cli");
    expect(getProviderForModel("gcli/grok-4.6")).toBe("grok-cli");
  });

  test("xAI API-key models stay on grok", () => {
    expect(getProviderForModel("xai/grok-4-fast")).toBe("grok");
    expect(getProviderForModel("grok-4-fast")).toBe("grok");
    expect(getProviderForModel("grok-4.6")).not.toBe("grok");
  });
});
