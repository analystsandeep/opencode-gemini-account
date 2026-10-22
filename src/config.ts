import {
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_USER_AGENT,
  CODE_ASSIST_ENDPOINT,
  CONNECTOR_VERSION,
} from "./constants.js";
import { asString, isRecord } from "./log.js";
import { loadLocalOAuthClients } from "./oauth-clients.js";

/** Which Google surface a signed-in account is served by. */
export type BackendProfile = "code-assist" | "antigravity";

/** User-facing selection: probe Code Assist first, optionally fall back to Antigravity. */
export type ProfileMode = "auto" | BackendProfile;

export type OAuthClientKind = "default" | "antigravity";

export interface OAuthClientConfig {
  clientId: string;
  clientCredential: string;
  source: "plugin-options" | "environment" | "local-file" | "unconfigured";
}

export interface ConnectorConfig {
  /** Default backend selection when signing in. */
  profileMode: ProfileMode;
  /** Whether the experimental Antigravity profile may be probed/used in `auto` mode. */
  experimentalAntigravity: boolean;
  /** Preconfigured Google Cloud project (Workspace / Code Assist Standard & Enterprise). */
  projectId?: string;
  oauthClient: OAuthClientConfig;
  /** Client used to mint tokens for the Antigravity profile (env override, else the public client). */
  antigravityOAuthClient: OAuthClientConfig;
  /** Override the Code Assist endpoint base URL (testing / enterprise routing). */
  endpointOverride?: string;
  userAgentOverride?: string;
  debug: boolean;
}

export type PluginOptionsRecord = Record<string, unknown>;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = asString(value);
    if (s) return s;
  }
  return undefined;
}

