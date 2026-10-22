# OpenCode Gemini Account

Sign in with Google in OpenCode and use Gemini with your Google account plan. No Gemini API key is required.

This is a community plugin. It adds a Google OAuth connection to the built-in `google` provider, verifies the account's Gemini eligibility, and routes model requests through Google's Code Assist or Antigravity backend.

> **Status:** alpha (0.1.0). MIT licensed. Supports OpenCode 2.x (Desktop and CLI/TUI) through the native V2 plugin entrypoint. The OpenCode 1.x entrypoint is retained for older hosts.

## Important context

On 18 June 2026 Google moved Gemini Code Assist for individuals, Google AI Pro, and Google AI Ultra away from the Gemini CLI and IDE extension sign-in path. Those accounts now use Antigravity. Code Assist Standard and Enterprise are unchanged.

The connector supports both paths instead of assuming one. It never guesses your plan. After sign-in it calls Google's `loadCodeAssist` and `onboardUser` APIs and reports the exact result, including eligible plans, validation requirements, project requirements, and ineligible accounts.

| Sign-in method | Backend | Intended for | Status |
|---|---|---|---|
| **Sign in with Google (Gemini plan, no API key)** | Cloud Code Assist (`cloudcode-pa.googleapis.com`) | Code Assist Standard and Enterprise, Workspace accounts with licenses, and accounts Google still reports as eligible | Supported |
| **Sign in with Google (Antigravity / personal plan, experimental)** | Antigravity consumer endpoint (`daily-cloudcode-pa.googleapis.com`) | Personal accounts migrated off Code Assist, including free, AI Pro, and Ultra plans | Experimental and unofficial |
| **Sign in with Google (manual paste, headless or remote)** | Same as the default method | Servers without a browser, remote machines, restricted networks | Supported |
| **Gemini API key** | Public Gemini API | AI Studio key users | Unchanged fallback |

The Antigravity method uses a separate installed-app OAuth client. Google's Antigravity backend rejects the Gemini CLI client with `403 The caller does not have permission`. The published npm package includes the public Antigravity client and uses it only for this method. Source builds read the client from an untracked `oauth-clients.json` file or from environment variables. No personal account credentials are stored in the repository.

Internal Google APIs can change without notice. Using subscription-backed endpoints from third-party tools may conflict with the terms of your plan. You are responsible for your account. This project is not affiliated with Google or the OpenCode team.

## Features

- Browser sign-in with OAuth 2.0 Authorization Code, PKCE S256, and a loopback redirect on `127.0.0.1`.
- Manual paste flow for headless or remote machines.
- Server-side eligibility checks with Google's actual plan labels and reasons.
- Model discovery from the account's real inventory instead of a generic catalog.
- Exact model IDs such as `gemini-3.8-flash-high`, with unavailable aliases hidden automatically.
- Proactive token refresh with single-flight de-duplication, refresh-token rotation, and one automatic retry after a 401.
- Request and response translation for the Code Assist envelope, including streaming SSE, `countTokens`, and Gemini 3 thought signatures.
- Actionable errors for quota limits, revoked tokens, ineligible plans, and unavailable models.
- A small CLI for login, status, doctor, models, quota, logout, and config diagnostics.
- Zero runtime dependencies.

## Install

OpenCode 2.x reads plugins from the `plugins` array. Add this to `~/.config/opencode/opencode.json` on any operating system. Create the file if it does not exist.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-gemini-account@latest"]
}
```

OpenCode 1.x uses the legacy `plugin` key.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-account@latest"]
}
```

Restart OpenCode after changing the configuration. OpenCode installs npm plugins automatically at startup, so you do not need to run `npm install`.

The package is not published to npm yet. Until the first release, use the build-from-source steps below and point OpenCode at the local package directory.

### Build from source

```bash
git clone https://github.com/analystsandeep/opencode-gemini-account
cd opencode-gemini-account
npm install
npm run build
```

OpenCode 2 can load the package directory directly.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/absolute/path/to/opencode-gemini-account"]
}
```

OpenCode 1 can load the built V1 entrypoint.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///C:/absolute/path/to/opencode-gemini-account/dist/index.js"]
}
```

Use forward slashes on Windows. The CLI also works from the checkout with `node dist/cli.js doctor`.

### Configure OAuth clients for source builds

The GitHub repository does not contain OAuth client values. Create a local `oauth-clients.json` from `oauth-clients.example.json`, or set the matching environment variables before starting OpenCode. The file is ignored by Git and is read from the package root at runtime.

For Code Assist, create a desktop-app OAuth client in Google Cloud and fill the `codeAssist` block. For Antigravity, fill the `antigravity` block with the Antigravity installed-app client. The release package includes both profiles, so npm users do not need this file.

```json
{
  "codeAssist": {
    "clientId": "your-google-oauth-client-id",
    "clientSecret": "your-google-oauth-client-secret"
  },
  "antigravity": {
    "clientId": "your-antigravity-oauth-client-id",
    "clientSecret": "your-antigravity-oauth-client-secret"
  }
}
```

