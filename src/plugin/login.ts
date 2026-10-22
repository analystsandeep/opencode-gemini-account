import {
  oauthClientFor,
  type BackendProfile,
  type ConnectorConfig,
  type OAuthClientKind,
  type ProfileMode,
} from "../config.js";
import { ANTIGRAVITY_OAUTH_SCOPES } from "../constants.js";
import { ConnectorError, EligibilityError } from "../errors.js";
import { resolveAccountAccess, type EligibilityResult } from "../google/codeassist.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  decodeJwtClaims,
  exchangeAuthorizationCode,
  fetchUserInfo,
  parseAuthorizationCallback,
  randomState,
  type TokenSet,
} from "../google/oauth.js";
import type { StoredOAuthMeta } from "./credentials.js";

/**
 * One in-flight "Sign in with Google" attempt: everything needed to render the
 * Google URL now and to finish (token exchange + eligibility + model
 * discovery) when the authorization code comes back, via loopback or paste.
 */
export interface LoginSession {
  url: string;
  state: string;
  redirectUri: string;
  backend: ProfileMode;
  complete: (callbackInput: string) => Promise<CompletedLogin>;
}

export interface CompletedLogin {
  tokens: TokenSet;
  eligibility: EligibilityResult;
  email?: string;
  subject?: string;
  meta: StoredOAuthMeta;
}

export interface CreateLoginSessionOptions {
  config: ConnectorConfig;
  backend: ProfileMode;
  redirectUri: string;
  configuredProjectId?: string;
  fetchImpl?: typeof fetch;
}

export function clientKindForBackend(backend: ProfileMode): OAuthClientKind {
  return backend === "antigravity" ? "antigravity" : "default";
}

export function createLoginSession(options: CreateLoginSessionOptions): LoginSession {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const kind = clientKindForBackend(options.backend);
  const client = oauthClientFor(config, kind);
  if (!client.clientId || !client.clientCredential) {
    const profile = kind === "antigravity" ? "Antigravity" : "Code Assist";
    throw new ConnectorError(
      "oauth_client_missing",
      `No OAuth client is configured for the ${profile} sign-in method.`,
      {
        hint:
          kind === "antigravity"
            ? "Set OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_ID and OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET, or add the antigravity profile to oauth-clients.json. The published npm package includes it. See oauth-clients.example.json."
            : "Set OPENCODE_GOOGLE_CLIENT_ID and OPENCODE_GOOGLE_CLIENT_SECRET, or add the codeAssist profile to oauth-clients.json. The published npm package includes it. See oauth-clients.example.json.",
      },
    );
  }
  const state = randomState();
  const pkce = createPkcePair();

  const url = buildAuthorizationUrl({
    client,
    redirectUri: options.redirectUri,
    state,
    codeChallenge: pkce.challenge,
    // Antigravity's backend requires its own scopes in addition to cloud-platform.
    scopes: kind === "antigravity" ? ANTIGRAVITY_OAUTH_SCOPES : undefined,
  });

  const complete = async (callbackInput: string): Promise<CompletedLogin> => {
    const { code } = parseAuthorizationCallback(callbackInput, state);
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: pkce.verifier,
      redirectUri: options.redirectUri,
      client,
      fetchImpl,
    });

    // Identity is best-effort: userinfo first, ID-token claims as fallback.
    let email: string | undefined;
    let subject: string | undefined;
    try {
      const info = await fetchUserInfo(tokens.accessToken, fetchImpl);
      email = info.email;
      subject = info.sub;
    } catch {
      const claims = decodeJwtClaims(tokens.idToken);
      email = typeof claims?.email === "string" ? claims.email : undefined;
      subject = typeof claims?.sub === "string" ? claims.sub : undefined;
    }

    const eligibility = await resolveAccountAccess({
      accessToken: tokens.accessToken,
      config,
      mode: options.backend,
      configuredProjectId: options.configuredProjectId ?? config.projectId,
      fetchImpl,
    });
    if (eligibility.status !== "eligible") {
      throw new EligibilityError(eligibility);
    }

    const profile: BackendProfile = eligibility.profile;
    const meta: StoredOAuthMeta = {
      v: 1,
      projectId: eligibility.projectId,
      managedProjectId: eligibility.managedProjectId,
      profile,
      endpoint: eligibility.endpoint,
      clientKind: kind,
      email,
      tierId: eligibility.tierId,
      planLabel: eligibility.planLabel,
      availableModelIds: eligibility.availableModelIds,
      modelsCheckedAt: eligibility.availableModelIds ? Date.now() : undefined,
    };

    return { tokens, eligibility, email, subject, meta };
  };

  return { url, state, redirectUri: options.redirectUri, backend: options.backend, complete };
}
