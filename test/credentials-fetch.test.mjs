import assert from "node:assert/strict";
import test from "node:test";

import {
  TokenManager,
  createGoogleFetch,
  decodeRefreshToken,
  encodeRefreshToken,
  reconcileProviderModels,
  resolveConnectorConfig,
  toStoredCredential,
  zeroSubscriptionCosts,
} from "../dist/index.js";

const meta = {
  v: 1,
  projectId: "proj-1",
  profile: "code-assist",
  endpoint: "https://cloudcode-pa.googleapis.com",
  email: "dev@example.com",
  planLabel: "Google AI Pro",
};

function storedAuth({ access = "access-1", expires = Date.now() + 3600_000 } = {}) {
  return {
    type: "oauth",
    access,
    refresh: encodeRefreshToken("refresh-1", meta),
    expires,
  };
}

function makeTokenManager(auth, extras = {}) {
  return new TokenManager({
    getAuth: async () => auth,
    persist: async () => {},
    clientFor: () => ({ clientId: "id", clientCredential: "cred" }),
    ...extras,
  });
}

test("composite refresh token round-trips metadata and tolerates bare/malformed values", () => {
  const encoded = encodeRefreshToken("refresh-abc", meta);
  const decoded = decodeRefreshToken(encoded);
  assert.equal(decoded.refreshToken, "refresh-abc");
  assert.equal(decoded.meta.projectId, "proj-1");
  assert.equal(decoded.meta.planLabel, "Google AI Pro");

  assert.deepEqual(decodeRefreshToken("bare"), { refreshToken: "bare", meta: { v: 1 } });
  assert.equal(decodeRefreshToken("r|gac1.%%%not-json%%%").refreshToken, "r");
  assert.equal(toStoredCredential({ accessToken: "a", refreshToken: "r", expiresAt: 5, meta }).refresh.startsWith("r|gac1."), true);
});

test("token manager refreshes inside the skew window and de-duplicates concurrent refreshes", async () => {
  let refreshes = 0;
  const manager = makeTokenManager(storedAuth({ expires: Date.now() + 1000 }), {
    refreshFn: async (refreshToken) => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: "fresh", refreshToken, expiresAt: Date.now() + 3600_000 };
    },
  });
  const [a, b] = await Promise.all([manager.getValidCredentials(), manager.getValidCredentials()]);
  assert.equal(refreshes, 1);
  assert.equal(a.accessToken, "fresh");
  assert.equal(b.accessToken, "fresh");
});

test("fetch interceptor rewrites to v1internal with Bearer auth and unwraps the response", async () => {
  const manager = makeTokenManager(storedAuth());
  let seen;
  const upstream = async (url, init) => {
    seen = { url, init };
    return Response.json({ response: { candidates: [{ index: 0 }] }, traceId: "t-7" });
  };
  const googleFetch = createGoogleFetch({
    tokenManager: manager,
    config: resolveConnectorConfig({}, {}),
    upstreamFetch: upstream,
  });

  const response = await googleFetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": "should-be-removed", "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
    },
  );

  assert.equal(seen.url, "https://cloudcode-pa.googleapis.com/v1internal:generateContent");
  const headers = new Headers(seen.init.headers);
  assert.equal(headers.get("authorization"), "Bearer access-1");
  assert.equal(headers.get("x-goog-api-key"), null);
  const body = JSON.parse(seen.init.body);
  assert.equal(body.project, "proj-1");
  assert.equal(body.model, "gemini-2.5-pro");
  assert.equal(body.request.contents[0].parts[0].text, "hello");

  const json = await response.json();
  assert.deepEqual(json, { candidates: [{ index: 0 }], responseId: "t-7" });
});

test("fetch interceptor wraps binary (Uint8Array) request bodies", async () => {
  const manager = makeTokenManager(storedAuth());
  let seenBody;
  const upstream = async (url, init) => {
    seenBody = init.body;
    return Response.json({ response: { candidates: [] } });
  };
  const googleFetch = createGoogleFetch({
    tokenManager: manager,
    config: resolveConnectorConfig({}, {}),
    upstreamFetch: upstream,
  });
  await googleFetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    { method: "POST", body: new TextEncoder().encode(JSON.stringify({ contents: [] })) },
  );
  assert.equal(JSON.parse(seenBody).project, "proj-1");
});

test("fetch interceptor force-refreshes exactly once on a 401", async () => {
  let calls = 0;
  const manager = makeTokenManager(storedAuth(), {
    refreshFn: async () => ({ accessToken: "access-2", expiresAt: Date.now() + 3600_000 }),
  });
  const upstream = async (url, init) => {
    calls++;
    const authz = new Headers(init.headers).get("authorization");
    if (calls === 1) {
      assert.equal(authz, "Bearer access-1");
      return Response.json({ error: { code: 401, message: "stale", status: "UNAUTHENTICATED" } }, { status: 401 });
    }
    assert.equal(authz, "Bearer access-2");
    return Response.json({ response: { candidates: [] } });
  };
  const googleFetch = createGoogleFetch({
    tokenManager: manager,
    config: resolveConnectorConfig({}, {}),
    upstreamFetch: upstream,
  });
  const response = await googleFetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    { method: "POST", body: JSON.stringify({ contents: [] }) },
  );
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
});

test("streaming responses are unwrapped; non-Gemini traffic passes through untouched", async () => {
  const manager = makeTokenManager(storedAuth());
  const encoder = new TextEncoder();
  const upstream = async (url) => {
    if (String(url).includes("example.com")) return new Response("passthrough");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: { candidates: [] }, traceId: "s1" })}\n\n`));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const googleFetch = createGoogleFetch({
    tokenManager: manager,
    config: resolveConnectorConfig({}, {}),
    upstreamFetch: upstream,
  });

  const streamed = await googleFetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
    { method: "POST", body: JSON.stringify({ contents: [] }) },
  );
  assert.match(await streamed.text(), /"responseId":"s1"/);

  const other = await googleFetch("https://example.com/anything");
  assert.equal(await other.text(), "passthrough");
});

test("quota errors come back Google-shaped with connector guidance", async () => {
  const manager = makeTokenManager(storedAuth());
  const upstream = async () =>
    Response.json({ error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }, { status: 429 });
  const googleFetch = createGoogleFetch({
    tokenManager: manager,
    config: resolveConnectorConfig({}, {}),
    upstreamFetch: upstream,
  });
  const response = await googleFetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    { method: "POST", body: JSON.stringify({ contents: [] }) },
  );
  assert.equal(response.status, 429);
  const json = await response.json();
  assert.match(json.error.message, /quota/i);
});

test("model reconciliation only hides unavailable catalog models", () => {
  const models = {
    "gemini-2.5-pro": { cost: { input: 1.25, output: 10 } },
    "gemini-3-pro-preview": {},
    "my-custom-model": {},
  };
  zeroSubscriptionCosts(models);
  assert.equal(models["gemini-2.5-pro"].cost.input, 0);

  const removed = reconcileProviderModels(models, ["gemini-2.5-pro"]);
  assert.deepEqual(removed, ["gemini-3-pro-preview"]);
  assert.ok("my-custom-model" in models);

  // Unknown ID scheme → conservative no-op.
  const models2 = { "gemini-2.5-pro": {} };
  assert.deepEqual(reconcileProviderModels(models2, ["some-internal-id"]), []);
  assert.ok("gemini-2.5-pro" in models2);
});
