import { Model, type Plugin } from "@opencode/plugin";

import { PROVIDER_ID } from "../constants.js";
import { MODEL_CATALOG, normalizeModelId, type ConnectorModel } from "../models.js";
import { decodeRefreshToken } from "../plugin/credentials.js";

type ShallowMutable<T> = { -readonly [K in keyof T]: T[K] };

function zeroCost(): Model.Info["cost"] {
  return [
    {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
  ] as unknown as Model.Info["cost"];
}

function variantsFor(model: ConnectorModel): Model.Info["variants"] {
  if (!model.reasoning || !model.id.startsWith("gemini-3")) return [];
  return [
    {
      id: "low" as Model.VariantID,
      settings: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
    },
    {
      id: "high" as Model.VariantID,
      settings: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
    },
  ] as unknown as Model.Info["variants"];
}

function modelFromCatalog(model: ConnectorModel): Model.Info {
  const base = Model.Info.default(
    PROVIDER_ID as Model.Info["providerID"],
    model.id as Model.Info["id"],
  ) as unknown as ShallowMutable<Model.Info>;

  base.name = model.name;
  base.capabilities = {
    tools: true,
    input: model.imageInput ? ["text", "image", "pdf"] : ["text"],
    output: ["text"],
  };
  base.limit = { context: model.context, output: model.output };
  base.cost = zeroCost();
  base.variants = variantsFor(model);
  base.status = model.preview ? "beta" : "active";
  base.enabled = true;
  return base;
}

/** Inventory IDs that aren't text-generation models served through this connector. */
const NON_TEXT_MODEL =
  /(?:^chat_|^tab_|^jump_|disabled|embedding|image|lyria|live|computer-use|deep-research)/i;

function friendlyName(id: string): string {
  return id
    .replace(/^antigravity-/, "")
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function modelFromAvailableId(id: string): Model.Info {
  const base = Model.Info.default(
    PROVIDER_ID as Model.Info["providerID"],
    id as Model.Info["id"],
  ) as unknown as ShallowMutable<Model.Info>;

  base.name = `${friendlyName(id)} (Google account)`;
  base.capabilities = { tools: true, input: ["text", "image", "pdf"], output: ["text"] };
  base.limit = { context: 1_048_576, output: 65_536 };
  base.cost = zeroCost();
  base.variants =
    id.startsWith("gemini-3") && !/-(?:high|medium|low|extra-low|tiered)$/.test(id)
      ? variantsFor({ id } as ConnectorModel)
      : [];
  base.status = "active";
  base.enabled = true;
  return base;
}

async function activeAvailableModelIds(ctx: Plugin.Context): Promise<string[]> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return [];
    const value = await ctx.integration.connection.resolve(connection);
    if (!value || value.type !== "oauth") return [];
    return decodeRefreshToken(value.refresh).meta.availableModelIds ?? [];
  } catch {
    return [];
  }
}

export interface GoogleModelRegistry {
  /** Replace the account inventory and re-run the provider transform. */
  sync(availableModelIds: readonly string[] | undefined): Promise<void>;
}

/**
 * Add the Code Assist model catalog to the built-in `google` provider.
 *
 * Existing models keep their user/ models.dev definitions except for the
 * displayed subscription price; only missing catalog entries are created.
 * `models.set` is used because the provider editor's `models.update` only
 * edits source models that already exist.
 */
export async function registerGoogleModels(
  ctx: Plugin.Context,
  initialAvailableModelIds: readonly string[] = [],
): Promise<GoogleModelRegistry> {
  const inventory = new Set(initialAvailableModelIds.map(normalizeModelId));

  await ctx.provider.transform((editor) => {
    const record = editor.get(PROVIDER_ID);
    if (!record) return;

    const models = new Map(record.models);
    for (const model of MODEL_CATALOG) {
      const existing = models.get(model.id);
      if (existing) {
        models.set(model.id, {
          ...existing,
          cost: zeroCost(),
          ...(model.reasoning && model.id.startsWith("gemini-3")
            ? { variants: variantsFor(model) }
            : {}),
        });
        continue;
      }
      models.set(model.id, modelFromCatalog(model));
    }

    // Antigravity serves account-specific IDs (for example
    // `gemini-3.8-flash-high`) that models.dev doesn't know about. Expose the
    // account's real inventory so requests don't 404 on a friendly alias.
    for (const id of inventory) {
      if (!id || NON_TEXT_MODEL.test(id) || models.has(id)) continue;
      models.set(id, modelFromAvailableId(id));
    }

    // Hide friendly catalog aliases the backend doesn't serve (for example
    // `gemini-3.8-flash` when the account only has `gemini-3.8-flash-high`).
    // Only act when the inventory overlaps the catalog, so an unexpected ID
    // scheme never empties the picker.
    if (MODEL_CATALOG.some((model) => inventory.has(model.id))) {
      for (const model of MODEL_CATALOG) {
        if (!inventory.has(model.id)) models.delete(model.id);
      }
    }

    editor.models.set(PROVIDER_ID, [...models.values()]);
  });

  return {
    async sync(availableModelIds) {
      inventory.clear();
      for (const id of availableModelIds ?? []) inventory.add(normalizeModelId(id));
      await ctx.provider.reload();
    },
  };
}

/** Read the active OAuth connection's account inventory at plugin startup. */
export async function initialGoogleAvailableModelIds(ctx: Plugin.Context): Promise<string[]> {
  return activeAvailableModelIds(ctx);
}
