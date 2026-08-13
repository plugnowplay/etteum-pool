import { describe, expect, test } from "bun:test";
import { comboModelId, comboNameFromModel, orderComboModels, requestCapacity, validateComboInput } from "../src/proxy/combo-utils";

describe("combo utils", () => {
  test("uses virtual combo model ids", () => {
    expect(comboModelId("smart")).toBe("combo:smart");
    expect(comboNameFromModel("combo:smart")).toBe("smart");
  });

  test("round robin rotates order", () => {
    const combo = { name: "x", strategy: "round_robin" as const, models: ["a", "b", "c"] };
    expect(orderComboModels(combo, {}, () => undefined, 1)).toEqual(["b", "c", "a"]);
  });

  test("capacity puts vision model first for image request", () => {
    const combo = { name: "x", strategy: "capacity_auto_switch" as const, models: ["text", "vision"] };
    const request = { messages: [{ content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    expect(requestCapacity(request)).toBe("image");
    expect(orderComboModels(combo, request, (id) => ({ id, vision: id === "vision" }))).toEqual(["vision", "text"]);
  });

  test("validates fusion requirements", () => {
    expect(validateComboInput({ name: "x", strategy: "fusion", models: ["a"], judgeModel: "j" })).toContain("two");
    expect(validateComboInput({ name: "x", strategy: "fallback", models: ["a"] })).toBeNull();
  });
});
