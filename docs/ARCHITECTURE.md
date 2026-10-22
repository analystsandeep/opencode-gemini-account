# Architecture

This document explains how the connector is structured, why the pieces exist, and which invariants maintainers should preserve.

## 1. Goals and non-goals

**Goals**

1. Let users sign in with Google and use Gemini in OpenCode without handling an API key.
2. Treat eligibility as a server verdict. Show Google's response verbatim and never infer a plan from the account type.
3. Keep the supported Code Assist path working with zero configuration. Offer the experimental Antigravity consumer path only when the user chooses it.
4. Keep zero runtime dependencies. Make every Google interaction mockable and testable offline.
5. Keep credentials in OpenCode's store. Do not create a parallel secret file.

**Non-goals**

- Multi-account rotation or pooling to stretch quotas.
- Spoofing first-party client build fingerprints.
- Scraping `gemini.google.com` web sessions or cookies.
- Silent endpoint failover for generation requests, which could double-spend quota.

## 2. Module map

```
src/
  constants.ts                Endpoints, scopes, provider id, loopback defaults
  oauth-clients.ts            Loader for the optional local public OAuth client file
  config.ts                   Option and environment resolution, profiles, endpoints, headers
  errors.ts                   ConnectorError, OAuthError, CodeAssistError, EligibilityError
  log.ts                      Redacting debug logger and small helpers
  models.ts                   Fallback catalog, OpenCode model config, picker reconciliation
  google/
    oauth.ts                  PKCE, authorize URL, callback parsing, token exchange and refresh
    codeassist.ts             v1internal client and eligibility resolver
    transform.ts              Public Gemini and v1internal envelope translation for JSON and SSE
  plugin/
    index.ts                  OpenCode V1 entry, config hook, auth hook, fetch interceptor
    login.ts                  One sign-in attempt from URL to exchange, eligibility, and metadata
    loopback.ts               RFC 8252 loopback receiver on 127.0.0.1
    credentials.ts            Refresh-value metadata codec and TokenManager
    fetch-interceptor.ts      Per-request routing, auth, 401 retry, response transform
  v2/
    index.ts                  OpenCode V2 entry, setup wiring for integrations, models, and hooks
    auth.ts                   V2 OAuth integration methods and login runtime
    http.ts                   V2 session hooks for OAuth context and fetch transforms
    models.ts                 Account inventory model registration
  standalone/
    auth-file.ts              OpenCode auth.json location and atomic 0600 read/write
  cli.ts                      ogac commands
  core.ts                     Host-agnostic public exports
  index.ts                    Package root with the V1 plugin and core exports
```

The dependency direction is strict. `google/*` knows nothing about OpenCode. `plugin/*` adapts the Google core to OpenCode 1 hook contracts. `v2/*` adapts the same core to OpenCode 2. `cli.ts` reuses the Google core against `auth.json` directly. The V2 adapter does not fork OAuth, eligibility, transform, or credential logic.

## 3. Sign-in flow

1. **Method selection.** The auth hook registers four methods on the `google` provider:
   - Code Assist browser sign-in
   - Antigravity browser sign-in, marked experimental
   - Manual paste sign-in
   - API key fallback

   OAuth methods collect an optional Google Cloud project ID. Personal plans leave it blank. The value is validated to reject numeric project numbers.

2. **Authorization.** For browser sign-in, a loopback receiver starts before the URL is built. It prefers port 8085 and uses an ephemeral port if needed. This keeps `redirect_uri` aligned with the live listener. The URL includes `access_type=offline`, `prompt=consent`, PKCE S256, and `state`.

   The OAuth client identity depends on the backend. A token can only be refreshed by the client that minted it, so the client kind is stored in metadata.

   Client values resolve in this order: plugin options, environment variables, then the untracked `oauth-clients.json` file. If none is present, the plugin still registers the methods, and authorizing throws a clear `oauth_client_missing` error. This keeps the repository free of OAuth client values while release packages can include them.

