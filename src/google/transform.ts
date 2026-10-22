import { randomUUID } from "node:crypto";

import type { BackendProfile } from "../config.js";
import { isRecord } from "../log.js";
import { hasMigrationSignal } from "./codeassist.js";

/**
 * Translation layer between the public Gemini API shape (what OpenCode's
 * built-in `google` provider / @ai-sdk/google emits and expects) and the
 * Cloud Code Assist `v1internal` envelope:
 *
 *   request : { model, project, user_prompt_id?, request: { contents, ... } }
 *   response: { response: { candidates, ... }, traceId }
 *
 * Antigravity additionally expects { userAgent: "antigravity",
 * requestType: "agent", requestId } on the envelope.
 */

/** Accepted placeholder when replaying tool calls that predate thought signatures. */
export const THOUGHT_SIGNATURE_PLACEHOLDER = "skip_thought_signature_validator";

export type GenerateAction = "generateContent" | "streamGenerateContent" | "countTokens";

export interface ParsedGenerateRequest {
  model: string;
  action: GenerateAction;
  streaming: boolean;
  url: string;
}

export function requestUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const GENERATE_PATH = /\/models\/([^/:?]+):(generateContent|streamGenerateContent|countTokens)\b/;

export function parseGenerateRequest(input: RequestInfo | URL): ParsedGenerateRequest | undefined {
  const url = requestUrlString(input);
  if (!url.includes("generativelanguage.googleapis.com") && !GENERATE_PATH.test(url)) return undefined;
  const match = GENERATE_PATH.exec(url);
  if (!match) return undefined;
  const action = match[2] as GenerateAction;
  return {
    model: decodeURIComponent(match[1] ?? ""),
    action,
    streaming: action === "streamGenerateContent",
    url,
  };
}

export interface WrapOptions {
  model: string;
  projectId: string;
  profile: BackendProfile;
  sessionId: string;
  userPromptId?: string;
  requestId?: string;
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isGemini3Model(model: string): boolean {
  return /^gemini-3(\.|-|$)/.test(model);
}

/**
 * Sanitize conversation history for the Code Assist backend:
 * - drop `thought: true` parts (reasoning text must not be replayed as content);
 * - Gemini 3 requires a thoughtSignature on replayed functionCall parts. Fill
 *   the documented placeholder for calls that originated without one
 *   (e.g. cross-provider history), so multi-turn tool use doesn't 400.
 */
export function sanitizeContents(contents: unknown, model: string): unknown {
  if (!Array.isArray(contents)) return contents;
  const needsSignatures = isGemini3Model(model);
  const sanitized: unknown[] = [];
  for (const content of contents) {
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      sanitized.push(content);
      continue;
    }
    const parts = (content.parts as unknown[])
      .filter((part) => !(isRecord(part) && part.thought === true))
      .map((part) => {
        if (
          needsSignatures &&
          isRecord(part) &&
          isRecord(part.functionCall) &&
          typeof part.thoughtSignature !== "string"
        ) {
          return { ...part, thoughtSignature: THOUGHT_SIGNATURE_PLACEHOLDER };
        }
        return part;
      });
    // Drop model turns that consisted solely of (now removed) thought parts.
    if (parts.length === 0 && content.role === "model") continue;
    sanitized.push({ ...content, parts });
  }
  return sanitized;
}

/** Normalize an @ai-sdk/google request body into the inner v1internal `request` object. */
export function toInnerRequest(body: Record<string, unknown>, options: WrapOptions): Record<string, unknown> {
  const inner = deepCloneJson(body);
  delete inner.model;
  delete inner.stream;
  if ("system_instruction" in inner && !("systemInstruction" in inner)) {
    inner.systemInstruction = inner.system_instruction;
  }
  delete inner.system_instruction;
  if (typeof inner.cached_content === "string" && typeof inner.cachedContent !== "string") {
    inner.cachedContent = inner.cached_content;
  }
  delete inner.cached_content;
  delete inner.extra_body;

  if ("contents" in inner) {
    inner.contents = sanitizeContents(inner.contents, options.model);
  }

  // session affinity fields differ per surface (proto field name vs JSON name).
  if (options.profile === "antigravity") {
    inner.sessionId = options.sessionId;
  } else {
    inner.session_id = options.sessionId;
  }
  return inner;
}

