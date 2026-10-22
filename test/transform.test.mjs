import assert from "node:assert/strict";
import test from "node:test";

import {
  enhanceErrorBody,
  parseGenerateRequest,
  sanitizeContents,
  transformSseStream,
  unwrapGenerateResponse,
  wrapCountTokensRequest,
  wrapGenerateRequest,
} from "../dist/index.js";

const generateUrl =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse";

test("parses Gemini API request URLs and ignores unrelated traffic", () => {
  const parsed = parseGenerateRequest(generateUrl);
  assert.equal(parsed.model, "gemini-3-pro-preview");
  assert.equal(parsed.action, "streamGenerateContent");
  assert.equal(parsed.streaming, true);
  assert.equal(parseGenerateRequest("https://example.com/v1/chat"), undefined);
});

test("wraps a public request into the code-assist envelope", () => {
  const wrapped = wrapGenerateRequest(
    {
      model: "should-be-stripped",
      system_instruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0.2 },
    },
    { model: "gemini-2.5-pro", projectId: "proj-1", profile: "code-assist", sessionId: "sess-1", userPromptId: "up-1" },
  );
  assert.equal(wrapped.project, "proj-1");
  assert.equal(wrapped.model, "gemini-2.5-pro");
  assert.equal(wrapped.user_prompt_id, "up-1");
  assert.equal("model" in wrapped.request, false);
  assert.deepEqual(wrapped.request.systemInstruction, { parts: [{ text: "sys" }] });
  assert.equal(wrapped.request.session_id, "sess-1");
});

test("antigravity envelope carries userAgent/requestType/requestId", () => {
  const wrapped = wrapGenerateRequest(
    { contents: [] },
    { model: "gemini-3.5-flash", projectId: "p", profile: "antigravity", sessionId: "s", requestId: "r-1" },
  );
  assert.equal(wrapped.userAgent, "antigravity");
  assert.equal(wrapped.requestType, "agent");
  assert.equal(wrapped.requestId, "r-1");
  assert.equal(wrapped.request.sessionId, "s");
});

test("already-wrapped bodies are restamped, not double-wrapped", () => {
  const wrapped = wrapGenerateRequest(
    { project: "old", model: "old", request: { contents: [] } },
    { model: "new-model", projectId: "new-proj", profile: "code-assist", sessionId: "s" },
  );
  assert.equal(wrapped.project, "new-proj");
  assert.equal(wrapped.model, "new-model");
  assert.deepEqual(wrapped.request, { contents: [] });
});

test("history sanitization strips thought parts and backfills Gemini 3 thought signatures", () => {
  const contents = [
    {
      role: "model",
      parts: [
        { text: "secret reasoning", thought: true },
        { functionCall: { name: "read", args: {} } },
        { functionCall: { name: "write", args: {} }, thoughtSignature: "real-sig" },
      ],
    },
  ];
  const gemini3 = sanitizeContents(contents, "gemini-3-pro-preview");
  assert.equal(gemini3[0].parts.length, 2);
  assert.equal(gemini3[0].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(gemini3[0].parts[1].thoughtSignature, "real-sig");

  const gemini25 = sanitizeContents(contents, "gemini-2.5-pro");
  assert.equal(gemini25[0].parts[0].thoughtSignature, undefined);

  // A model turn that is *only* thought parts disappears entirely.
  const thoughtOnly = sanitizeContents(
    [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "thinking", thought: true }] },
    ],
    "gemini-3-pro-preview",
  );
  assert.equal(thoughtOnly.length, 1);
});

test("countTokens uses its own envelope shape", () => {
  const wrapped = wrapCountTokensRequest({ contents: [{ parts: [{ text: "x" }] }] }, "gemini-2.5-pro");
  assert.equal(wrapped.request.model, "models/gemini-2.5-pro");
  assert.ok(Array.isArray(wrapped.request.contents));
});

test("unwraps responses and injects responseId from traceId", () => {
  const out = unwrapGenerateResponse({ response: { candidates: [] }, traceId: "trace-9" });
  assert.deepEqual(out, { candidates: [], responseId: "trace-9" });
  assert.deepEqual(unwrapGenerateResponse({ candidates: [] }), { candidates: [] });
});

test("SSE transform unwraps events across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const payload = JSON.stringify({ response: { candidates: [{ index: 0 }] }, traceId: "t1" });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${payload.slice(0, 20)}`));
      controller.enqueue(encoder.encode(`${payload.slice(20)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const text = await new Response(transformSseStream(stream)).text();
  assert.match(text, /"candidates":\[\{"index":0\}\]/);
  assert.match(text, /"responseId":"t1"/);
  assert.doesNotMatch(text, /"traceId"/);
  assert.match(text, /\[DONE\]/);
});

test("error enhancement keeps Google shape and adds migration guidance", () => {
  const body = JSON.stringify({
    error: { code: 403, message: "UNSUPPORTED_CLIENT: consumer accounts migrated to Antigravity", status: "PERMISSION_DENIED" },
  });
  const enhanced = JSON.parse(enhanceErrorBody(body, 403, "code-assist"));
  assert.match(enhanced.error.message, /Antigravity \(experimental\) method/);
  const quota = JSON.parse(
    enhanceErrorBody(JSON.stringify({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }), 429),
  );
  assert.match(quota.error.message, /ogac|connector quota|quota`./);
});
