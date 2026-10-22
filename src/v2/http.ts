import { createHash } from "node:crypto";

import type { Credential, Plugin } from "@opencode/plugin";

import {
  buildProfileHeaders,
  type BackendProfile,
  type ConnectorConfig,
} from "../config.js";
import { CODE_ASSIST_API_VERSION, PROVIDER_ID } from "../constants.js";
import { ConnectorError, EligibilityError } from "../errors.js";
import { resolveAccountAccess, type EligibilityResult } from "../google/codeassist.js";
import {
  enhanceErrorBody,
  parseGenerateRequest,
  transformSseStream,
  unwrapGenerateResponse,
  wrapCountTokensRequest,
  wrapGenerateRequest,
} from "../google/transform.js";
import { DebugLog, isRecord, redactSecrets } from "../log.js";
import { decodeRefreshToken, type StoredOAuthMeta } from "../plugin/credentials.js";

/**
 * V2 equivalent of the V1 fetch interceptor.
 *
 * V2 exposes every outbound provider request through `session.hook`, so we
 * rewrite the public Gemini request into the Cloud Code Assist `v1internal`
 * envelope only when the active Google connection is an OAuth credential.
 * API-key / environment-key connections are left untouched.
 */
export interface GoogleHttpDeps {
  config: ConnectorConfig;
  log: DebugLog;
}

interface ResolvedContext {
  accessToken: string;
  projectId: string;
  profile: BackendProfile;
  endpoint: string;
}

interface CachedContext {
  key: string;
  projectId: string;
  profile: BackendProfile;
  endpoint: string;
}

function contextKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function userMessage(error: unknown): string {
  if (error instanceof EligibilityError || error instanceof ConnectorError) {
    return error.toUserMessage();
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function activeOAuthCredential(
  ctx: Plugin.Context,
): Promise<{ credential: Credential.OAuth; meta: StoredOAuthMeta; refreshToken: string } | undefined> {
  const connection = await ctx.integration.connection.active(PROVIDER_ID);
  if (!connection) return undefined;

  const value = await ctx.integration.connection.resolve(connection);
  if (!value || value.type !== "oauth") return undefined;

  const { refreshToken, meta } = decodeRefreshToken(value.refresh);
  return { credential: value, meta, refreshToken };
}

export async function registerGoogleHttpHooks(
  ctx: Plugin.Context,
  deps: GoogleHttpDeps,
): Promise<void> {
  let cached: CachedContext | undefined;

  const resolveContext = async (): Promise<ResolvedContext | undefined> => {
    const active = await activeOAuthCredential(ctx);
    if (!active) return undefined;

    const { credential, meta, refreshToken } = active;
    const key = contextKey(refreshToken);

    if (cached?.key === key) {
      return {
        accessToken: credential.access,
        projectId: cached.projectId,
        profile: cached.profile,
        endpoint: cached.endpoint,
      };
    }

    // Sign-in normally stores project/profile/endpoint in the credential's
    // refresh suffix. This fallback covers credentials imported by older
    // versions or restored from another machine.
    if (meta.projectId && meta.profile && meta.endpoint) {
      cached = {
        key,
        projectId: meta.projectId,
        profile: meta.profile,
        endpoint: meta.endpoint,
      };
      return {
        accessToken: credential.access,
        projectId: cached.projectId,
        profile: cached.profile,
        endpoint: cached.endpoint,
      };
    }

    const mode = meta.profile ?? deps.config.profileMode;
    const eligibility: EligibilityResult = await resolveAccountAccess({
      accessToken: credential.access,
      config: deps.config,
      mode,
      configuredProjectId: meta.projectId ?? deps.config.projectId,
    });
    if (eligibility.status !== "eligible" || !eligibility.projectId) {
      throw new EligibilityError(eligibility);
    }

    cached = {
      key,
      projectId: eligibility.projectId,
      profile: eligibility.profile,
      endpoint: eligibility.endpoint,
    };
    return {
      accessToken: credential.access,
      projectId: eligibility.projectId,
      profile: eligibility.profile,
      endpoint: eligibility.endpoint,
    };
  };

  await ctx.session.hook(
    "http.request",
    async (event) => {
      const parsed = parseGenerateRequest(event.request.url);
      if (!parsed) return;

      let context: ResolvedContext | undefined;
      try {
        context = await resolveContext();
      } catch (error) {
        throw new Error(redactSecrets(userMessage(error)));
      }
      // No OAuth connection means the built-in API-key/env flow should run.
      if (!context) return;

      let body: Record<string, unknown>;
      try {
        const text = await event.request.clone().text();
        const parsedBody: unknown = text ? JSON.parse(text) : {};
        if (!isRecord(parsedBody)) throw new Error("request body is not a JSON object");
        body = parsedBody;
      } catch (error) {
        throw new ConnectorError(
          "invalid_request_body",
          `Could not rewrite the Gemini request for Google account auth: ${userMessage(error)}`,
        );
      }

      const wrapped =
        parsed.action === "countTokens"
          ? wrapCountTokensRequest(body, parsed.model)
          : wrapGenerateRequest(body, {
              model: parsed.model,
              projectId: context.projectId,
              profile: context.profile,
              // V2 sends the session id as a header; use it for backend affinity.
              sessionId: event.sessionID,
            });

      const headers = new Headers(event.request.headers);
      for (const [name, value] of Object.entries(
        buildProfileHeaders(context.profile, context.accessToken, deps.config, parsed.model),
      )) {
        headers.set(name, value);
      }
      headers.delete("x-goog-api-key");
      headers.delete("x-api-key");
      headers.delete("content-length");
      if (parsed.streaming) headers.set("Accept", "text/event-stream");

      const target = `${context.endpoint}/${CODE_ASSIST_API_VERSION}:${parsed.action}${
        parsed.streaming ? "?alt=sse" : ""
      }`;

      deps.log.log(
        `V2 → ${parsed.action} model=${parsed.model} profile=${context.profile} endpoint=${context.endpoint}`,
      );

      event.request = new Request(target, {
        method: "POST",
        headers,
        body: JSON.stringify(wrapped),
        signal: event.request.signal,
      });
    },
    { providerID: PROVIDER_ID },
  );

  await ctx.session.hook(
    "http.response",
    async (event) => {
      if (!event.request.url.includes(`/${CODE_ASSIST_API_VERSION}:`)) return;

      const response = event.response;
      const contentType = response.headers.get("content-type") ?? "";
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");

      if (!response.ok) {
        const text = await response.text();
        deps.log.log(`V2 ← HTTP ${response.status}`, text.slice(0, 400));
        event.response = new Response(enhanceErrorBody(text, response.status), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        return;
      }

      if (response.body && contentType.includes("text/event-stream")) {
        event.response = new Response(transformSseStream(response.body), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        return;
      }

      if (contentType.includes("application/json")) {
        const text = await response.text();
        let output = text;
        try {
          output = JSON.stringify(unwrapGenerateResponse(JSON.parse(text)));
        } catch {
          // Keep the original body when it isn't JSON we recognise.
        }
        event.response = new Response(output, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    },
    { providerID: PROVIDER_ID },
  );
}
