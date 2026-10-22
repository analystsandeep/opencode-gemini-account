#!/usr/bin/env node
/**
 * Writes the public installed-app OAuth client from a local checkout of
 * Google's Apache-2.0 Gemini CLI into the untracked oauth-clients.json file.
 *
 *   git clone https://github.com/google-gemini/gemini-cli
 *   node scripts/sync-public-client.mjs ../gemini-cli/packages/core/src/code_assist/oauth2.ts
 *
 * The file is intentionally ignored by Git. It is included in npm packages when
 * present, so a published package can work without setup. The repository source
 * stays free of OAuth client values. Users can override the file with plugin
 * options or OPENCODE_GOOGLE_CLIENT_ID / OPENCODE_GOOGLE_CLIENT_SECRET.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = process.argv[2] ?? process.env.GEMINI_CLI_OAUTH_SOURCE;
if (!sourcePath) {
  console.error("Usage: node scripts/sync-public-client.mjs <path-to-gemini-cli oauth2.ts>");
  process.exit(2);
}

const source = readFileSync(resolve(sourcePath), "utf8");
const id = source.match(/OAUTH_CLIENT_ID\s*=\s*'([^']+)'/)?.[1];
const credential = source.match(/OAUTH_CLIENT_SECRET\s*=\s*'([^']+)'/)?.[1];
if (!id || !credential) {
  console.error("Could not find OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET constants in the source file.");
  process.exit(1);
}

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "../oauth-clients.json");

let existing = {};
if (existsSync(outPath)) {
  try {
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed;
    }
  } catch {
    existing = {};
  }
}

const data = {
  ...existing,
  codeAssist: { clientId: id, clientSecret: credential },
};

writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
try {
  chmodSync(outPath, 0o600);
} catch {
  // Windows ignores POSIX modes. The file is untracked and local.
}

console.log(`Wrote ${outPath}.`);
console.log(`Code Assist client ID length: ${id.length}. Existing profiles preserved: ${Object.keys(existing).join(", ") || "none"}.`);
