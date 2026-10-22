# Notices

**OpenCode Gemini Account** is an independent, community open-source project. It is not affiliated with, endorsed by, or sponsored by Google LLC or the OpenCode project.

"Google", "Gemini", "Antigravity", and "OpenCode" are trademarks of their respective owners. They are referenced only to describe interoperability.

## Protocol implementation

The Cloud Code Assist `v1internal` request and response shapes and the eligibility decision tree were implemented by studying the public Apache-2.0 source of Google's Gemini CLI at https://github.com/google-gemini/gemini-cli, specifically `packages/core/src/code_assist/`.

No Gemini CLI source code is copied into this repository. The implementation in `src/` is original. The referenced source is licensed under the Apache License 2.0, copyright Google LLC.

## Public installed-app OAuth clients

The repository does not commit OAuth client values. A release package can include them in an untracked `oauth-clients.json` file. The file is ignored by Git and is loaded at runtime from the package root.

The Code Assist profile uses the public installed-app client published in the Gemini CLI source. The Antigravity profile uses the client shipped with Google's Antigravity application. Google's OAuth documentation states that for installed applications the client secret embedded in distributed binaries is not treated as a secret. See https://developers.google.com/identity/protocols/oauth2#installed. Both values are client identities, not account tokens.

The Code Assist entry can be generated or refreshed from a local Gemini CLI checkout. The script preserves the other profiles in the file:

```bash
node scripts/sync-public-client.mjs /path/to/gemini-cli/packages/core/src/code_assist/oauth2.ts
```

Users and organizations can replace either client at runtime with their own registered desktop-app OAuth client through `OPENCODE_GOOGLE_CLIENT_ID` and `OPENCODE_GOOGLE_CLIENT_SECRET`, or `OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_ID` and `OPENCODE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET`. See `src/config.ts` and `src/oauth-clients.ts`.

Maintainers must keep `oauth-clients.json` untracked. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Terms responsibility

This software communicates with Google-operated endpoints, including internal `v1internal` APIs that Google may change or restrict without notice. Whether a given use complies with the terms attached to your Google account or subscription is your responsibility.
