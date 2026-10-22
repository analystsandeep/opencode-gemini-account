import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "./log.js";

export interface LocalOAuthClient {
  clientId: string;
  clientCredential: string;
}

export interface LocalOAuthClients {
  codeAssist?: LocalOAuthClient;
  antigravity?: LocalOAuthClient;
}

const DEFAULT_CLIENTS_FILE = fileURLToPath(new URL("../oauth-clients.json", import.meta.url));

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseClient(value: unknown): LocalOAuthClient | undefined {
  if (!isRecord(value)) return undefined;
  const clientId = firstString(value.clientId, value.client_id);
  const clientCredential = firstString(
    value.clientSecret,
    value.client_secret,
    value.clientCredential,
    value.client_credential,
  );
  return clientId && clientCredential ? { clientId, clientCredential } : undefined;
}

/**
 * Loads the optional local OAuth client file.
 *
 * The file stays out of Git history. It lets local builds and npm packages
 * provide a ready-to-use public installed-app client while the repository
 * source remains free of OAuth client values. Plugin options and environment
 * variables take precedence over this file.
 *
 * Points OPENCODE_GOOGLE_CLIENTS_FILE at another JSON file to override the
 * default location. A missing or malformed file simply leaves the connector
 * unconfigured, and the sign-in error explains how to fix it.
 */
export function loadLocalOAuthClients(env: NodeJS.ProcessEnv = process.env): LocalOAuthClients {
  const path = firstString(env.OPENCODE_GOOGLE_CLIENTS_FILE) ?? DEFAULT_CLIENTS_FILE;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  return {
    codeAssist: parseClient(parsed.codeAssist ?? parsed["code-assist"]),
    antigravity: parseClient(parsed.antigravity),
  };
}
