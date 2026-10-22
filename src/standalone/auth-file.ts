import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { PROVIDER_ID } from "../constants.js";
import { isRecord } from "../log.js";
import {
  parseStoredCredential,
  toStoredCredential,
  type ResolvedCredentials,
} from "../plugin/credentials.js";

/**
 * OpenCode stores provider credentials in `auth.json` under its data dir
 * (XDG_DATA_HOME or ~/.local/share/opencode). The standalone CLI reads/writes
 * the same file so `ogac login` and the in-app /connect flow are interchangeable.
 */
export function resolveOpenCodeAuthFile(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  if (override) return override;
  if (env.OPENCODE_AUTH_FILE) return env.OPENCODE_AUTH_FILE;
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

export function resolveOpenCodeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG) return env.OPENCODE_CONFIG;
  if (env.OPENCODE_CONFIG_DIR) return join(env.OPENCODE_CONFIG_DIR, "opencode.json");
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "opencode", "opencode.json");
}

export async function readAuthFile(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeAuthFileAtomic(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows / exotic filesystems: best effort only.
  }
}

export async function readGoogleCredentials(
  authFile: string,
): Promise<ResolvedCredentials | undefined> {
  const data = await readAuthFile(authFile);
  return parseStoredCredential(data[PROVIDER_ID]);
}

export async function writeGoogleCredentials(
  authFile: string,
  credentials: ResolvedCredentials,
): Promise<void> {
  const data = await readAuthFile(authFile);
  data[PROVIDER_ID] = toStoredCredential(credentials, credentials.meta.email);
  await writeAuthFileAtomic(authFile, data);
}

export async function removeGoogleCredentials(authFile: string): Promise<boolean> {
  const data = await readAuthFile(authFile);
  if (!(PROVIDER_ID in data)) return false;
  delete data[PROVIDER_ID];
  await writeAuthFileAtomic(authFile, data);
  return true;
}
