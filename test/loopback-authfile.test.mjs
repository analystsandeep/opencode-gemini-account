import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readGoogleCredentials,
  removeGoogleCredentials,
  resolveOpenCodeAuthFile,
  startLoopbackReceiver,
  writeGoogleCredentials,
} from "../dist/index.js";

test("loopback receiver serves only the callback path and resolves the code", async () => {
  const receiver = await startLoopbackReceiver({ preferredPort: 0, timeoutMs: 10_000 });
  try {
    const wrong = await fetch(`http://127.0.0.1:${receiver.port}/nope`);
    assert.equal(wrong.status, 404);

    const pending = receiver.waitForCallback();
    const page = await fetch(`${receiver.redirectUri}?code=abc123&state=xyz`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Signed in/);
    assert.deepEqual(await pending, { code: "abc123", state: "xyz" });
  } finally {
    receiver.close();
  }
});

test("loopback receiver reports Google errors instead of hanging", async () => {
  const receiver = await startLoopbackReceiver({ preferredPort: 0, timeoutMs: 10_000 });
  try {
    const pending = receiver.waitForCallback();
    const assertion = assert.rejects(pending, /access_denied/);
    await fetch(`${receiver.redirectUri}?error=access_denied`);
    await assertion;
  } finally {
    receiver.close();
  }
});

test("auth file round-trip preserves other providers and restricts permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogac-test-"));
  const authFile = join(dir, "auth.json");
  await writeFile(authFile, JSON.stringify({ openai: { type: "api", key: "keep-me" } }));

  const credentials = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 123456,
    meta: { v: 1, projectId: "proj", profile: "code-assist", email: "dev@example.com" },
  };
  await writeGoogleCredentials(authFile, credentials);

  const raw = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(raw.openai.key, "keep-me");
  assert.equal(raw.google.type, "oauth");

  const readBack = await readGoogleCredentials(authFile);
  assert.equal(readBack.refreshToken, "refresh-1");
  assert.equal(readBack.meta.projectId, "proj");

  if (process.platform !== "win32") {
    const mode = (await stat(authFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  assert.equal(await removeGoogleCredentials(authFile), true);
  assert.equal(await readGoogleCredentials(authFile), undefined);

  assert.ok(resolveOpenCodeAuthFile({ OPENCODE_AUTH_FILE: "/tmp/x/auth.json" }).endsWith("/tmp/x/auth.json"));
});
