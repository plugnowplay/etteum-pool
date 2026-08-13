import { and, like, eq } from "drizzle-orm";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { comboModelId, type ComboDefinitionShape, type ComboStrategy, validateComboInput } from "./combo-utils";

const COMBO_KEY_PREFIX = "combo:";

function comboKey(name: string): string {
  return `${COMBO_KEY_PREFIX}${name}`;
}

export async function listCombos(): Promise<ComboDefinitionShape[]> {
  const rows = await db.select().from(settings).where(like(settings.key, `${COMBO_KEY_PREFIX}%`));
  const combos: ComboDefinitionShape[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value || "") as ComboDefinitionShape;
      if (validateComboInput(parsed) === null) combos.push(parsed);
    } catch {
      // Ignore malformed stale settings.
    }
  }
  return combos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCombo(name: string): Promise<ComboDefinitionShape | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, comboKey(name)));
  if (!row?.value) return null;
  try {
    const combo = JSON.parse(row.value) as ComboDefinitionShape;
    return validateComboInput(combo) === null ? combo : null;
  } catch {
    return null;
  }
}

export async function saveCombo(input: Partial<ComboDefinitionShape>): Promise<ComboDefinitionShape> {
  const normalized: ComboDefinitionShape = {
    name: String(input.name || "").trim(),
    strategy: input.strategy as ComboStrategy,
    models: Array.from(new Set((input.models || []).map((model) => String(model).trim()).filter(Boolean))),
    judgeModel: input.judgeModel?.trim() || null,
  };
  const error = validateComboInput(normalized);
  if (error) throw new Error(error);
  const key = comboKey(normalized.name);
  const value = JSON.stringify(normalized);
  const [existing] = await db.select().from(settings).where(eq(settings.key, key));
  if (existing) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
  return normalized;
}

export async function deleteCombo(name: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.key, comboKey(name))));
}

export function comboModels(combos: ComboDefinitionShape[]) {
  return combos.map((combo) => ({
    id: comboModelId(combo.name),
    object: "model" as const,
    created: Date.now(),
    owned_by: "combo",
    context_window: 200000,
    max_output: 8192,
    thinking: false,
    vision: combo.strategy === "capacity_auto_switch",
  }));
}
EOF
