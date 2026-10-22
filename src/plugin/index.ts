import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import {
  oauthClientFor,
  resolveConnectorConfig,
  type OAuthClientKind,
  type ProfileMode,
} from "../config.js";
import { MANUAL_REDIRECT_URI, PLUGIN_ID, PROVIDER_ID } from "../constants.js";
import { ConnectorError } from "../errors.js";
import { DebugLog, isRecord } from "../log.js";
import {
  MODEL_CATALOG,
  reconcileProviderModels,
  toOpenCodeModelConfig,
  zeroSubscriptionCosts,
} from "../models.js";
import {
  TokenManager,
  encodeRefreshToken,
  parseStoredCredential,
  type StoredOAuthCredential,
} from "./credentials.js";
import { createGoogleFetch } from "./fetch-interceptor.js";
import { createLoginSession, type CompletedLogin } from "./login.js";
import { startLoopbackReceiver, type LoopbackReceiver } from "./loopback.js";

type AuthSetClient = {
  auth?: {
    set?: (input: { path: { id: string }; body: StoredOAuthCredential }) => Promise<unknown>;
  };
  tui?: {
    showToast?: (input: {
      body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error" };
    }) => Promise<unknown>;
  };
};

const PROJECT_PROMPT = {
  type: "text",
  key: "projectId",
  message: "Google Cloud project ID (optional). Workspace and Enterprise only. Leave empty for personal Gemini plans.",
  placeholder: "my-gcp-project (optional)",
  validate: (value: string) =>
    value && /^\d+$/.test(value.trim())
      ? "That looks like a project number. Use the string project ID (e.g. my-project-123)."
      : undefined,
} as const;

/**
 * OpenCode Gemini Account.
 *
 * Registers "Sign in with Google" on OpenCode's built-in `google` provider:
 * browser OAuth (PKCE + loopback), server-side Gemini-plan eligibility, and a
 * fetch interceptor that routes @ai-sdk/google traffic to the account's
 * Code Assist / Antigravity backend with a Bearer token. No API key is used.
 */
