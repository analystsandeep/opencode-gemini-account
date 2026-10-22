# Contributing

Thanks for helping. This project is small, typed, and deliberately simple. It has zero runtime dependencies, one responsibility per module, and a mockable boundary around everything Google-shaped.

## Ground rules

- **No runtime dependencies.** Dev-only tooling such as TypeScript and type packages is fine.
- **No live Google calls in tests.** Mock at the `fetchImpl` or `CodeAssistTransport` boundary. Never commit tokens, `auth.json` excerpts, or unredacted logs.
- **No fingerprint spoofing.** The honest User-Agent stays. The schema-required routing fields for the Antigravity profile are the documented exception.
- **Eligibility is a server verdict.** Do not add client-side plan guessing.
- **Actionable failures.** User-facing errors should use `ConnectorError` with a `hint` that tells the user what to do next.

## Setup

```bash
git clone https://github.com/analystsandeep/opencode-gemini-account
cd opencode-gemini-account
npm install
npm run check
```

Run the plugin from your checkout:

```bash
npm run build
# Point OpenCode 2 at the package directory. See examples/opencode.v2.local-dev.json.
#   "plugins": ["C:/absolute/path/to/opencode-gemini-account"]
# OpenCode 1 uses the legacy key and the built file. See examples/opencode.local-dev.json.
#   "plugin": ["file:///absolute/path/to/opencode-gemini-account/dist/index.js"]
opencode
```

Exercise the CLI without installing:

```bash
node dist/cli.js doctor
node dist/cli.js login --no-browser
OPENCODE_GOOGLE_DEBUG=1 node dist/cli.js status
```

## Code layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Put protocol logic in `src/google/`, OpenCode adaptation in `src/plugin/` and `src/v2/`, and shared helpers in the top-level modules.

Keep TypeScript strict-clean. `npm run typecheck` must pass. If you touch `src/constants.ts`, remember that `CONNECTOR_VERSION` must match `package.json` at release time.

## Local OAuth clients

The repository never stores OAuth client values. For local sign-in, copy `oauth-clients.example.json` to `oauth-clients.json` and fill the profiles you need. The file is ignored by Git. It is included in npm packages when present, so release builds can ship a ready-to-use public installed-app client without committing it.

The Code Assist entry can be refreshed from a local Gemini CLI checkout. The script preserves the other profiles in the file:

```bash
git clone https://github.com/google-gemini/gemini-cli /tmp/gemini-cli
node scripts/sync-public-client.mjs /tmp/gemini-cli/packages/core/src/code_assist/oauth2.ts
```

See [NOTICE.md](NOTICE.md) for the installed-app rationale. Never force-add `oauth-clients.json` and never add other credential material to the repository. Tests do not need the file. They pass explicit clients and mock every Google endpoint.

## Tests

Tests run with `node --test` against the built `dist/` output and must pass offline with `npm test`. Add tests beside the relevant area:

- OAuth, PKCE, and parsing: `test/oauth.test.mjs`
- Envelope and transforms: `test/transform.test.mjs`
- Eligibility trees: `test/eligibility.test.mjs`
- Credentials and fetch: `test/credentials-fetch.test.mjs`
- Loopback and auth file: `test/loopback-authfile.test.mjs`
- Hooks, end-to-end flow, and CLI: `test/plugin.test.mjs`
- V2 package entrypoint: `test/v2-entry.test.mjs`

Fake response payloads should mirror the proto JSON shapes documented in `src/google/codeassist.ts`.

## Pull requests

- Keep one concern per pull request and explain the user-visible behavior change first.
- Include a summary of `npm run check` in the pull request.
- Update the README and CHANGELOG when behavior or configuration changes.
- For endpoint or payload changes, cite the observed request and response with secrets redacted.