3. **Callback and exchange.** The receiver validates the path and first-hit semantics. `parseAuthorizationCallback` verifies `state` for full URLs and rejects error responses. The code is exchanged at `oauth2.googleapis.com/token` with the PKCE verifier. A missing refresh token is a hard failure with recovery guidance.

4. **Identity for display.** The connector reads `userinfo`, with a fallback to unverified ID-token claims, to show the account email in the UI. Authorization decisions never depend on these claims.

5. **Eligibility.** `resolveAccountAccess` probes candidate endpoints in load-only mode. It completes onboarding on the first endpoint that accepts the account. It then performs a best-effort `fetchAvailableModels` call.

6. **Storage.** The callback returns OpenCode's OAuth success object. The `refresh` value is the raw refresh token plus a versioned metadata suffix. OpenCode persists it. The in-app plugin never writes credential files.

## 4. Eligibility resolution

The resolver mirrors Google's own setup flow.

| `loadCodeAssist` outcome | Connector result |
|---|---|
| `ineligibleTiers[]` contains `VALIDATION_REQUIRED` with a URL | `validation-required` with the URL |
| `currentTier` and a project from the response or configuration | `eligible`, using the server tier and plan label |
| `currentTier` with no project | `project-required`, or `unsupported-client` when reasons contain migration signals |
| No `currentTier` and `allowedTiers` is present | Onboard into the default tier. Free tier omits the project because Google provisions a managed one. Other tiers include the configured project. Poll the long-running operation every 5 seconds for up to 120 seconds. |
| No tiers | `ineligible` or `unsupported-client`, with every reason preserved |

Multi-endpoint mode keeps every attempt's reasons and returns the highest-priority failure in this order: `validation-required`, `project-required`, `unsupported-client`, `ineligible`. This gives the user the most actionable verdict. A 401 during probing aborts immediately. Other probe failures remove that candidate.

Endpoint candidates:

- `code-assist` uses `cloudcode-pa.googleapis.com`.
- `antigravity` uses `daily-cloudcode-pa.googleapis.com`, then `cloudcode-pa.googleapis.com`.
- `auto` uses Code Assist only unless `experimentalAntigravity` is enabled.

## 5. Credential storage contract

OpenCode's stored OAuth credential has a fixed shape with `access`, `refresh`, `expires`, and an optional `accountId`. It has no metadata field. Per-request routing needs the project, profile, endpoint, minting client kind, plan, and models.

The connector uses a versioned suffix on its own `refresh` value: `refresh|gac1.<base64url(JSON)>`. This is the same convention used by other OpenCode subscription plugins. It avoids a sidecar secret store and avoids re-running eligibility on every startup.

Parsing tolerates bare tokens and malformed suffixes. If metadata is missing, the connector re-resolves eligibility on the first request. Metadata never contains tokens. Rotations and metadata updates are persisted through `client.auth.set`. A persistence failure is non-fatal because the TokenManager keeps the fresher copy in memory.

## 6. Request path

OpenCode calls `loader(getAuth, provider)` when it builds the provider SDK client. For API-key credentials, the loader returns an empty object and built-in behavior stays untouched.

For OAuth credentials, the loader:

- Sets the displayed cost of catalog models to zero because billing is quota-based.
- Removes catalog models that are absent from the stored `availableModelIds`. This is a no-op when the stored list shares nothing with the catalog.
- Returns a placeholder API key, which the AI SDK requires, and the interceptor as `fetch`.

For each request, the interceptor:

1. Passes non-Gemini traffic through byte for byte.
2. Resolves context once per loader instance. It obtains a valid token from the TokenManager and reads the project, profile, and endpoint from metadata. It re-resolves eligibility only when metadata is incomplete. Context failures are not cached.
3. Rewrites the target to `<endpoint>/v1internal:<action>` with `?alt=sse` when streaming. It replaces API-key headers with `Authorization: Bearer` and wraps the body.
4. On a 401, force-refreshes the token and retries once.
5. Unwraps JSON responses such as `{response, traceId}` and adds `responseId`. It rewrites SSE events across arbitrary chunk boundaries. Errors keep Google's `{error:{code,message,status}}` shape and add connector guidance for quota, migration, and other cases.
6. Returns connector-side failures such as a missing credential or an ineligible account as synthetic Google-shaped errors, so OpenCode renders a clean message instead of a stack trace.