export const GoogleAccountConnectorPlugin: Plugin = async (ctx, options) => {
  const config = resolveConnectorConfig(options ?? {});
  const log = new DebugLog(config.debug);
  const client = ctx.client as unknown as AuthSetClient;
  const activeReceivers = new Set<LoopbackReceiver>();

  const persist = async (credential: StoredOAuthCredential): Promise<void> => {
    if (!client.auth?.set) return;
    await client.auth.set({ path: { id: PROVIDER_ID }, body: credential });
  };

  const toastConnected = (login: CompletedLogin): void => {
    try {
      void client.tui?.showToast?.({
        body: {
          title: "Google account connected",
          message: `${login.email ?? "Signed in"} • ${login.eligibility.planLabel}. Pick a model with /models.`,
          variant: "success",
        },
      });
    } catch {
      // Toasts are cosmetic.
    }
  };

  const finishLogin = (login: CompletedLogin) => {
    if (!login.tokens.refreshToken) {
      throw new ConnectorError("missing_refresh_token", "Google did not return a refresh token.");
    }
    toastConnected(login);
    return {
      type: "success" as const,
      access: login.tokens.accessToken,
      refresh: encodeRefreshToken(login.tokens.refreshToken, login.meta),
      expires: login.tokens.expiresAt,
      accountId: login.email ?? login.subject,
    };
  };

  const makeAutoMethod = (backend: ProfileMode, label: string, instructionsPrefix: string) => ({
    type: "oauth" as const,
    label,
    prompts: [PROJECT_PROMPT],
    async authorize(inputs?: Record<string, string>) {
      const receiver = await startLoopbackReceiver();
      activeReceivers.add(receiver);
      const session = createLoginSession({
        config,
        backend,
        redirectUri: receiver.redirectUri,
        configuredProjectId: inputs?.projectId?.trim() || undefined,
      });
      return {
        url: session.url,
        instructions: `${instructionsPrefix} Finish signing in on Google's website. You will be redirected back automatically. No API key is needed.`,
        method: "auto" as const,
        async callback() {
          try {
            const { code, state } = await receiver.waitForCallback();
            const callbackUrl = `${receiver.redirectUri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
            const login = await session.complete(callbackUrl);
            return finishLogin(login);
          } finally {
            receiver.close();
            activeReceivers.delete(receiver);
          }
        },
      };
    },
  });

  return {
    async dispose() {
      for (const receiver of activeReceivers) receiver.close();
      activeReceivers.clear();
    },

    // Make subscription models selectable even if models.dev hasn't catalogued
    // a preview yet. User-defined entries always win.
    async config(cfg) {
      const root = cfg as unknown as Record<string, unknown>;
      if (!isRecord(root.provider)) root.provider = {};
      const providers = root.provider as Record<string, unknown>;
      if (!isRecord(providers[PROVIDER_ID])) providers[PROVIDER_ID] = {};
      const google = providers[PROVIDER_ID] as Record<string, unknown>;
      if (!isRecord(google.models)) google.models = {};
      const models = google.models as Record<string, unknown>;
      for (const model of MODEL_CATALOG) {
        if (!(model.id in models)) models[model.id] = toOpenCodeModelConfig(model);
      }
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        let auth: unknown;
        try {
          auth = await getAuth();
        } catch {
          return {};
        }
        const credentials = parseStoredCredential(auth);
        if (!credentials) {
          // API-key credential (or none): leave the built-in provider untouched.
          return {};
        }

        const providerRecord = provider as unknown as Record<string, unknown>;
        if (isRecord(providerRecord.models)) {
          zeroSubscriptionCosts(providerRecord.models);
          const removed = reconcileProviderModels(
            providerRecord.models,
            credentials.meta.availableModelIds,
          );
          if (removed.length > 0) log.log("hid models not on this account", removed);
        }

        const tokenManager = new TokenManager({
          getAuth: () => getAuth() as Promise<unknown>,
          persist,
          clientFor: (kind: OAuthClientKind) => oauthClientFor(config, kind),
          log,
        });

        return {
          // @ai-sdk/google insists on a non-empty key; the interceptor replaces
          // it with `Authorization: Bearer <OAuth token>` on every request.
          apiKey: "google-account-oauth",
          fetch: createGoogleFetch({ tokenManager, config, log }),
        };
      },

      methods: [
        makeAutoMethod(
          "auto",
          "Sign in with Google (Gemini plan, no API key)",
          "Use your Gemini plan (free, AI Pro or Ultra where eligible, or Code Assist Standard or Enterprise) directly in OpenCode.",
        ),
        makeAutoMethod(
          "antigravity",
          "Sign in with Google (Antigravity / personal plan, experimental)",
          "EXPERIMENTAL: routes via Google's Antigravity consumer backend. This is unofficial for third-party tools. See the connector README risks section before using.",
        ),
        {
          type: "oauth" as const,
          label: "Sign in with Google (manual paste, headless or remote)",
          prompts: [PROJECT_PROMPT],
          async authorize(inputs?: Record<string, string>) {
            const session = createLoginSession({
              config,
              backend: config.profileMode,
              redirectUri: MANUAL_REDIRECT_URI,
              configuredProjectId: inputs?.projectId?.trim() || undefined,
            });
            return {
              url: session.url,
              instructions:
                "Open the URL, sign in on Google's website, then paste the full redirected URL (http://127.0.0.1:8085/oauth2callback?code=...). The error page is expected. You can also paste just the authorization code.",
              method: "code" as const,
              async callback(code: string) {
                const login = await session.complete(code);
                return finishLogin(login);
              },
            };
          },
        },
        {
          type: "api" as const,
          label: "Manually enter Gemini API key",
        },
      ],
    },
  };
};

export const GoogleOAuthPlugin = GoogleAccountConnectorPlugin;

const pluginModule: PluginModule = {
  id: PLUGIN_ID,
  server: GoogleAccountConnectorPlugin,
};

export default pluginModule;
