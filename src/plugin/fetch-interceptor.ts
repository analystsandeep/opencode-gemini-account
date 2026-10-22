import { randomUUID } from "node:crypto";

import {
  buildProfileHeaders,
  type BackendProfile,
  type ConnectorConfig,
} from "../config.js";
import { CODE_ASSIST_API_VERSION } from "../constants.js";
import { ConnectorError, EligibilityError } from "../errors.js";
import { resolveAccountAccess, type EligibilityResult } from "../google/codeassist.js";
import {
  enhanceErrorBody,
  googleErrorResponse,
  parseGenerateRequest,
  transformSseStream,
  unwrapGenerateResponse,
  wrapCountTokensRequest,
  wrapGenerateRequest,
} from "../google/transform.js";
import { DebugLog, isRecord, redactSecrets } from "../log.js";
import type { ResolvedCredentials, TokenManager } from "./credentials.js";

/**
 * The fetch OpenCode's google provider will use for every model call once a
 * Google-account credential is active. Responsibilities, in order:
 *   1. pass non-Gemini-API traffic through untouched;
 *   2. ensure a fresh access token (refresh + persist on rotation);
 *   3. resolve (once, cached) the account's project/backend if sign-in
 *      metadata is missing, for example a credential imported from the CLI.
 *   4. rewrite the request to the v1internal envelope + Bearer auth;
 *   5. retry exactly once on 401 after a forced refresh;
 *   6. unwrap JSON / SSE responses back into the public Gemini shape and
 *      annotate errors with actionable guidance.
 */
export interface FetchInterceptorDeps {
  tokenManager: TokenManager;
  config: ConnectorConfig;
  upstreamFetch?: typeof fetch;
  log?: DebugLog;
  /** Injectable for tests. */
  resolveAccess?: (accessToken: string, mode: BackendProfile | "auto") => Promise<EligibilityResult>;
}

interface RequestContext {
  credentials: ResolvedCredentials;
  projectId: string;
  profile: BackendProfile;
  endpoint: string;
}

export function createGoogleFetch(deps: FetchInterceptorDeps): typeof fetch {
  const upstream = deps.upstreamFetch ?? fetch;
  const sessionId = randomUUID();
  let contextPromise: Promise<RequestContext> | undefined;

  const resolveContext = (forceRefresh = false): Promise<RequestContext> => {
    if (!forceRefresh && contextPromise) return contextPromise;
    contextPromise = (async (): Promise<RequestContext> => {
      const credentials = await deps.tokenManager.getValidCredentials(forceRefresh);
      let { projectId, profile, endpoint } = credentials.meta;

      if (!projectId || !profile || !endpoint) {
        const mode = profile ?? deps.config.profileMode;
        const eligibility = deps.resolveAccess
          ? await deps.resolveAccess(credentials.accessToken, mode)
          : await resolveAccountAccess({
              accessToken: credentials.accessToken,
              config: deps.config,
              mode,
              configuredProjectId: credentials.meta.projectId ?? deps.config.projectId,
              fetchImpl: upstream,
            });
        if (eligibility.status !== "eligible" || !eligibility.projectId) {
          throw new EligibilityError(eligibility);
        }
        const updated = await deps.tokenManager.updateMeta({
          projectId: eligibility.projectId,
          managedProjectId: eligibility.managedProjectId,
          profile: eligibility.profile,
          endpoint: eligibility.endpoint,
          tierId: eligibility.tierId,
          planLabel: eligibility.planLabel,
          availableModelIds: eligibility.availableModelIds ?? credentials.meta.availableModelIds,
          modelsCheckedAt: eligibility.availableModelIds ? Date.now() : credentials.meta.modelsCheckedAt,
        });
        return {
          credentials: updated,
          projectId: eligibility.projectId,
          profile: eligibility.profile,
          endpoint: eligibility.endpoint,
        };
      }

      return { credentials, projectId, profile, endpoint };
    })();
    // Don't cache a rejected promise forever; the next request may succeed
    // after the user fixes their account or reconnects.
    contextPromise.catch(() => {
      contextPromise = undefined;
    });
    return contextPromise;
  };

  const doFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const parsed = parseGenerateRequest(input as RequestInfo);
    if (!parsed) return upstream(input as RequestInfo, init);

    let context: RequestContext;
    try {
      context = await resolveContext();
    } catch (error) {
      return connectorErrorResponse(error);
    }

    const attempt = async (ctx: RequestContext): Promise<Response> => {
      const bodyText = await readBodyText(input as RequestInfo, init);
      const wrappedBody = wrapBody(bodyText, parsed.model, parsed.action, ctx, sessionId);
      const headers = mergeHeaders(input as RequestInfo, init);
      for (const [key, value] of Object.entries(
        buildProfileHeaders(ctx.profile, ctx.credentials.accessToken, deps.config, parsed.model),
      )) {
        headers.set(key, value);
      }
      headers.delete("x-goog-api-key");
      headers.delete("x-api-key");
      if (parsed.streaming) headers.set("Accept", "text/event-stream");

      const target = `${ctx.endpoint}/${CODE_ASSIST_API_VERSION}:${parsed.action}${parsed.streaming ? "?alt=sse" : ""}`;
      deps.log?.log(`→ ${parsed.action} model=${parsed.model} profile=${ctx.profile} endpoint=${ctx.endpoint}`);
      return upstream(target, {
        method: init?.method ?? (input instanceof Request ? input.method : "POST"),
        headers,
        body: wrappedBody,
        signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      });
    };

    let response = await attempt(context);
    if (response.status === 401) {
      // Token rejected despite our freshness check (revoked / clock skew): refresh once.
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      try {
        context = await resolveContext(true);
      } catch (error) {
        return connectorErrorResponse(error);
      }
      response = await attempt(context);
    }

    return transformResponse(response, parsed.streaming, context.profile, deps.log);
  }) as typeof fetch;

  return doFetch;
}

