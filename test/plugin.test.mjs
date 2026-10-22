import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  GoogleAccountConnectorPlugin,
  decodeRefreshToken,
  encodeRefreshToken,
  resolveConnectorConfig,
} from "../dist/index.js";
import { createLoginSession } from "../dist/plugin/login.js";

const execFileAsync = promisify(execFile);
const realFetch = globalThis.fetch;

async function makeHooks(client = {}) {
  return GoogleAccountConnectorPlugin(
    { client, project: {}, directory: ".", worktree: ".", serverUrl: new URL("http://localhost"), $: undefined, experimental_workspace: { register() {} } },
    {
      oauthClient: { clientId: "test-client-id", clientSecret: "test-client-secret" },
      antigravityOAuthClient: {
        clientId: "test-antigravity-client-id",
        clientSecret: "test-antigravity-client-secret",
      },
    },
  );
}

test("plugin registers Google auth methods: two browser flows, manual paste, API fallback", async () => {
  const hooks = await makeHooks();
  assert.equal(hooks.auth.provider, "google");
  const labels = hooks.auth.methods.map((m) => m.label);
  assert.match(labels[0], /Sign in with Google \(Gemini plan/);
  assert.match(labels[1], /Antigravity/);
  assert.match(labels[2], /manual paste/);
  assert.equal(hooks.auth.methods[3].type, "api");
});

test("sign-in explains how to configure a missing OAuth client", () => {
  const config = resolveConnectorConfig(
    {},
    { OPENCODE_GOOGLE_CLIENTS_FILE: "C:/nonexistent/oauth-clients.json" },
  );
  assert.throws(
    () =>
      createLoginSession({
        config,
        backend: "auto",
        redirectUri: "http://127.0.0.1:8085/oauth2callback",
      }),
    /No OAuth client is configured/,
  );
});

test("config hook injects the model catalog without overwriting user entries", async () => {
  const hooks = await makeHooks();
  const cfg = { provider: { google: { models: { "gemini-2.5-pro": { name: "Mine" } } } } };
  await hooks.config(cfg);
  assert.equal(cfg.provider.google.models["gemini-2.5-pro"].name, "Mine");
  assert.ok(cfg.provider.google.models["gemini-3.5-flash"]);
  assert.deepEqual(cfg.provider.google.models["gemini-3.5-flash"].limit, { context: 1048576, output: 65536 });
});

test("loader leaves API-key credentials untouched and activates OAuth ones", async () => {
  const hooks = await makeHooks();

  const apiLoader = await hooks.auth.loader(async () => ({ type: "api", key: "k" }), { models: {} });
  assert.deepEqual(apiLoader, {});

  const provider = {
    models: {
      "gemini-2.5-pro": { cost: { input: 5, output: 5 } },
      "gemini-3-pro-preview": {},
    },
  };
  const oauthLoader = await hooks.auth.loader(
    async () => ({
      type: "oauth",
      access: "a",
      expires: Date.now() + 3600_000,
      refresh: encodeRefreshToken("r", { v: 1, projectId: "p", profile: "code-assist", endpoint: "https://cloudcode-pa.googleapis.com", availableModelIds: ["gemini-2.5-pro"] }),
    }),
    provider,
  );
  assert.equal(oauthLoader.apiKey, "google-account-oauth");
  assert.equal(typeof oauthLoader.fetch, "function");
  assert.equal(provider.models["gemini-2.5-pro"].cost.input, 0);
  assert.equal("gemini-3-pro-preview" in provider.models, false);
});

test("end-to-end: authorize → browser redirect → callback yields an eligible stored credential", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    calls.push(target);
    if (target === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-e2e", refresh_token: "refresh-e2e", expires_in: 3600 });
    }
    if (target.includes("userinfo")) {
      return Response.json({ email: "dev@example.com", sub: "7" });
    }
    if (target.includes(":loadCodeAssist")) {
      return Response.json({
        currentTier: { id: "free-tier" },
        paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
        cloudaicompanionProject: "managed-e2e",
      });
    }
    if (target.includes(":fetchAvailableModels")) {
      return Response.json({ models: { "gemini-2.5-pro": {}, "gemini-3.5-flash": {} } });
    }
    throw new Error(`unexpected URL ${target}`);
  };
  try {
    const hooks = await makeHooks();
    const method = hooks.auth.methods[0];
    const authorization = await method.authorize({});
    assert.match(authorization.url, /^https:\/\/accounts\.google\.com\//);

    const authUrl = new URL(authorization.url);
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    const state = authUrl.searchParams.get("state");

    const callbackPromise = authorization.callback();
    await realFetch(`${redirectUri}?code=e2e-code&state=${encodeURIComponent(state)}`);
    const result = await callbackPromise;

    assert.equal(result.type, "success");
    assert.equal(result.access, "access-e2e");
    assert.equal(result.accountId, "dev@example.com");
    const decoded = decodeRefreshToken(result.refresh);
    assert.equal(decoded.refreshToken, "refresh-e2e");
    assert.equal(decoded.meta.projectId, "managed-e2e");
    assert.equal(decoded.meta.planLabel, "Google AI Pro");
    assert.deepEqual(decoded.meta.availableModelIds, ["gemini-2.5-pro", "gemini-3.5-flash"]);
    assert.ok(calls.some((c) => c.includes(":loadCodeAssist")));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("CLI help runs and status fails cleanly without a credential", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js", "--help"]);
  assert.match(stdout, /ogac login/);

  await assert.rejects(
    execFileAsync(process.execPath, ["dist/cli.js", "status", "--auth-file", "/nonexistent/ogac/auth.json"]),
    (error) => {
      assert.match(String(error.stderr), /No Google OAuth credential/);
      return true;
    },
  );
});
