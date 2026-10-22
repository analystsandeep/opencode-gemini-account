import { createHash, randomBytes } from "node:crypto";

import {
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from "../constants.js";
import { clientAuthFields, type OAuthClientConfig } from "../config.js";
import { OAuthError } from "../errors.js";
import { asString, isRecord, redactSecrets } from "../log.js";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  tokenType?: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface UserInfo {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  hostedDomain?: string;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecodeToString(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function randomState(): string {
  return base64UrlEncode(randomBytes(32));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** RFC 7636 PKCE pair. Accepts an explicit verifier for test vectors. */
export function createPkcePair(verifier: string = base64UrlEncode(randomBytes(48))): PkcePair {
  const challenge = base64UrlEncode(createHash("sha256").update(verifier, "utf8").digest());
  return { verifier, challenge, method: "S256" };
}

export interface AuthorizationUrlOptions {
  client: OAuthClientConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  loginHint?: string;
}

export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", options.client.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? GOOGLE_OAUTH_SCOPES).join(" "));
  // offline + consent guarantees a refresh token is issued on every fresh sign-in.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

export interface ParsedCallback {
  code: string;
  state?: string;
}

/**
 * Accept a full redirect URL, a bare query string, or a bare authorization code.
 * Throws OAuthError on `error` params or a state mismatch (CSRF guard).
 */
export function parseAuthorizationCallback(input: string, expectedState?: string): ParsedCallback {
  const raw = input.trim();
  if (!raw) throw new OAuthError("No authorization code was provided.");

  let params: URLSearchParams | undefined;
  if (/^https?:\/\//i.test(raw)) {
    try {
      params = new URL(raw).searchParams;
    } catch {
      throw new OAuthError("The pasted value is not a valid URL.");
    }
  } else if (raw.includes("code=") || raw.includes("error=")) {
    params = new URLSearchParams(raw.replace(/^[?#]/, ""));
  }

  if (!params) {
    // Bare code: state can't be checked; PKCE still binds the exchange to this session.
    return { code: raw };
  }

  const error = params.get("error");
  if (error) {
    const description = params.get("error_description") ?? undefined;
    throw new OAuthError(`Google returned an authorization error: ${error}${description ? ` (${description})` : ""}`, {
      oauthError: error,
    });
  }

  const code = params.get("code");
  if (!code) throw new OAuthError("The redirect URL does not contain an authorization code.");

  const state = params.get("state") ?? undefined;
  if (expectedState && state && state !== expectedState) {
    throw new OAuthError("OAuth state mismatch. Sign-in aborted for security.", { oauthError: "state_mismatch" });
  }
  if (expectedState && !state) {
    throw new OAuthError("OAuth callback is missing its state parameter. Sign-in aborted for security.", {
      oauthError: "state_missing",
    });
  }
  return { code, state };
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (cause) {
    throw new OAuthError("Could not reach Google's token endpoint (network error).", { cause });
  }

  const text = await response.text();
  let payload: RawTokenResponse = {};
  try {
    payload = JSON.parse(text) as RawTokenResponse;
  } catch {
    // fall through to the generic error below
  }

  if (!response.ok || !payload.access_token) {
    const oauthError = payload.error ?? `http_${response.status}`;
    const description = payload.error_description ?? redactSecrets(text.slice(0, 300));
    throw new OAuthError(`Google token request failed (${oauthError}): ${description}`, {
      oauthError: payload.error,
      status: response.status,
      hint:
        payload.error === "invalid_grant"
          ? "The stored Google session is no longer valid. Sign in again from OpenCode's /connect menu."
          : undefined,
    });
  }

  const expiresInSeconds = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    scope: payload.scope,
    tokenType: payload.token_type,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

export interface ExchangeCodeOptions {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  client: OAuthClientConfig;
  fetchImpl?: typeof fetch;
}

export async function exchangeAuthorizationCode(options: ExchangeCodeOptions): Promise<TokenSet> {
  const tokens = await postToken(
    {
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      ...clientAuthFields(options.client),
    },
    options.fetchImpl ?? fetch,
  );
  if (!tokens.refreshToken) {
    throw new OAuthError("Google did not return a refresh token for this sign-in.", {
      hint: "Revoke this app's access at https://myaccount.google.com/permissions and sign in again so a fresh refresh token is issued.",
    });
  }
  return tokens;
}

export async function refreshAccessToken(options: {
  refreshToken: string;
  client: OAuthClientConfig;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  return postToken(
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      ...clientAuthFields(options.client),
    },
    options.fetchImpl ?? fetch,
  );
}

/**
 * Decode (not verify) an ID-token payload. Safe here because the token arrives
 * directly from Google's token endpoint over TLS in response to our own request;
 * claims are used for display (email) and account hints, never for authorization.
 */
export function decodeJwtClaims(idToken: string | undefined): Record<string, unknown> | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecodeToString(parts[1] ?? ""));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUserInfo(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserInfo> {
  const response = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new OAuthError(`Google userinfo request failed (HTTP ${response.status}).`, { status: response.status });
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) return {};
  return {
    sub: asString(payload.sub),
    email: asString(payload.email),
    emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
    name: asString(payload.name),
    picture: asString(payload.picture),
    hostedDomain: asString(payload.hd),
  };
}

/** Best-effort token revocation (used by `logout`). Never throws. */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