function connectorErrorResponse(error: unknown): Response {
  if (error instanceof EligibilityError) {
    return googleErrorResponse(403, "PERMISSION_DENIED", redactSecrets(error.toUserMessage()));
  }
  if (error instanceof ConnectorError) {
    const status = error.code === "oauth_error" ? 401 : 502;
    return googleErrorResponse(status, status === 401 ? "UNAUTHENTICATED" : "UNAVAILABLE", redactSecrets(error.toUserMessage()));
  }
  return googleErrorResponse(502, "UNAVAILABLE", `Google account connector error: ${redactSecrets(String(error))}`);
}

async function readBodyText(input: RequestInfo, init?: RequestInit): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (init?.body instanceof ArrayBuffer) return new TextDecoder().decode(init.body);
  if (init?.body instanceof Blob) return init.body.text();
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mergeHeaders(input: RequestInfo, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function wrapBody(
  bodyText: string | undefined,
  model: string,
  action: string,
  context: RequestContext,
  sessionId: string,
): string | undefined {
  if (!bodyText) return bodyText;
  try {
    const parsedBody: unknown = JSON.parse(bodyText);
    if (!isRecord(parsedBody)) return bodyText;
    const wrapped =
      action === "countTokens"
        ? wrapCountTokensRequest(parsedBody, model)
        : wrapGenerateRequest(parsedBody, {
            model,
            projectId: context.projectId,
            profile: context.profile,
            sessionId,
          });
    return JSON.stringify(wrapped);
  } catch {
    return bodyText;
  }
}

function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return headers;
}

async function transformResponse(
  response: Response,
  streaming: boolean,
  profile: BackendProfile,
  log?: DebugLog,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const text = await response.text();
    log?.log(`← HTTP ${response.status}`, text.slice(0, 400));
    return new Response(enhanceErrorBody(text, response.status, profile), {
      status: response.status,
      statusText: response.statusText,
      headers: cleanHeaders(response.headers),
    });
  }

  if (streaming && response.body && contentType.includes("text/event-stream")) {
    return new Response(transformSseStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: cleanHeaders(response.headers),
    });
  }

  if (contentType.includes("application/json")) {
    const text = await response.text();
    try {
      const unwrapped = unwrapGenerateResponse(JSON.parse(text));
      return new Response(JSON.stringify(unwrapped), {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
      });
    } catch {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
      });
    }
  }

  return response;
}