Keep this file out of version control. Set `OPENCODE_GOOGLE_CLIENTS_FILE` to use a different path. The sign-in error names the missing profile and the variables that can replace it.

### Optional Antigravity fallback

The separate Antigravity sign-in method is always available. If you also want the `auto` profile to probe Antigravity when Code Assist refuses the account, enable the option explicitly.

OpenCode 2:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-gemini-account@latest",
      "options": { "experimentalAntigravity": true }
    }
  ]
}
```

OpenCode 1:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["opencode-gemini-account@latest", { "experimentalAntigravity": true }]]
}
```

## Quick start

1. Open the provider connection screen. In the Desktop app choose **Connect provider**. In the TUI run `/connect`.
2. Choose **Google**.
3. For Code Assist Standard or Enterprise choose **Sign in with Google (Gemini plan, no API key)**. For a personal Google AI Pro, Ultra, or free account choose **Sign in with Google (Antigravity / personal plan, experimental)**.
4. Leave the project prompt empty for personal plans. Workspace and Code Assist Standard or Enterprise users should enter the string project ID that their license is attached to, not the numeric project number.
5. Complete the sign-in on Google's website. The browser returns to the connector automatically and shows the connected account and plan.
6. Run `/models` and select an exact `google/...` model ID from your account, for example `google/gemini-3.8-flash-high` or `google/gemini-2.5-pro`.
7. Optionally set the model as the default in `opencode.json`.

```json
{
  "model": "google/gemini-3.8-flash-high"
}
```

Generic family aliases are not guaranteed. An account may expose `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-low` while rejecting `gemini-3.8-flash`. If a model returns 404, copy an ID from `/models` or run `ogac models`.

If Google reports that your account was migrated or is unsupported, disconnect and try the Antigravity method. You can also run the doctor for a full report.

```bash
npx opencode-gemini-account doctor
```

## Which plans work?

Eligibility is decided by Google at sign-in. This table describes what to expect.

| Account or plan | Default method | Antigravity method | Notes |
|---|---|---|---|
| Code Assist Standard or Enterprise | Supported | Not required | Enter the licensed Google Cloud project ID at sign-in. |
| Workspace with a Code Assist license | Supported | Not required | Project ID required. Admin restrictions appear as eligibility reasons. |
| Google AI Pro or Ultra consumer account | May return `unsupported-client` | Intended consumer path | Consumer plans were migrated off Code Assist sign-in on 18 June 2026. |
| Free personal account | May return `unsupported-client` | Subject to Antigravity availability | Region and age restrictions appear as `ineligible` with Google's reason. |
| Any account with an AI Studio API key | Unaffected | Not required | API-key credentials and OAuth credentials can coexist. OAuth takes precedence when present. |

## How it works

1. OpenCode starts the Google OAuth flow with PKCE and a random `state` value.
2. Google redirects to a loopback receiver on `127.0.0.1`.
3. The connector exchanges the authorization code for tokens and checks eligibility with `loadCodeAssist`.
4. If onboarding is required, the connector calls `onboardUser` and polls the long-running operation.
5. The connector fetches the account's available models and stores the credential in OpenCode's credential store.
6. Each Gemini request is translated into the Code Assist or Antigravity envelope and authorized with a bearer token.
7. Responses and streaming events are translated back into the public Gemini API shape that OpenCode expects.

More detail is available in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [SECURITY.md](SECURITY.md).

## CLI

The in-app flow is the primary experience. The CLI shares the same OpenCode credential store and is useful for headless machines and diagnostics.

```bash
npx opencode-gemini-account login
npx opencode-gemini-account status
npx opencode-gemini-account doctor
npx opencode-gemini-account models
npx opencode-gemini-account quota
npx opencode-gemini-account logout
npx opencode-gemini-account print-config
```

All report commands accept `--json`. The `login` command accepts `--profile auto|code-assist|antigravity`, `--project <id>`, `--manual`, and `--no-browser`. Tokens are never printed.

The short alias `ogac` is also installed.

## Configuration

Plugin options can be supplied through OpenCode configuration or environment variables.

| Option or environment variable | Default | Purpose |
|---|---|---|
| `profile` or `OPENCODE_GOOGLE_PROFILE` | `auto` | Default backend for the manual-paste method and CLI: `auto`, `code-assist`, or `antigravity`. |
| `experimentalAntigravity` or `OPENCODE_GOOGLE_EXPERIMENTAL_ANTIGRAVITY=1` | `false` | Allow the `auto` profile to fall back to Antigravity when Code Assist refuses the account. |
| `projectId` or `OPENCODE_GOOGLE_PROJECT` or `GOOGLE_CLOUD_PROJECT` | none | Default Google Cloud project ID for Workspace and Enterprise accounts. |
| `oauthClient` or `OPENCODE_GOOGLE_CLIENT_ID` and `OPENCODE_GOOGLE_CLIENT_SECRET` | `codeAssist` profile in `oauth-clients.json` | Override the Code Assist OAuth client. |
| `antigravityOAuthClient` or `OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_ID` and `OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET` | `antigravity` profile in `oauth-clients.json` | Override the Antigravity OAuth client. |
| `OPENCODE_GOOGLE_CLIENTS_FILE` | `oauth-clients.json` in the package root | Load OAuth clients from another local JSON file. |
| `endpoint` or `OPENCODE_GOOGLE_CODE_ASSIST_ENDPOINT` | `https://cloudcode-pa.googleapis.com` | Override the Code Assist endpoint for testing. |
| `OPENCODE_GOOGLE_USER_AGENT` | product user agent | Override the user agent sent to Google backends. |
| `debug` or `OPENCODE_GOOGLE_DEBUG=1` | `false` | Enable verbose diagnostics. Secrets are redacted. |
| `OPENCODE_AUTH_FILE` | auto-detected | CLI only. Use a custom OpenCode `auth.json` location. |

