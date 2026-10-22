# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories. Use the "Report a vulnerability" button on the repository's Security tab. Do not open a public issue for anything involving credential handling.

We aim to acknowledge reports within 72 hours.

## Supported versions

Only the latest published 0.x release receives security fixes until version 1.0.

## Security model

### Authentication flow

- Authorization Code flow with PKCE S256 and a cryptographic `state` value. Callbacks with a missing or mismatched state are rejected.
- The loopback receiver binds to `127.0.0.1` only. It serves a single path, resolves on the first callback, shuts down immediately, and times out after five minutes.
- A hostile local process that reaches the port cannot complete the flow without the PKCE verifier. The verifier never leaves the connector process.
- The manual-paste flow accepts a full redirect URL with state verification or a bare authorization code. PKCE still binds the token exchange.
- Sign-in and consent happen only on Google's website. The connector never collects passwords or two-step verification codes.

### Credentials at rest

- The plugin stores no credentials itself. Access and refresh tokens live in OpenCode's credential store, `auth.json`, like every other OpenCode provider.
- Non-secret routing metadata is encoded as a versioned suffix on the refresh value. This includes the project, backend profile, plan label, and model list. OpenCode's OAuth schema has no metadata field. See `src/plugin/credentials.ts`.
- The standalone CLI writes `auth.json` atomically with mode `0600`.
- Treat `auth.json` as a password file. It contains long-lived refresh tokens.
- `ogac logout` revokes the refresh token at Google and removes the local entry. Revoking access at https://myaccount.google.com/permissions also works at any time.

### Token use and transport

- Access tokens are sent only to `*.googleapis.com` endpoints over HTTPS as `Authorization: Bearer` headers. They replace the placeholder API key on Gemini API requests. Non-Google traffic passes through untouched.
- Refresh is single-flight, so concurrent requests share one refresh operation. Refresh-token rotation is handled and persisted back to OpenCode.
- Tokens are never logged or printed. Debug lines and error output pass through a secret redactor in `src/log.ts`. The CLI prints only account, plan, and expiry metadata. Debug logging is off unless `OPENCODE_GOOGLE_DEBUG=1`.

### OAuth client identity

- OAuth client values are not stored in the Git repository. The connector reads an untracked `oauth-clients.json` file from the package root, or plugin options, or environment variables. A missing profile produces a clear sign-in error.
- The Code Assist method uses the public installed-app client published in Google's open-source Gemini CLI. See `NOTICE.md`.
- The Antigravity method uses a different public installed-app client. This is required because Google's Antigravity backend rejects the Gemini CLI client with `403 The caller does not have permission`.
- You can override either client with your own registered desktop OAuth client. Use `OPENCODE_GOOGLE_CLIENT_ID` and `OPENCODE_GOOGLE_CLIENT_SECRET`, or `OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_ID` and `OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET`, or the matching plugin options.
- Release maintainers include `oauth-clients.json` in the npm package only. It is ignored by Git and must never be committed.
- The Code Assist profile sends an honest product User-Agent. The experimental Antigravity profile sends the Antigravity Hub User-Agent and the routing fields that backend requires: `userAgent`, `requestType`, and `requestId`. It does not add `X-Goog-Api-Client` or `Client-Metadata`. This first-party compatibility surface is one reason the profile is opt-in and labelled experimental everywhere.

### Scopes

The Code Assist method requests `cloud-platform`, `userinfo.email`, `userinfo.profile`, and `openid`. The `cloud-platform` scope is broad by Google's design for this API.

The Antigravity method also requests `cclog` and `experimentsandconfigs`, which its backend expects. If these scopes are unacceptable for your organization, use the API-key fallback or a future Vertex AI profile.

### Known risks

- The backends are Google's internal `v1internal` APIs. They can change or be restricted without notice, and availability is not guaranteed.
- Using subscription-backed endpoints from third-party tools may conflict with your plan terms. Google may rate-limit or restrict accounts. The Antigravity profile is opt-in and labelled experimental for this reason.
- Prompt and data handling are governed by the terms of the tier Google assigns to your account. Review those terms before sending sensitive code, especially on free tiers.

## Hardening checklist for maintainers

- Never log request or response bodies at info level. Debug output must stay redacted.
- Never stage `oauth-clients.json` or any account credential. Run `git status` before every release commit.
- Keep zero runtime dependencies so the supply-chain surface stays auditable.
- Any new endpoint must use `googleapis.com` over HTTPS. Do not add telemetry.
- Publish only from the provenance-enabled release workflow.
