import test from "node:test";
import assert from "node:assert/strict";

test("OpenCode 2 package entry exposes the V2 setup hook and keeps the V1 server", async () => {
  const { default: plugin } = await import("../server.js");

  assert.equal(plugin.id, "opencode-gemini-account");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(typeof plugin.server, "function");
});
