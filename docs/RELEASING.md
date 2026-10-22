# Releasing

Maintainer checklist for publishing the project.

## One-time setup

1. The GitHub repository is https://github.com/analystsandeep/opencode-gemini-account.
2. The npm package name is `opencode-gemini-account`. Confirm that it is still available before the first publish.
3. Configure npm trusted publishing with OIDC for the repository. The workflow in `.github/workflows/publish.yml` already requests `id-token: write` and publishes with provenance. An `NPM_TOKEN` secret can be used as a fallback.
4. Use GitHub Security Advisories as the private security contact. See `SECURITY.md`.
5. Keep `oauth-clients.json` untracked. The file is local and is included in npm packages when present. Do not add OAuth client values to Git. See `NOTICE.md`.

## Per-release

1. Bump the version in `package.json` and `CONNECTOR_VERSION` in `src/constants.ts`. Update `CHANGELOG.md`.
2. Run `npm run check` for type checking, the build, and the offline test suite.
3. Confirm the OAuth client file is local only. Run `git ls-files oauth-clients.json` and expect no output. Confirm that `oauth-clients.json` exists in the package root and contains both profiles for a zero-config release.
4. Run `npm pack --dry-run` and verify that `dist/`, examples, README, LICENSE, and `oauth-clients.json` are included. Verify that no test fixtures or account credentials leak into the package. The tarball is expected to contain the public OAuth clients. The Git tree must not.
5. Run the live verification matrix with real accounts. This step cannot be automated.
   - Personal free account: test the default method and the experimental method.
   - Google AI Pro or Ultra account: test both methods and confirm the plan label and model list.
   - Code Assist Standard or Enterprise, or Workspace with a license: test the default method with a project ID.
   - For each account: select a model from `/models`, run one streaming completion with a tool call, run `ogac status` and `ogac quota`, force token expiry and confirm refresh, and revoke access at https://myaccount.google.com/permissions to confirm a clean re-login path.
   - Test the Desktop app and the TUI with loopback and manual paste. Test one headless CLI login.
6. Tag `vX.Y.Z` and run the publish workflow, or run `npm publish --provenance --access public`.
7. Smoke-test the published artifact from a clean machine. Run `npx opencode-gemini-account doctor` and install it with the `@latest` plugin entry.
8. Announce the release with the eligibility caveats from the README.

## If Google changes the internal APIs

1. Diff the Gemini CLI `code_assist` sources. Re-run `scripts/sync-public-client.mjs` if the public client rotated.
2. Update payload shapes in `src/google/codeassist.ts` and `src/google/transform.ts` with failing-first tests that use redacted captured responses.
3. Publish a patch release and describe the upstream change in the changelog.
