import type { Credential, Plugin } from "@opencode/plugin";
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration";

import {
  oauthClientFor,
  resolveConnectorConfig,
  type ConnectorConfig,
  type OAuthClientKind,
  type ProfileMode,
} from "../config.js";
import {
  DEFAULT_LOOPBACK_TIMEOUT_MS,
  MANUAL_REDIRECT_URI,
  PROVIDER_ID,
} from "../constants.js";
import { ConnectorError, OAuthError } from "../errors.js";
import { refreshAccessToken } from "../google/oauth.js";
import { DebugLog } from "../log.js";
import {
  decodeRefreshToken,
  encodeRefreshToken,
  type StoredOAuthMeta,
} from "../plugin/credentials.js";
import { createLoginSession, type CompletedLogin } from "../plugin/login.js";
import { startLoopbackReceiver, type LoopbackReceiver } from "../plugin/loopback.js";

/**
 * V2 integration surface for "Sign in with Google".
 *
 * V2 stores OAuth credentials explicitly ({ type, methodID, access, refresh,
 * expires, metadata }). We keep the connector's project/profile/endpoint
 * metadata inside the `refresh` field (the same versioned suffix the V1
 * plugin uses) so it is opaque to OpenCode and never leaked into provider
 * settings.
 */
export const OAUTH_METHOD_ID = "google-account";
export const ANTIGRAVITY_OAUTH_METHOD_ID = "google-account-antigravity";

const MANUAL_ATTEMPT_TTL_MS = 10 * 60_000;

interface OAuthMethodDefinition {
  id: string;
  label: string;
  /**
   * Backend profile to sign in with. `undefined` follows the connector
   * configuration (Code Assist by default). Antigravity is opt-in because
   * Google serves it to consumer accounts that Code Assist now rejects, but
   * it is an unofficial third-party surface.
   */
  mode?: ProfileMode;
  experimental?: boolean;
}

const OAUTH_METHODS: readonly OAuthMethodDefinition[] = [
  {
    id: OAUTH_METHOD_ID,
    label: "Sign in with Google (Gemini plan, no API key)",
  },
  {
    id: ANTIGRAVITY_OAUTH_METHOD_ID,
    label: "Sign in with Google (Antigravity / personal plan, experimental)",
    mode: "antigravity",
    experimental: true,
  },
];

export interface LoginRuntime {
  readonly config: ConnectorConfig;
  readonly log: DebugLog;
  readonly receivers: Set<LoopbackReceiver>;
  dispose(): void;
}

export function createLoginRuntime(
  config: ConnectorConfig = resolveConnectorConfig({}),
  log: DebugLog = new DebugLog(config.debug),
): LoginRuntime {
  const receivers = new Set<LoopbackReceiver>();
  return {
    config,
    log,
    receivers,
    dispose() {
      for (const receiver of receivers) receiver.close();
      receivers.clear();
    },
  };
}

function credentialFromLogin(login: CompletedLogin, methodID: string): Credential.OAuth {
  if (!login.tokens.refreshToken) {
    throw new ConnectorError("missing_refresh_token", "Google did not return a refresh token.");
  }
  return {
    type: "oauth",
    methodID: methodID as Credential.OAuth["methodID"],
    access: login.tokens.accessToken,
    refresh: encodeRefreshToken(login.tokens.refreshToken, login.meta),
    expires: login.tokens.expiresAt,
  };
}

function metaFromCredential(credential: Credential.OAuth): {
  refreshToken: string;
  meta: StoredOAuthMeta;
} {
  return decodeRefreshToken(credential.refresh);
}

function clientKindFor(meta: StoredOAuthMeta): OAuthClientKind {
  return meta.clientKind ?? (meta.profile === "antigravity" ? "antigravity" : "default");
}