Precedence is per-sign-in prompt, then plugin options, then environment variables, then defaults.

### Bring your own OAuth client

Use this when you build from source without a local `oauth-clients.json`, or when you want a project-owned client.

1. Create an OAuth consent screen in Google Cloud Console.
2. Create an OAuth client of type **Desktop app**.
3. Set `OPENCODE_GOOGLE_CLIENT_ID` and `OPENCODE_GOOGLE_CLIENT_SECRET`, or put the pair in the `codeAssist` block of `oauth-clients.json`. You can also pass `oauthClient` in plugin options.

Loopback redirects such as `http://127.0.0.1:<any-port>/oauth2callback` work without registering each port. Google's Code Assist backend is operated for first-party clients, so a custom client may still be refused during eligibility checks. The connector reports Google's verdict without hiding it.

The Antigravity method also needs an installed-app client that Google's Antigravity application uses. The release package includes it. A custom desktop client may not satisfy that backend.

## Troubleshooting

**Account is not eligible or reports `unsupported-client`.** Your consumer plan was migrated to Antigravity. Reconnect with the Antigravity method or use Google's official Antigravity application.

**Validation required.** Open the validation URL shown in the error or in `ogac doctor`. Complete Google's validation, then sign in again.

**Project required or invalid project ID.** Workspace and paid plans need the string project ID such as `my-project-123`, not the numeric project number. Set it in the sign-in prompt or with `GOOGLE_CLOUD_PROJECT`.

**Browser did not return to the connector.** The connector prefers port 8085 and falls back to an available loopback port. If the browser cannot reach localhost, use the manual paste method. Copy the full redirect URL from the browser error page, or copy only the authorization code.

**`invalid_grant` or repeated 401 responses.** The refresh token was revoked or expired. Disconnect Google in OpenCode and sign in again.

**Model returns 404.** That exact model ID is not served by your plan or backend. Run `ogac models` or open `/models` and use one of the listed IDs.

**429 responses despite remaining quota.** Plan quotas are shared across Google surfaces and reset in windows. Usage in the Antigravity application counts toward the same quota. Run `ogac quota` to see what the backend reports.

**Sign out.** Disconnect Google in OpenCode, or run `ogac logout` to revoke the refresh token and remove the local credential.

**Updating.** Use `@latest` and restart OpenCode. If an old cached copy persists, delete `~/.cache/opencode/node_modules/opencode-gemini-account` and restart.

## Security and privacy

- Sign-in happens only on Google's website. The connector never sees your password.
- The Code Assist method requests `cloud-platform`, `userinfo.email`, `userinfo.profile`, and `openid`. The Antigravity method also requests `cclog` and `experimentsandconfigs`.
- Tokens are stored in OpenCode's `auth.json`. Treat that file as a password.
- The repository contains no account credentials and no OAuth client values. Local OAuth clients live in the ignored `oauth-clients.json` file or in environment variables.
- The connector sends data only to Google endpoints.
- Debug logs redact tokens and authorization codes.
- Prompt and data handling are governed by the terms of your Google plan. Review those terms before sending sensitive code.
- The full threat model is in [SECURITY.md](SECURITY.md).

## Related projects

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) pioneered the Gemini CLI OAuth route for OpenCode.
- `opencode-antigravity-auth` forks focus on Antigravity account pools and rotation.

This project focuses on a single account, eligibility-first sign-in, an explicit experimental Antigravity option, and diagnostics that explain Google's response. It does not implement account rotation or fingerprint spoofing.

## Development

```bash
git clone https://github.com/analystsandeep/opencode-gemini-account
cd opencode-gemini-account
npm install
npm run check
npm run build
```

`npm run check` runs type checking, the build, and the offline test suite. Tests use mocked Google endpoints and do not make network requests.

Local development configuration examples are in `examples/`. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Roadmap

- In-app quota display.
- Periodic model inventory refresh.
- Vertex AI with Application Default Credentials for users who want to bill their own Google Cloud project.

## License

MIT. See [LICENSE](LICENSE). This project is not affiliated with Google, Gemini, Antigravity, or the OpenCode project. All product names are trademarks of their respective owners. Protocol shapes were implemented from Google's public Apache-2.0 Gemini CLI source. See [NOTICE.md](NOTICE.md).
