import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAuthorizationUrl,
  createPkcePair,
  decodeJwtClaims,
  endpointCandidates,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  resolveConnectorConfig,
} from "../dist/index.js";
import { redactSecrets } from "../dist/log.js";

const client = { clientId: "test-client-id", clientCredential: "test-credential", source: "environment" };

test("PKCE matches the RFC 7636 test vector", () => {
  const pair = createPkcePair("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(pair.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(pair.method, "S256");
});

test("authorization URL carries PKCE, state, offline access and consent", () => {
  const url = new URL(
    buildAuthorizationUrl({
      client,
      redirectUri: "http://127.0.0.1:8085/oauth2callback",
      state: "state-123",
      codeChallenge: "challenge-abc",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.match(url.searchParams.get("scope"), /cloud-platform/);
});

test("callback parsing accepts URLs and bare codes, rejects state mismatch and errors", () => {
  assert.deepEqual(
    parseAuthorizationCallback("http://127.0.0.1:8085/oauth2callback?code=abc&state=s1", "s1"),
    { code: "abc", state: "s1" },
  );
  assert.deepEqual(parseAuthorizationCallback("bare-code"), { code: "bare-code" });
  assert.throws(
    () => parseAuthorizationCallback("http://127.0.0.1/cb?code=abc&state=evil", "s1"),
    /state mismatch/i,
  );
  assert.throws(
    () => parseAuthorizationCallback("http://127.0.0.1/cb?error=access_denied"),
    /access_denied/,
  );
});

test("token exchange sends a form-encoded PKCE request and computes expiry", async () => {
  let seenBody;
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    seenBody = new URLSearchParams(init.body);
    return Response.json({
      access_token: "access-1",
      refresh_token: "refresh-1",
      id_token: "ignored",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  const before = Date.now();
  const tokens = await exchangeAuthorizationCode({
    code: "code-1",
    codeVerifier: "verifier-1",
    redirectUri: "http://127.0.0.1:8085/oauth2callback",
    client,
    fetchImpl,
  });
  assert.equal(seenBody.get("grant_type"), "authorization_code");
  assert.equal(seenBody.get("code_verifier"), "verifier-1");
  assert.ok(seenBody.get("client_secret"));
  assert.equal(tokens.accessToken, "access-1");
  assert.ok(tokens.expiresAt >= before + 3600_000 - 1000);
});

test("token exchange without a refresh token fails with recovery guidance", async () => {
  const fetchImpl = async () => Response.json({ access_token: "a", expires_in: 10 });
  await assert.rejects(
    exchangeAuthorizationCode({
      code: "c",
      codeVerifier: "v",
      redirectUri: "http://127.0.0.1/cb",
      client,
      fetchImpl,
    }),
    /refresh token/i,
  );
});

test("ID-token claims decode for display purposes", () => {
  const payload = Buffer.from(JSON.stringify({ email: "dev@example.com", sub: "42" })).toString("base64url");
  const claims = decodeJwtClaims(`header.${payload}.signature`);
  assert.equal(claims.email, "dev@example.com");
  assert.equal(decodeJwtClaims("not-a-jwt"), undefined);
});

test("endpoint candidates respect profile mode and the experimental flag", () => {
  const plain = resolveConnectorConfig({}, {});
  assert.deepEqual(endpointCandidates("auto", plain).map((c) => c.profile), ["code-assist"]);
  const experimental = resolveConnectorConfig({ experimentalAntigravity: true }, {});
  assert.deepEqual(endpointCandidates("auto", experimental).map((c) => c.profile), [
    "code-assist",
    "antigravity",
    "antigravity",
  ]);
  assert.equal(endpointCandidates("antigravity", plain).length, 2);
});

test("OAuth clients resolve from a local file and report missing configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-gemini-account-"));
  const file = join(dir, "oauth-clients.json");
  writeFileSync(
    file,
    JSON.stringify({
      codeAssist: { clientId: "local-client-id", clientSecret: "local-client-secret" },
    }),
  );
  try {
    const local = resolveConnectorConfig({}, { OPENCODE_GOOGLE_CLIENTS_FILE: file });
    assert.equal(local.oauthClient.source, "local-file");
    assert.equal(local.oauthClient.clientId, "local-client-id");
    assert.equal(local.antigravityOAuthClient.source, "unconfigured");

    const missing = resolveConnectorConfig(
      {},
      { OPENCODE_GOOGLE_CLIENTS_FILE: join(dir, "missing.json") },
    );
    assert.equal(missing.oauthClient.source, "unconfigured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret redaction scrubs token-shaped values", () => {
  const fakeAccess = ["ya", "29.fake-access-value"].join("");
  const fakeRefresh = ["1", "//fake-refresh-value"].join("");
  const input = 'Authorization: Bearer ' + fakeAccess + ' {"access_token":"tok123","refresh_token":"' + fakeRefresh + '"}';
  const out = redactSecrets(input);
  assert.doesNotMatch(out, /fake-access-value|fake-refresh-value|tok123/);
  assert.match(out, /REDACTED/);
});
