import { createHash } from "node:crypto";

import type { BackendProfile, OAuthClientKind } from "../config.js";
import { TOKEN_REFRESH_SKEW_MS } from "../constants.js";
import { OAuthError } from "../errors.js";
import { base64UrlDecodeToString, base64UrlEncode, refreshAccessToken, type TokenSet } from "../google/oauth.js";
import { DebugLog, isRecord } from "../log.js";

/**
 * OpenCode's stored OAuth credential shape is fixed:
 *   { type: "oauth", access, refresh, expires, accountId? }
 * There is no free-form metadata slot, yet we must remember which project /
 * backend profile / OAuth client a refresh token belongs to. Following the
 * convention of other OpenCode subscription plugins, we version-encode that
 * metadata as a suffix on our own `refresh` value:
 *
 *   <refresh_token>|gac1.<base64url(JSON meta)>
 *
 * Parsing is backward compatible: a bare refresh token yields empty metadata,
 * and malformed suffixes are ignored rather than breaking sign-in.
 */
export interface StoredOAuthMeta {
  v: 1;
  projectId?: string;
  managedProjectId?: string;
  profile?: BackendProfile;
  endpoint?: string;
  clientKind?: OAuthClientKind;
  email?: string;
  tierId?: string;
  planLabel?: string;
  availableModelIds?: string[];
  modelsCheckedAt?: number;
}

const META_PREFIX = "gac1.";

export function encodeRefreshToken(refreshToken: string, meta?: StoredOAuthMeta): string {
  if (!meta || Object.keys(meta).filter((k) => k !== "v").length === 0) return refreshToken;
  const payload = base64UrlEncode(Buffer.from(JSON.stringify({ ...meta, v: 1 }), "utf8"));
  return `${refreshToken}|${META_PREFIX}${payload}`;
}

export function decodeRefreshToken(encoded: string | undefined): {
  refreshToken: string;
  meta: StoredOAuthMeta;
} {
  const fallback: StoredOAuthMeta = { v: 1 };
  if (!encoded) return { refreshToken: "", meta: fallback };
  const separator = encoded.lastIndexOf(`|${META_PREFIX}`);
  if (separator === -1) return { refreshToken: encoded, meta: fallback };
  const refreshToken = encoded.slice(0, separator);
  try {
    const parsed: unknown = JSON.parse(base64UrlDecodeToString(encoded.slice(separator + META_PREFIX.length + 1)));
    if (!isRecord(parsed)) return { refreshToken, meta: fallback };
    return { refreshToken, meta: { ...fallback, ...(parsed as unknown as StoredOAuthMeta), v: 1 } };
  } catch {
    return { refreshToken, meta: fallback };
  }
}

export interface StoredOAuthCredential {
  type: "oauth";
  access?: string;
  refresh: string;
  expires?: number;
  accountId?: string;
}

export interface ResolvedCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  meta: StoredOAuthMeta;
}

export function parseStoredCredential(auth: unknown): ResolvedCredentials | undefined {
  if (!isRecord(auth) || auth.type !== "oauth" || typeof auth.refresh !== "string") return undefined;
  const { refreshToken, meta } = decodeRefreshToken(auth.refresh);
  if (!refreshToken) return undefined;
  return {
    accessToken: typeof auth.access === "string" ? auth.access : "",
    refreshToken,
    expiresAt: typeof auth.expires === "number" ? auth.expires : 0,
    meta,
  };
}

export function toStoredCredential(credentials: ResolvedCredentials, accountId?: string): StoredOAuthCredential {
  return {
    type: "oauth",
    access: credentials.accessToken,
    refresh: encodeRefreshToken(credentials.refreshToken, credentials.meta),
    expires: credentials.expiresAt,
    ...(accountId ? { accountId } : {}),
  };
}

export interface TokenManagerDeps {
  getAuth: () => Promise<unknown>;
  persist?: (credential: StoredOAuthCredential) => Promise<void>;
  clientFor: (kind: OAuthClientKind) => { clientId: string; clientCredential: string };
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  refreshFn?: (refreshToken: string, kind: OAuthClientKind) => Promise<TokenSet>;
  now?: () => number;
  log?: DebugLog;
}

const inflightRefresh = new Map<string, Promise<ResolvedCredentials>>();

/**
 * Owns access-token freshness: proactive refresh inside the skew window,
 * single-flight de-duplication of concurrent refreshes, refresh-token
 * rotation, and persistence back into OpenCode's credential store.
 */
export class TokenManager {
  private memory?: ResolvedCredentials;

  constructor(private readonly deps: TokenManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async getCredentials(): Promise<ResolvedCredentials> {
    const stored = parseStoredCredential(await this.deps.getAuth());
    if (!stored) {
      if (this.memory) return this.memory;
      throw new OAuthError("No Google OAuth credential is stored in OpenCode.", {
        hint: "Connect Google from OpenCode's /connect menu (\"Sign in with Google\"), then try again.",
      });
    }
    // If persistence failed earlier, an in-memory refresh may be newer than disk.
    if (
      this.memory &&
      this.memory.refreshToken === stored.refreshToken &&
      this.memory.expiresAt > stored.expiresAt
    ) {
      return { ...this.memory, meta: { ...stored.meta, ...this.memory.meta } };
    }
    return stored;
  }

  async getValidCredentials(forceRefresh = false): Promise<ResolvedCredentials> {
    const credentials = await this.getCredentials();
    const fresh = credentials.accessToken && credentials.expiresAt > this.now() + TOKEN_REFRESH_SKEW_MS;
    if (fresh && !forceRefresh) return credentials;
    return this.refresh(credentials);
  }

  private async refresh(credentials: ResolvedCredentials): Promise<ResolvedCredentials> {
    const key = createHash("sha256").update(credentials.refreshToken).digest("hex");
    const existing = inflightRefresh.get(key);
    if (existing) return existing;

    const kind: OAuthClientKind =
      credentials.meta.clientKind ?? (credentials.meta.profile === "antigravity" ? "antigravity" : "default");

    const promise = (async (): Promise<ResolvedCredentials> => {
      this.deps.log?.log("refreshing Google access token");
      const tokens = this.deps.refreshFn
        ? await this.deps.refreshFn(credentials.refreshToken, kind)
        : await refreshAccessToken({
            refreshToken: credentials.refreshToken,
            client: { ...this.deps.clientFor(kind), source: "environment" },
            fetchImpl: this.deps.fetchImpl,
          });
      const refreshed: ResolvedCredentials = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? credentials.refreshToken,
        expiresAt: tokens.expiresAt,
        meta: credentials.meta,
      };
      this.memory = refreshed;
      await this.persist(refreshed);
      return refreshed;
    })();

    inflightRefresh.set(key, promise);
    try {
      return await promise;
    } finally {
      inflightRefresh.delete(key);
    }
  }

  /** Persist updated metadata (project/profile/models) alongside the current tokens. */
  async updateMeta(patch: Partial<StoredOAuthMeta>): Promise<ResolvedCredentials> {
    const current = await this.getCredentials();
    const updated: ResolvedCredentials = { ...current, meta: { ...current.meta, ...patch, v: 1 } };
    this.memory = updated;
    await this.persist(updated);
    return updated;
  }

  private async persist(credentials: ResolvedCredentials): Promise<void> {
    if (!this.deps.persist) return;
    try {
      await this.deps.persist(toStoredCredential(credentials, credentials.meta.email));
    } catch (error) {
      // Non-fatal: the in-memory copy keeps this process working.
      this.deps.log?.log("credential persistence failed", error);
    }
  }
}