function labelFor(credential: Credential.OAuth): string | undefined {
  const { meta } = metaFromCredential(credential);
  const parts = [meta.email, meta.planLabel].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

/**
 * Refresh an expired V2 OAuth credential. OpenCode calls this automatically
 * when `expires` is within five minutes (and after a failed request, where
 * applicable).
 */
export async function refreshCredential(
  runtime: LoginRuntime,
  credential: Credential.OAuth,
): Promise<Credential.OAuth> {
  const { refreshToken, meta } = metaFromCredential(credential);
  if (!refreshToken) {
    throw new OAuthError("The stored Google credential has no refresh token.", {
      hint: "Reconnect Google from OpenCode's /connect menu.",
    });
  }

  const kind = clientKindFor(meta);
  const tokens = await refreshAccessToken({
    refreshToken,
    client: oauthClientFor(runtime.config, kind),
  });

  return {
    type: "oauth",
    methodID: credential.methodID,
    access: tokens.accessToken,
    // Google may rotate the refresh token; preserve the metadata suffix either way.
    refresh: encodeRefreshToken(tokens.refreshToken ?? refreshToken, meta),
    expires: tokens.expiresAt,
    ...(credential.metadata ? { metadata: credential.metadata } : {}),
  };
}

function prefixFor(method: OAuthMethodDefinition): string {
  return method.experimental
    ? "EXPERIMENTAL: routes via Google's Antigravity consumer backend (unofficial for third-party tools; see the connector README risks section). "
    : "";
}

export type LoginCompleted = (meta: StoredOAuthMeta) => Promise<void> | void;

async function authorize(
  runtime: LoginRuntime,
  method: OAuthMethodDefinition,
  onLogin?: LoginCompleted,
): Promise<IntegrationOAuthAuthorization> {
  const backend = method.mode ?? runtime.config.profileMode;

  // Prefer the loopback flow (the browser returns automatically). If the local
  // listener cannot bind (headless/remote/port conflict), fall back to the
  // manual "paste the redirected URL" flow with the same PKCE session.
  try {
    const receiver = await startLoopbackReceiver();
    runtime.receivers.add(receiver);

    const session = createLoginSession({
      config: runtime.config,
      backend,
      redirectUri: receiver.redirectUri,
    });

    const callback = (async (): Promise<Credential.OAuth> => {
      try {
        const { code, state } = await receiver.waitForCallback();
        const callbackUrl = `${receiver.redirectUri}?code=${encodeURIComponent(code)}${
          state ? `&state=${encodeURIComponent(state)}` : ""
        }`;
        const login = await session.complete(callbackUrl);
        await onLogin?.(login.meta);
        return credentialFromLogin(login, method.id);
      } finally {
        receiver.close();
        runtime.receivers.delete(receiver);
      }
    })();

    return {
      url: session.url,
      instructions: `${prefixFor(
        method,
      )}Sign in with your Google account in the browser. You will be redirected back automatically. No API key is needed.`,
      expiresAt: Date.now() + DEFAULT_LOOPBACK_TIMEOUT_MS,
      mode: "auto",
      callback,
    };
  } catch (error) {
    runtime.log.log("Google loopback unavailable; using manual sign-in", error);

    const session = createLoginSession({
      config: runtime.config,
      backend,
      redirectUri: MANUAL_REDIRECT_URI,
    });

    return {
      url: session.url,
      instructions: `${prefixFor(
        method,
      )}Open the URL, sign in on Google's website, then paste the full redirected URL (http://127.0.0.1:8085/oauth2callback?code=...). The browser error page is expected. You can also paste just the authorization code. No API key is needed.`,
      expiresAt: Date.now() + MANUAL_ATTEMPT_TTL_MS,
      mode: "code",
      callback: async (code: string) => {
        const login = await session.complete(code);
        await onLogin?.(login.meta);
        return credentialFromLogin(login, method.id);
      },
    };
  }
}

/** Register the V2 OAuth method on OpenCode's built-in `google` integration. */
export async function registerGoogleIntegration(
  ctx: Plugin.Context,
  runtime: LoginRuntime,
  onLogin?: LoginCompleted,
): Promise<void> {
  await ctx.integration.transform((editor) => {
    for (const method of OAUTH_METHODS) {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: method.id as Credential.OAuth["methodID"],
          type: "oauth",
          label: method.label,
        },
        authorize: () => authorize(runtime, method, onLogin),
        refresh: (credential) => refreshCredential(runtime, credential),
        label: labelFor,
      });
    }
  });
}
