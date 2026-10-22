/**
 * Protocol constants.
 *
 * OAuth client values are not stored in this package. They are loaded from an
 * untracked oauth-clients.json file, plugin options, or environment variables.
 * See src/config.ts and src/oauth-clients.ts.
 */

/** Keep in sync with package.json `version` at release time. */
export const CONNECTOR_VERSION = "0.1.0";

export const PLUGIN_ID = "opencode-gemini-account";

/** We attach to OpenCode's built-in Google provider so /connect and /models just work. */
export const PROVIDER_ID = "google";

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * Scopes requested at sign-in. `cloud-platform` is required by the Code Assist API;
 * email/profile let us show *which* account is connected. No Drive/Gmail/etc. scopes.
 */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
];

/** Antigravity sign-in scopes: cloud-platform plus Hub telemetry/experiments scopes. */
export const ANTIGRAVITY_OAUTH_SCOPES: readonly string[] = [
  ...GOOGLE_OAUTH_SCOPES,
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Production Cloud Code Assist API (Gemini CLI / Code Assist Standard & Enterprise). */
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** Antigravity consumer endpoint (daily). Used only by the experimental profile. */
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

/**
 * User-Agent reported by Google's Antigravity Hub. The backend ties content
 * access to the Hub release, so third-party clients must present this shape.
 */
export const ANTIGRAVITY_HUB_VERSION = "2.24.0";
export const ANTIGRAVITY_HUB_CHANGELIST = "1000335682";
export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_HUB_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=${ANTIGRAVITY_HUB_CHANGELIST})`;

export const CODE_ASSIST_API_VERSION = "v1internal";

export const LOOPBACK_PATH = "/oauth2callback";
export const PREFERRED_LOOPBACK_PORT = 8085;
/** Fixed redirect used by the manual "paste the URL" method (nothing listens there; the browser error page still shows the URL with the code). */
export const MANUAL_REDIRECT_URI = `http://127.0.0.1:${PREFERRED_LOOPBACK_PORT}${LOOPBACK_PATH}`;

export const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60_000;
export const TOKEN_REFRESH_SKEW_MS = 60_000;
