import { createServer, type Server } from "node:http";

import { DEFAULT_LOOPBACK_TIMEOUT_MS, LOOPBACK_PATH, PREFERRED_LOOPBACK_PORT } from "../constants.js";
import { ConnectorError, OAuthError } from "../errors.js";

/**
 * RFC 8252 loopback redirect receiver for desktop OAuth.
 *
 * Security properties:
 * - binds 127.0.0.1 only (never a routable interface);
 * - serves exactly one expected path and shuts down after the first callback;
 * - the caller verifies `state` and PKCE, so a stray local process hitting the
 *   port cannot complete the flow;
 * - times out rather than listening forever.
 */
export interface LoopbackReceiver {
  redirectUri: string;
  port: number;
  waitForCallback: () => Promise<{ code: string; state?: string }>;
  close: () => void;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resultPage(success: boolean, detail?: string): string {
  const title = success ? "Signed in to OpenCode" : "Google sign-in failed";
  const body = success
    ? "Your Google account is now connected to OpenCode. You can close this tab and return to the app."
    : `Something went wrong${detail ? `: ${escapeHtml(detail)}` : ""}. You can close this tab and try again from OpenCode.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0f14;color:#e6edf3}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}span{font-size:2.5rem}</style>
</head><body><main><span aria-hidden="true">${success ? "✅" : "⚠️"}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

export interface LoopbackOptions {
  preferredPort?: number;
  path?: string;
  timeoutMs?: number;
}

export async function startLoopbackReceiver(options: LoopbackOptions = {}): Promise<LoopbackReceiver> {
  const path = options.path ?? LOOPBACK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOPBACK_TIMEOUT_MS;

  let resolveCallback!: (value: { code: string; state?: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callbackPromise = new Promise<{ code: string; state?: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Avoid an unhandled rejection if the caller is torn down before awaiting.
  callbackPromise.catch(() => undefined);

  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    if (settled) {
      res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
      res.end(resultPage(false, "This sign-in link has already been used"));
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    settled = true;
    if (error || !code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(resultPage(false, error ?? "Missing authorization code"));
      rejectCallback(
        new OAuthError(`Google sign-in was not completed${error ? `: ${error}` : " (no code returned)"}.`, {
          oauthError: error ?? undefined,
        }),
      );
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(resultPage(true));
      resolveCallback({ code, state });
    }
    // Give the response a tick to flush before closing the listener.
    setTimeout(() => close(), 250);
  });

  const close = (): void => {
    if (timer) clearTimeout(timer);
    if (server.listening) server.close();
  };

  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCallback(new ConnectorError("oauth_timeout", "Timed out waiting for Google sign-in in the browser."));
    }
    close();
  }, timeoutMs);
  timer.unref?.();

  const port = await listen(server, options.preferredPort ?? PREFERRED_LOOPBACK_PORT);
  return {
    redirectUri: `http://127.0.0.1:${port}${path}`,
    port,
    waitForCallback: () => callbackPromise,
    close,
  };
}

function listen(server: Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && preferredPort !== 0) {
        // Google desktop OAuth allows any loopback port; fall back to ephemeral.
        server.removeListener("error", onError);
        void listen(server, 0).then(resolve, reject);
        return;
      }
      reject(
        new ConnectorError("loopback_bind_failed", `Could not start the local sign-in listener: ${error.message}`, {
          hint: "Use the manual paste sign-in method instead.",
        }),
      );
    };
    server.once("error", onError);
    server.listen(preferredPort, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new ConnectorError("loopback_bind_failed", "Local sign-in listener has no address."));
    });
  });
}