function boolOption(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function resolveClient(
  options: PluginOptionsRecord,
  env: NodeJS.ProcessEnv,
  kind: OAuthClientKind,
): OAuthClientConfig {
  const prefix = kind === "antigravity" ? "OPENCODE_GOOGLE_ANTIGRAVITY" : "OPENCODE_GOOGLE";
  const optClient = isRecord(options.oauthClient) ? options.oauthClient : undefined;
  const optAntigravity = isRecord(options.antigravityOAuthClient)
    ? options.antigravityOAuthClient
    : undefined;

  const fromOptions = kind === "antigravity" ? optAntigravity : optClient;
  const optId = firstString(fromOptions?.clientId, fromOptions?.client_id);
  const optSecret = firstString(fromOptions?.clientSecret, fromOptions?.client_secret);
  if (optId && optSecret) {
    return { clientId: optId, clientCredential: optSecret, source: "plugin-options" };
  }

  const envId = firstString(env[`${prefix}_CLIENT_ID`]);
  const envSecret = firstString(env[`${prefix}_CLIENT_SECRET`]);
  if (envId && envSecret) {
    return { clientId: envId, clientCredential: envSecret, source: "environment" };
  }

  const localClients = loadLocalOAuthClients(env);
  const local = kind === "antigravity" ? localClients.antigravity : localClients.codeAssist;
  if (local) {
    return { ...local, source: "local-file" };
  }

  return { clientId: "", clientCredential: "", source: "unconfigured" };
}

/** Resolve effective configuration from plugin options, environment, and the local OAuth client file. */
export function resolveConnectorConfig(
  options: PluginOptionsRecord = {},
  env: NodeJS.ProcessEnv = process.env,
): ConnectorConfig {
  const rawProfile = firstString(options.profile, options.profileMode, env.OPENCODE_GOOGLE_PROFILE);
  const profileMode: ProfileMode =
    rawProfile === "code-assist" || rawProfile === "antigravity" ? rawProfile : "auto";

  const experimentalAntigravity = boolOption(
    options.experimentalAntigravity,
    boolOption(env.OPENCODE_GOOGLE_EXPERIMENTAL_ANTIGRAVITY, false),
  );

  return {
    profileMode,
    experimentalAntigravity,
    projectId: firstString(
      options.projectId,
      options.project,
      env.OPENCODE_GOOGLE_PROJECT,
      env.GOOGLE_CLOUD_PROJECT,
      env.GOOGLE_CLOUD_PROJECT_ID,
    ),
    oauthClient: resolveClient(options, env, "default"),
    antigravityOAuthClient: resolveClient(options, env, "antigravity"),
    endpointOverride: firstString(options.endpoint, env.OPENCODE_GOOGLE_CODE_ASSIST_ENDPOINT)?.replace(/\/+$/, ""),
    userAgentOverride: firstString(options.userAgent, env.OPENCODE_GOOGLE_USER_AGENT),
    debug: boolOption(options.debug, boolOption(env.OPENCODE_GOOGLE_DEBUG, false)),
  };
}

const OAUTH_CLIENT_SECRET_PARAM = "client_secret";

/** Form fields that authenticate the OAuth client at the token endpoint. */
export function clientAuthFields(client: OAuthClientConfig): Record<string, string> {
  return {
    client_id: client.clientId,
    [OAUTH_CLIENT_SECRET_PARAM]: client.clientCredential,
  };
}

export function oauthClientFor(config: ConnectorConfig, kind: OAuthClientKind): OAuthClientConfig {
  return kind === "antigravity" ? config.antigravityOAuthClient : config.oauthClient;
}

export interface EndpointCandidate {
  profile: BackendProfile;
  endpoint: string;
}

/**
 * Endpoints to probe, in order, for a membership/eligibility decision.
 * Generation requests never silently fail over between endpoints (that could
 * double-spend quota); failover only happens here, during eligibility resolution.
 */
export function endpointCandidates(
  mode: ProfileMode,
  config: ConnectorConfig,
): EndpointCandidate[] {
  const codeAssist = config.endpointOverride ?? CODE_ASSIST_ENDPOINT;
  const antigravity: EndpointCandidate[] = [
    { profile: "antigravity", endpoint: ANTIGRAVITY_DAILY_ENDPOINT },
    { profile: "antigravity", endpoint: CODE_ASSIST_ENDPOINT },
  ];

  if (mode === "code-assist") return [{ profile: "code-assist", endpoint: codeAssist }];
  if (mode === "antigravity") return antigravity;

  const out: EndpointCandidate[] = [{ profile: "code-assist", endpoint: codeAssist }];
  if (config.experimentalAntigravity) out.push(...antigravity);
  return out;
}

export function defaultEndpointForProfile(profile: BackendProfile, config: ConnectorConfig): string {
  if (profile === "antigravity") return ANTIGRAVITY_DAILY_ENDPOINT;
  return config.endpointOverride ?? CODE_ASSIST_ENDPOINT;
}

function platformEnum(): string {
  const arch = process.arch === "arm64" ? "ARM64" : "AMD64";
  switch (process.platform) {
    case "darwin":
      return `DARWIN_${arch}`;
    case "win32":
      return "WINDOWS_AMD64";
    default:
      return `LINUX_${arch}`;
  }
}

/** ClientMetadata sent in loadCodeAssist/onboardUser bodies. */
export function buildClientMetadata(
  profile: BackendProfile,
  projectId?: string,
): Record<string, string> {
  if (profile === "antigravity") {
    return {
      ideType: "ANTIGRAVITY",
      platform: platformEnum(),
      pluginType: "GEMINI",
      ...(projectId ? { duetProject: projectId } : {}),
    };
  }
  // Mirrors Gemini CLI core metadata for the supported Code Assist surface.
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    ...(projectId ? { duetProject: projectId } : {}),
  };
}

export function connectorUserAgent(
  profile: BackendProfile,
  config?: Pick<ConnectorConfig, "userAgentOverride">,
  model?: string,
): string {
  if (config?.userAgentOverride) return config.userAgentOverride;
  // Antigravity's backend gates content requests on the Hub release, so the
  // experimental profile presents the Hub's own User-Agent. The regular Code
  // Assist profile keeps the connector's honest product token.
  if (profile === "antigravity") return ANTIGRAVITY_USER_AGENT;
  const suffix = model ? ` model=${model}` : "";
  return `opencode-gemini-account/${CONNECTOR_VERSION} (${profile}-profile, ${process.platform}, ${process.arch})${suffix}`;
}

/** Headers for v1internal calls. */
export function buildProfileHeaders(
  profile: BackendProfile,
  accessToken: string,
  config?: Pick<ConnectorConfig, "userAgentOverride">,
  model?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": connectorUserAgent(profile, config, model),
  };
  if (profile === "antigravity") {
    // The Antigravity Hub omits x-goog-api-client and Client-Metadata on
    // content/eligibility calls; ideType travels in the loadCodeAssist body.
    return headers;
  }
  headers["X-Goog-Api-Client"] = `opencode-gemini-account/${CONNECTOR_VERSION}`;
  return headers;
}
