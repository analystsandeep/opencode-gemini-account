import type { Plugin } from "@opencode/plugin";

import { resolveConnectorConfig } from "../config.js";
import { PLUGIN_ID } from "../constants.js";
import { DebugLog } from "../log.js";
import { GoogleAccountConnectorPlugin } from "../plugin/index.js";
import { createLoginRuntime, registerGoogleIntegration } from "./auth.js";
import { registerGoogleHttpHooks } from "./http.js";
import { initialGoogleAvailableModelIds, registerGoogleModels } from "./models.js";

/**
 * OpenCode 2 native entrypoint.
 *
 * OpenCode 1 only runs the `server` plugin shape. Keeping both properties on
 * the default export lets a V1 host that resolves this file (for example via
 * the package's `./server` export) keep working, while V2 looks for `setup`.
 */
export const GoogleAccountConnectorV2: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolveConnectorConfig(ctx.options);
    const log = new DebugLog(config.debug);
    const runtime = createLoginRuntime(config, log);

    const models = await registerGoogleModels(ctx, await initialGoogleAvailableModelIds(ctx));
    await registerGoogleIntegration(ctx, runtime, (meta) => models.sync(meta.availableModelIds));
    await registerGoogleHttpHooks(ctx, { config, log });

    return () => runtime.dispose();
  },
};

const plugin = {
  ...GoogleAccountConnectorV2,
  server: GoogleAccountConnectorPlugin,
};

export default plugin;
