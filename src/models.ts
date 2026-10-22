import { isRecord } from "./log.js";

/**
 * Curated fallback catalog. At sign-in we try `fetchAvailableModels` and store
 * what the account can actually use; the loader then hides catalog entries the
 * account doesn't have. Entries here are the model IDs the Code Assist /
 * Antigravity backends serve (per Gemini CLI's model registry).
 */
export interface ConnectorModel {
  id: string;
  name: string;
  context: number;
  output: number;
  reasoning: boolean;
  imageInput: boolean;
  /** True for models that only exist as previews on the subscription backends. */
  preview?: boolean;
}

export const MODEL_CATALOG: readonly ConnectorModel[] = [
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true, preview: true },
  { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true, preview: true },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true, preview: true },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite (Google account)", context: 1_048_576, output: 65_536, reasoning: true, imageInput: true },
] as const;

export const CATALOG_MODEL_IDS: ReadonlySet<string> = new Set(MODEL_CATALOG.map((m) => m.id));

/** Model config object in the shape OpenCode's provider config schema expects. */
export function toOpenCodeModelConfig(model: ConnectorModel): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: model.name,
    limit: { context: model.context, output: model.output },
    modalities: {
      input: model.imageInput ? ["text", "image", "pdf"] : ["text"],
      output: ["text"],
    },
    // Subscription quota, not per-token billing: display $0 like other plan-based providers.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  };
  if (model.reasoning && model.id.startsWith("gemini-3")) {
    config.variants = {
      low: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
      high: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
    };
  }
  return config;
}

export function normalizeModelId(id: string): string {
  return id.replace(/^models\//, "").replace(/^antigravity-/, "").trim();
}

/**
 * Hide catalog models the account doesn't have. Deliberately conservative:
 * - no availability data → change nothing;
 * - availability shares nothing with the catalog (unexpected ID scheme) →
 *   change nothing rather than emptying the picker;
 * - non-catalog models (user's own config, other plugins) are never touched.
 */
export function reconcileProviderModels(
  providerModels: Record<string, unknown>,
  availableModelIds: readonly string[] | undefined,
): string[] {
  if (!availableModelIds || availableModelIds.length === 0) return [];
  const available = new Set(availableModelIds.map(normalizeModelId));
  const knownAvailable = MODEL_CATALOG.filter((m) => available.has(m.id));
  if (knownAvailable.length === 0) return [];

  const removed: string[] = [];
  for (const modelId of Object.keys(providerModels)) {
    if (CATALOG_MODEL_IDS.has(modelId) && !available.has(modelId)) {
      delete providerModels[modelId];
      removed.push(modelId);
    }
  }
  return removed;
}

/** Zero the displayed cost of catalog models already defined by models.dev/config. */
export function zeroSubscriptionCosts(providerModels: Record<string, unknown>): void {
  for (const [modelId, value] of Object.entries(providerModels)) {
    if (!CATALOG_MODEL_IDS.has(modelId) || !isRecord(value)) continue;
    value.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  }
}