export function wrapGenerateRequest(
  body: Record<string, unknown>,
  options: WrapOptions,
): Record<string, unknown> {
  // Already wrapped (e.g. a client that speaks v1internal natively): just restamp.
  if (typeof body.project === "string" && isRecord(body.request)) {
    return { ...body, model: options.model, project: options.projectId };
  }

  const request = toInnerRequest(body, options);
  if (options.profile === "antigravity") {
    return {
      project: options.projectId,
      model: options.model,
      request,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: options.requestId ?? randomUUID(),
    };
  }
  return {
    project: options.projectId,
    model: options.model,
    user_prompt_id: options.userPromptId ?? randomUUID(),
    request,
  };
}

/** countTokens has its own envelope: { request: { model: "models/<id>", contents } }. */
export function wrapCountTokensRequest(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (isRecord(body.request)) return body;
  const inner: Record<string, unknown> = { model: `models/${model}` };
  if ("contents" in body) inner.contents = sanitizeContents(body.contents, model);
  if (isRecord(body.generateContentRequest)) {
    // Public API nests countTokens under generateContentRequest in some clients.
    const nested = body.generateContentRequest;
    if ("contents" in nested) inner.contents = sanitizeContents(nested.contents, model);
  }
  return { request: inner };
}

/** Unwrap one v1internal response object into the public Gemini API shape. */
export function unwrapGenerateResponse(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.response)) return value;
  const inner: Record<string, unknown> = { ...value.response };
  if (typeof inner.responseId !== "string" && typeof value.traceId === "string") {
    inner.responseId = value.traceId;
  }
  return inner;
}

function transformSseDataPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === "[DONE]") return payload;
  try {
    return JSON.stringify(unwrapGenerateResponse(JSON.parse(trimmed)));
  } catch {
    return payload;
  }
}

/** Rewrite an SSE byte stream, unwrapping each `data:` JSON event. Chunk-safe. */
export function transformSseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const rewriteBlock = (block: string): string => {
    if (!block.trim()) return block;
    return block
      .split(/\r?\n/)
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const space = line.startsWith("data: ") ? " " : "";
        return `data:${space}${transformSseDataPayload(line.slice(5 + space.length))}`;
      })
      .join("\n");
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          controller.enqueue(encoder.encode(`${rewriteBlock(block)}\n\n`));
          boundary = buffer.indexOf("\n\n");
        }
        // Handle CRLF-delimited events too.
        boundary = buffer.indexOf("\r\n\r\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 4);
          controller.enqueue(encoder.encode(`${rewriteBlock(block)}\r\n\r\n`));
          boundary = buffer.indexOf("\r\n\r\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) controller.enqueue(encoder.encode(rewriteBlock(buffer)));
      },
    }),
  );
}

/**
 * Append actionable guidance to a Google error body while keeping the
 * `{ error: { code, message, status } }` shape @ai-sdk/google parses.
 */
export function enhanceErrorBody(text: string, status: number, profile?: BackendProfile): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return text;

  const original = typeof parsed.error.message === "string" ? parsed.error.message : "";
  const hints: string[] = [];

  if (status === 401) {
    hints.push("Your Google sign-in has expired or been revoked. Reconnect Google from OpenCode's /connect menu.");
  } else if (status === 429) {
    hints.push("You've hit your Gemini plan quota/rate limit for now. Check remaining quota with `npx opencode-gemini-account quota`.");
  } else if (status === 403 && hasMigrationSignal(original)) {
    hints.push(
      profile === "antigravity"
        ? "Google refused this client for your plan. Consumer Gemini tiers were migrated to Antigravity on 2026-06-18; if this persists, use Google's official Antigravity app/CLI for this account."
        : "Google reports this account's tier isn't served via Code Assist sign-in (consumer tiers were migrated to Antigravity on 2026-06-18). Reconnect choosing the Antigravity (experimental) method, or see the README's Eligibility section.",
    );
  } else if (status === 403) {
    hints.push("Run `npx opencode-gemini-account doctor` to re-check this account's eligibility, project, and tier.");
  } else if (status === 404) {
    hints.push("That model isn't available on your Gemini plan/backend. Pick another model in /models or run `npx opencode-gemini-account models`.");
  }

  if (hints.length === 0) return text;
  parsed.error.message = `${original} [opencode-gemini-account] ${hints.join(" ")}`;
  return JSON.stringify(parsed);
}

export function googleErrorResponse(status: number, googleStatus: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message, status: googleStatus } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