Generation requests are never sent to a second endpoint.

Token freshness: refresh when `expires <= now + 60 seconds`. Refreshes are single-flight across concurrent requests and keyed by a hash of the refresh token. Rotation is handled.

## 7. Wire translation

- **Code Assist envelope:** `{project, model, user_prompt_id, request}`.
- **Antigravity envelope:** `{project, model, request, userAgent:"antigravity", requestType:"agent", requestId}`. The session field is `request.sessionId`. Code Assist uses `request.session_id`.
- **Inner request:** strips `model` and `stream`, normalizes `system_instruction` and `cached_content`, drops `extra_body`, and removes `thought:true` history parts. For Gemini 3 models it backfills `thoughtSignature` on replayed `functionCall` parts that lack one. Already wrapped bodies are restamped, never double-wrapped.
- **`countTokens`:** uses its own envelope `{request:{model:"models/<id>", contents}}` and returns the unwrapped `{totalTokens}` response.
- **Headers:** Code Assist sends an honest product User-Agent and the `X-Goog-Api-Client` product token. Antigravity sends the Antigravity Hub User-Agent and omits both `X-Goog-Api-Client` and `Client-Metadata`, matching that surface's own client.

## 8. Model catalog

`src/models.ts` is the fallback catalog. It contains IDs from the Gemini CLI registry, including Gemini 3.1 and 3 Pro previews, Gemini 3.8 and 3.5 Flash, Gemini 3 Flash preview, Gemini 3.5 and 3.1 Flash-Lite, and the 2.5 family. The config hook injects these entries only when the user has not defined them. Each entry uses a 1M context limit, a 64K output limit, and Gemini 3 thinking-level variants.

Live discovery at login, and `ogac models`, registers the account's exact backend IDs and hides catalog aliases that the backend does not serve. For example, an account may expose `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-low` but reject `gemini-3.8-flash`.

## 9. Error taxonomy

| Class | Meaning | Typical experience |
|---|---|---|
| `OAuthError` | Authorization, token, or refresh failure | Sign in again guidance |
| `CodeAssistError` | Non-2xx response from `v1internal` | Probing keeps other endpoints. A 401 aborts. |
| `EligibilityError` | Signed in but no usable tier | Login fails before saving auth. Requests return a synthetic 403. |
| `ConnectorError` | Timeouts, bad project ID, network, and other failures | Message and a hint with the next action |

Every user-facing string passes through the secret redactor before display.

## 10. Threat model

Assets: the long-lived refresh token, access tokens, and prompt content.

Adversaries considered:

- A malicious local process. Mitigated by PKCE and state, a first-hit single-use receiver, and binding to 127.0.0.1.
- A malicious web page. It cannot read loopback responses, and state binds the callback to the session.
- A network attacker. HTTPS is used everywhere except the loopback redirect.
- A supply-chain attacker. Mitigated by zero runtime dependencies and provenance publishing.
- Accidental disclosure. Mitigated by the redacting logger, no token output from the CLI, and `0600` file writes.

Out of scope: a compromised OpenCode process or OS account, because either can read `auth.json`.

## 11. Testing strategy

`npm test` builds the project and runs `node --test` against the shipped `dist/` output. Tests are fully offline and cover:

- The RFC 7636 vector
- Callback and state handling
- Form encoding
- Eligibility trees with fake transports
- Long-running operation polling
- Multi-endpoint fall-through
- The metadata codec
- TokenManager single-flight behavior
- Interceptor rewrite, 401 retry, and SSE handling
- Real loopback HTTP
- Auth file permissions
- Plugin hooks
- A mocked Google end-to-end authorize, redirect, and callback flow
- CLI smoke tests

Live Google verification is a maintainer checklist item in [RELEASING.md](RELEASING.md) because it requires real accounts for each tier.
