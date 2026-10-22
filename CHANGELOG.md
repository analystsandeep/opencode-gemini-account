# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] (2026-10-22)

Initial alpha release.

### Added

- Native OpenCode 2 plugin entrypoint in `src/v2/` and `server.js`. It uses the `@opencode/plugin` integration, provider, and session APIs. The OpenCode 1.x entrypoint is retained. OpenCode 2 reads plugins from the `plugins` key.
- Google auth methods on the built-in `google` provider:
  - Browser sign-in for Code Assist.
  - Browser sign-in for Antigravity, marked experimental.
  - Manual paste sign-in for headless environments.
  - The existing API-key fallback.
- OAuth 2.0 Authorization Code flow with PKCE S256 and `state`, a loopback receiver on `127.0.0.1`, and an ephemeral-port fallback.
- Server-side eligibility resolution through `loadCodeAssist` and `onboardUser`, including long-running operation polling, free-tier managed projects, validation-required and project-required outcomes, and migration detection.
- Model discovery through `fetchAvailableModels`. The picker uses the account's exact model IDs and hides catalog aliases that the backend does not serve.
- Request translation for the Code Assist `v1internal` envelope, including streaming SSE, `countTokens`, Gemini 3 thought-signature backfill, annotated errors, and one refresh-and-retry after a 401.
- Token manager with proactive refresh, single-flight de-duplication, refresh-token rotation, and versioned metadata on the stored refresh value.
- `ogac` CLI with `login`, `status`, `doctor`, `models`, `quota`, `logout`, and `print-config`. Every report command supports `--json`, and tokens are never printed.
- Local OAuth client configuration through an untracked `oauth-clients.json` file, plugin options, or environment variables. The repository and Git history contain no OAuth client values. Release packages include the file when it is present.
- Offline test suite with mocked Google endpoints, a real loopback HTTP receiver, and an end-to-end authorize, redirect, and callback test.

### Known limitations

- Consumer Gemini tiers were migrated off Code Assist sign-in on 18 June 2026. The default method reports `unsupported-client` for those accounts. The experimental Antigravity method is the unofficial alternative.
- Single account only. Multi-account pooling is a non-goal.
- Model IDs are account-specific. Use the exact inventory ID such as `gemini-3.8-flash-high`, not a generic family alias.
