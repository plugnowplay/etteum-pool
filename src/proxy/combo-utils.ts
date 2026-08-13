export type ComboStrategy = "fallback" | "round_robin" | "fusion" | "capacity_auto_switch";

export interface ComboRequestShape {
  messages?: Array<{ content?: unknown }>;
}

export interface ComboModelInfo {
  id: string;
  vision?: boolean;
}

export interface ComboDefinitionShape {
  name: string;
  strategy: ComboStrategy;
  models: string[];
  judgeModel?: string | null;
}

export function comboModelId(name: string): string {
  return `combo:${name}`;
}

export function comboNameFromModel(model: string): string | null {
  const match = /^combo:(.+)$/i.exec(model.trim());
  return match?.[1] || null;
}

export function requestCapacity(request: ComboRequestShape): "image" | "audio" | "pdf" | null {
  for (const message of request.messages || []) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      const type = String(block?.type || "").toLowerCase();
      const mime = String(block?.mime_type || block?.media_type || block?.mimeType || "").toLowerCase();
      const url = String((block?.image_url as Record<string, unknown> | undefined)?.url || block?.url || "").toLowerCase();
      if (type === "image" || type === "image_url" || mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)(?:$|\?)/.test(url)) return "image";
      if (type === "audio" || type === "input_audio" || mime.startsWith("audio/")) return "audio";
      if (type === "file" || type === "document" || mime === "application/pdf" || /\.pdf(?:$|\?)/.test(url)) return "pdf";
    }
  }
  return null;
}

export function modelSupportsCapacity(model: ComboModelInfo | undefined, capacity: ReturnType<typeof requestCapacity>): boolean {
  if (!capacity) return true;
  if (!model) return false;
  if (capacity === "image") return model.vision === true;
  // Provider model metadata currently exposes vision only. Audio/PDF-capable models
  // are opt-in through model id conventions until ModelInfo gains explicit fields.
  const id = model.id.toLowerCase();
  if (capacity === "audio") return /audio|omni|voice|whisper/.test(id);
  if (capacity === "pdf") return model.vision === true || /pdf|document|vision/.test(id);
  return false;
}

export function orderComboModels(
  combo: ComboDefinitionShape,
  request: ComboRequestShape,
  modelInfo: (id: string) => ComboModelInfo | undefined,
  roundRobinCursor = 0,
): string[] {
  const models = combo.models.filter(Boolean);
  if (models.length < 2 || combo.strategy === "fallback" || combo.strategy === "fusion") return models;
  if (combo.strategy === "round_robin") {
    const index = ((roundRobinCursor % models.length) + models.length) % models.length;
    return [...models.slice(index), ...models.slice(0, index)];
  }
  const capacity = requestCapacity(request);
  if (!capacity) return models;
  const capable = models.filter((id) => modelSupportsCapacity(modelInfo(id), capacity));
  return [...capable, ...models.filter((id) => !capable.includes(id))];
}

export function validateComboInput(input: Partial<ComboDefinitionShape>): string | null {
  if (!input.name?.trim()) return "name is required";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.name.trim())) return "name must use letters, numbers, dot, underscore, or hyphen";
  if (!input.strategy || !["fallback", "round_robin", "fusion", "capacity_auto_switch"].includes(input.strategy)) return "invalid strategy";
  if (!Array.isArray(input.models) || input.models.filter(Boolean).length === 0) return "at least one model is required";
  if (input.strategy === "fusion" && input.models.filter(Boolean).length < 2) return "fusion needs at least two panel models";
  if (input.strategy === "fusion" && !input.judgeModel?.trim()) return "fusion needs a judge model";
  return null;
}
