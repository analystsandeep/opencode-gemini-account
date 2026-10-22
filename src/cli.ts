#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  defaultEndpointForProfile,
  oauthClientFor,
  resolveConnectorConfig,
  type ConnectorConfig,
  type ProfileMode,
} from "./config.js";
import { CONNECTOR_VERSION, MANUAL_REDIRECT_URI, PLUGIN_ID, PROVIDER_ID } from "./constants.js";
import { ConnectorError } from "./errors.js";
import {
  CodeAssistClient,
  resolveAccountAccess,
  type EligibilityResult,
} from "./google/codeassist.js";
import { fetchUserInfo, revokeToken } from "./google/oauth.js";
import { MODEL_CATALOG } from "./models.js";
import {
  TokenManager,
  parseStoredCredential,
  type ResolvedCredentials,
} from "./plugin/credentials.js";
import { createLoginSession } from "./plugin/login.js";
import { startLoopbackReceiver } from "./plugin/loopback.js";
import { redactSecrets } from "./log.js";
import {
  readAuthFile,
  readGoogleCredentials,
  removeGoogleCredentials,
  resolveOpenCodeAuthFile,
  resolveOpenCodeConfigFile,
  writeGoogleCredentials,
} from "./standalone/auth-file.js";

interface CliArgs {
  command: string;
  json: boolean;
  manual: boolean;
  noBrowser: boolean;
  profile?: ProfileMode;
  project?: string;
  authFile?: string;
}

const HELP = `opencode-gemini-account ${CONNECTOR_VERSION}
Use your Gemini plan in OpenCode. Sign in with Google, no API key.

Usage:
  ogac login [--profile auto|code-assist|antigravity] [--project <id>] [--manual] [--no-browser]
  ogac status [--json]
  ogac doctor [--json]
  ogac models [--json]
  ogac quota [--json]
  ogac logout
  ogac print-config [--experimental-antigravity]

Global:
  --auth-file <path>   OpenCode auth.json location (default: auto-detected)
  --help               Show this help

The normal path is inside OpenCode: /connect → Google → "Sign in with Google".
This CLI exists for headless machines, debugging, and eligibility reports.
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "help", json: false, manual: false, noBrowser: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--manual":
        args.manual = true;
        break;
      case "--no-browser":
        args.noBrowser = true;
        break;
      case "--experimental-antigravity":
        process.env.OPENCODE_GOOGLE_EXPERIMENTAL_ANTIGRAVITY = "1";
        break;
      case "--profile": {
        const value = argv[++i];
        if (value !== "auto" && value !== "code-assist" && value !== "antigravity") {
          throw new ConnectorError("bad_args", `--profile must be auto, code-assist, or antigravity (got "${value}").`);
        }
        args.profile = value;
        break;
      }
      case "--project":
        args.project = argv[++i];
        break;
      case "--auth-file":
        args.authFile = argv[++i];
        break;
      case "--help":
      case "-h":
        rest.push("help");
        break;
      default:
        rest.push(arg);
    }
  }
  args.command = rest[0] ?? "help";
  return args;
}

function buildConfig(args: CliArgs): ConnectorConfig {
  const config = resolveConnectorConfig();
  if (args.profile) config.profileMode = args.profile;
  if (args.project) config.projectId = args.project;
  if (args.profile === "antigravity") config.experimentalAntigravity = true;
  return config;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else if (typeof value === "string") {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function openBrowser(url: string): void {
  try {
    const [command, commandArgs] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const child = spawn(command as string, commandArgs as string[], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // The URL is printed regardless; opening is best effort.
  }
}

async function requireCredentials(authFile: string): Promise<ResolvedCredentials> {
  const credentials = await readGoogleCredentials(authFile);
  if (!credentials) {
    throw new ConnectorError("not_signed_in", `No Google OAuth credential found in ${authFile}.`, {
      hint: "Sign in inside OpenCode (/connect → Google) or run: ogac login",
    });
  }
  return credentials;
}

function tokenManagerFor(authFile: string, config: ConnectorConfig): TokenManager {
  return new TokenManager({
    getAuth: async () => {
      const data = await readAuthFile(authFile);
      return data[PROVIDER_ID];
    },
    persist: async (credential) => {
      const parsed = parseStoredCredential(credential);
      if (parsed) await writeGoogleCredentials(authFile, parsed);
    },
    clientFor: (kind) => oauthClientFor(config, kind),
  });
}

async function ensureEligibility(
  authFile: string,
  config: ConnectorConfig,
  options: { allowOnboard: boolean },
): Promise<{ credentials: ResolvedCredentials; eligibility: EligibilityResult }> {
  const manager = tokenManagerFor(authFile, config);
  const credentials = await manager.getValidCredentials();
  const eligibility = await resolveAccountAccess({
    accessToken: credentials.accessToken,
    config,
    mode: credentials.meta.profile ?? config.profileMode,
    configuredProjectId: credentials.meta.projectId ?? config.projectId,
    allowOnboard: options.allowOnboard,
  });
  let updated = credentials;
  if (eligibility.status === "eligible") {
    updated = await manager.updateMeta({
      projectId: eligibility.projectId ?? credentials.meta.projectId,
      managedProjectId: eligibility.managedProjectId,
      profile: eligibility.profile,
      endpoint: eligibility.endpoint,
      tierId: eligibility.tierId,
      planLabel: eligibility.planLabel,
      availableModelIds: eligibility.availableModelIds ?? credentials.meta.availableModelIds,
      modelsCheckedAt: eligibility.availableModelIds ? Date.now() : credentials.meta.modelsCheckedAt,
    });
  }
  return { credentials: updated, eligibility };
}

function clientFor(credentials: ResolvedCredentials, config: ConnectorConfig): CodeAssistClient {
  const profile = credentials.meta.profile ?? "code-assist";
  return new CodeAssistClient({
    endpoint: credentials.meta.endpoint ?? defaultEndpointForProfile(profile, config),
    profile,
    getAccessToken: () => credentials.accessToken,
    config,
  });
}

async function cmdLogin(args: CliArgs): Promise<void> {
  const authFile = resolveOpenCodeAuthFile(process.env, args.authFile);
  const config = buildConfig(args);
  const backend: ProfileMode = args.profile ?? config.profileMode;

  if (backend === "antigravity") {
    console.error(
      "⚠️  Experimental Antigravity profile: this uses Google's consumer Antigravity backend,\n" +
        "    which is unofficial for third-party tools and may be restricted by Google at any time.\n" +
        "    Use an account you can afford to have rate-limited. See README → Risks & eligibility.",
    );
  }

  let login;
  if (args.manual) {
    const session = createLoginSession({
      config,
      backend,
      redirectUri: MANUAL_REDIRECT_URI,
      configuredProjectId: args.project ?? config.projectId,
    });
    console.log("Open this URL in your browser and sign in:\n\n" + session.url + "\n");
    if (!args.noBrowser) openBrowser(session.url);
    const rl = createInterface({ input, output });
    try {
      const pasted = await rl.question(
        "Paste the full redirected URL (the error page is expected) or the authorization code: ",
      );
      login = await session.complete(pasted);
    } finally {
      rl.close();
    }
  } else {
    const receiver = await startLoopbackReceiver();
    try {
      const session = createLoginSession({
        config,
        backend,
        redirectUri: receiver.redirectUri,
        configuredProjectId: args.project ?? config.projectId,
      });
      console.log("Opening Google sign-in in your browser…\n" + session.url + "\n");
      if (!args.noBrowser) openBrowser(session.url);
      const { code, state } = await receiver.waitForCallback();
      login = await session.complete(
        `${receiver.redirectUri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`,
      );
    } finally {
      receiver.close();
    }
  }

  if (!login.tokens.refreshToken) {
    throw new ConnectorError("missing_refresh_token", "Google did not return a refresh token.");
  }
  await writeGoogleCredentials(authFile, {
    accessToken: login.tokens.accessToken,
    refreshToken: login.tokens.refreshToken,
    expiresAt: login.tokens.expiresAt,
    meta: login.meta,
  });

  print(
    args.json
      ? {
          signedIn: true,
          email: login.email,
          plan: login.eligibility.planLabel,
          tierId: login.eligibility.tierId,
          profile: login.eligibility.profile,
          project: login.eligibility.projectId,
          models: login.eligibility.availableModelIds,
          authFile,
        }
      : `✅ Signed in as ${login.email ?? "(unknown email)"}\n` +
          `   Plan:    ${login.eligibility.planLabel}${login.eligibility.tierId ? ` (${login.eligibility.tierId})` : ""}\n` +
          `   Backend: ${login.eligibility.profile} at ${login.eligibility.endpoint}\n` +
          `   Project: ${login.eligibility.projectId ?? "(none)"}\n` +
          (login.eligibility.availableModelIds
            ? `   Models:  ${login.eligibility.availableModelIds.join(", ")}\n`
            : "") +
          `   Saved:   ${authFile}\n\nOpen OpenCode and choose a google/… model with /models.`,
    args.json,
  );
}

async function cmdStatus(args: CliArgs): Promise<void> {
  const authFile = resolveOpenCodeAuthFile(process.env, args.authFile);
  const config = buildConfig(args);
  const stored = await requireCredentials(authFile);
  const { credentials, eligibility } = await ensureEligibility(authFile, config, { allowOnboard: false });

  let email = credentials.meta.email;
  if (!email) {
    try {
      email = (await fetchUserInfo(credentials.accessToken)).email;
    } catch {
      // keep unknown
    }
  }

  const report = {
    signedIn: true,
    email,
    plan: eligibility.planLabel,
    tierId: eligibility.tierId,
    eligibility: eligibility.status,
    needsOnboarding: eligibility.needsOnboarding ?? false,
    profile: eligibility.profile,
    endpoint: eligibility.endpoint,
    project: eligibility.projectId ?? stored.meta.projectId,
    accessTokenExpiresAt: new Date(credentials.expiresAt).toISOString(),
    storedModels: credentials.meta.availableModelIds,
    reasons: eligibility.reasons,
    validationUrl: eligibility.validationUrl,
    authFile,
  };
  print(
    args.json
      ? report
      : `Google account: ${report.email ?? "(unknown)"}\n` +
          `Plan:           ${report.plan}${report.tierId ? ` (${report.tierId})` : ""}\n` +
          `Eligibility:    ${report.eligibility}${report.needsOnboarding ? " (onboarding pending. Run: ogac login)" : ""}\n` +
          `Backend:        ${report.profile} at ${report.endpoint}\n` +
          `Project:        ${report.project ?? "(none)"}\n` +
          `Token expires:  ${report.accessTokenExpiresAt} (auto-refreshed by the plugin)\n` +
          (report.reasons.length > 0 ? `Notes:          ${report.reasons.join(", ")}\n` : "") +
          (report.validationUrl ? `Validation:     ${report.validationUrl}\n` : ""),
    args.json,
  );
}

async function cmdModels(args: CliArgs): Promise<void> {
  const authFile = resolveOpenCodeAuthFile(process.env, args.authFile);
  const config = buildConfig(args);
  await requireCredentials(authFile);
  const { credentials, eligibility } = await ensureEligibility(authFile, config, { allowOnboard: true });
  if (eligibility.status !== "eligible") {
    throw new ConnectorError("account_ineligible", `Account is not eligible (${eligibility.status}): ${eligibility.reasons.join(", ")}`);
  }
  const client = clientFor(credentials, config);
  let models: Array<{ id: string; displayName?: string; remainingFraction?: number; resetTime?: string }> = [];
  try {
    models = await client.fetchAvailableModels(eligibility.projectId);
  } catch {
    // fall back to catalog below
  }
  if (models.length === 0) {
    models = MODEL_CATALOG.map((m) => ({ id: m.id, displayName: m.name }));
    print(
      args.json
        ? { source: "static-catalog", models }
        : "Live model discovery is unavailable on this backend. Showing the built-in catalog:\n" +
            models.map((m) => `  google/${m.id}`).join("\n"),
      args.json,
    );
    return;
  }
  await writeGoogleCredentials(authFile, {
    ...credentials,
    meta: { ...credentials.meta, availableModelIds: models.map((m) => m.id), modelsCheckedAt: Date.now() },
  });
  print(
    args.json
      ? { source: "fetchAvailableModels", models }
      : "Models available on your account:\n" +
          models
            .map((m) => {
              const quota =
                typeof m.remainingFraction === "number"
                  ? `  (${Math.round(m.remainingFraction * 100)}% quota left${m.resetTime ? `, resets ${m.resetTime}` : ""})`
                  : "";
              return `  google/${m.id}${quota}`;
            })
            .join("\n") +
          "\n\nThe list was saved; OpenCode's /models picker will hide models your plan doesn't include.",
    args.json,
  );
}

async function cmdQuota(args: CliArgs): Promise<void> {
  const authFile = resolveOpenCodeAuthFile(process.env, args.authFile);
  const config = buildConfig(args);
  await requireCredentials(authFile);
  const { credentials, eligibility } = await ensureEligibility(authFile, config, { allowOnboard: false });
  const client = clientFor(credentials, config);
  const buckets = await client.retrieveUserQuota(eligibility.projectId ?? credentials.meta.projectId);
  if (buckets.length === 0) {
    print(args.json ? { buckets: [] } : "No quota buckets returned for this account/backend.", args.json);
    return;
  }
  print(
    args.json
      ? { buckets }
      : "Quota (remaining fraction per model):\n" +
          buckets
            .map((b) => {
              const pct = typeof b.remainingFraction === "number" ? `${Math.round(b.remainingFraction * 100)}% left` : (b.remainingAmount ?? "?");
              return `  ${(b.modelId ?? "(unknown model)").padEnd(38)} ${pct}${b.resetTime ? `  resets ${b.resetTime}` : ""}`;
            })
            .join("\n"),
    args.json,
  );
}

async function cmdLogout(args: CliArgs): Promise<void> {
  const authFile = resolveOpenCodeAuthFile(process.env, args.authFile);
  const credentials = await readGoogleCredentials(authFile);
  let revoked = false;
  if (credentials?.refreshToken) {
    revoked = await revokeToken(credentials.refreshToken);
  }
  const removed = await removeGoogleCredentials(authFile);
  print(
    args.json
      ? { removed, revoked }
      : removed
        ? `Signed out. Local credential removed${revoked ? " and refresh token revoked at Google" : ""}.`
        : "No Google credential was stored.",
    args.json,
  );
}

async function cmdDoctor(args: CliArgs): Promise<void> {
  const authFile = resolveOpenCodeAuthFile(process.env, args.authFile);
  const configFile = resolveOpenCodeConfigFile();
  const config = buildConfig(args);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({ name: "runtime", ok: true, detail: `node ${process.version} (${process.platform}/${process.arch}), connector ${CONNECTOR_VERSION}` });
  const clientConfigured =
    config.oauthClient.source !== "unconfigured" ||
    config.antigravityOAuthClient.source !== "unconfigured";
  checks.push({
    name: "oauth-client",
    ok: clientConfigured,
    detail: clientConfigured
      ? `Code Assist: ${config.oauthClient.source}, Antigravity: ${config.antigravityOAuthClient.source}`
      : "No OAuth client is configured. Create oauth-clients.json from oauth-clients.example.json or set the client environment variables.",
  });
  checks.push({
    name: "experimental-antigravity",
    ok: true,
    detail: config.experimentalAntigravity ? "enabled for auto fallback" : "disabled (auto mode probes Code Assist only)",
  });

  try {
    const cfgStat = await stat(configFile);
    checks.push({ name: "opencode-config", ok: cfgStat.isFile(), detail: configFile });
  } catch {
    checks.push({ name: "opencode-config", ok: false, detail: `not found at ${configFile}. Run: ogac print-config` });
  }

  try {
    const authStat = await stat(authFile);
    const mode = authStat.mode & 0o777;
    checks.push({
      name: "auth-file",
      ok: true,
      detail: `${authFile}${process.platform !== "win32" && mode > 0o600 ? ` (warning: permissions ${mode.toString(8)} are broader than 600)` : ""}`,
    });
  } catch {
    checks.push({ name: "auth-file", ok: false, detail: `not found at ${authFile}. Sign in first.` });
  }

  const stored = await readGoogleCredentials(authFile).catch(() => undefined);
  if (!stored) {
    checks.push({ name: "credential", ok: false, detail: "No Google OAuth credential stored. Run /connect in OpenCode or `ogac login`." });
  } else {
    checks.push({
      name: "credential",
      ok: true,
      detail: `${stored.meta.email ?? "account"} • stored plan: ${stored.meta.planLabel ?? "unknown"} • profile: ${stored.meta.profile ?? "unknown"}`,
    });
    try {
      const { eligibility } = await ensureEligibility(authFile, config, { allowOnboard: false });
      checks.push({
        name: "live-eligibility",
        ok: eligibility.status === "eligible",
        detail: `${eligibility.status}: ${eligibility.planLabel}${eligibility.reasons.length ? ` (${eligibility.reasons.join(", ")})` : ""}`,
      });
    } catch (error) {
      checks.push({
        name: "live-eligibility",
        ok: false,
        detail: error instanceof ConnectorError ? error.toUserMessage() : String(error),
      });
    }
  }

  const healthy = checks.every((c) => c.ok || c.name === "experimental-antigravity" || c.name === "oauth-client" || c.name === "runtime");
  print(
    args.json
      ? { healthy, checks }
      : checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.name.padEnd(26)} ${c.detail}`).join("\n") +
          `\n\n${healthy ? "All core checks passed." : "Some checks failed. See above. Full guide: the Troubleshooting section of the README."}`,
    args.json,
  );
}

function cmdPrintConfig(args: CliArgs): void {
  const experimental = process.env.OPENCODE_GOOGLE_EXPERIMENTAL_ANTIGRAVITY === "1";
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: `${PLUGIN_ID}@latest`,
        options: { experimentalAntigravity: experimental },
      },
    ],
  };
  console.log(
    `Add this to ${resolveOpenCodeConfigFile()}:\n\n${JSON.stringify(config, null, 2)}\n\nThen in OpenCode open /connect, choose Google, and select "Sign in with Google (Gemini plan, no API key)".`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "login":
      await cmdLogin(args);
      break;
    case "status":
      await cmdStatus(args);
      break;
    case "doctor":
      await cmdDoctor(args);
      break;
    case "models":
      await cmdModels(args);
      break;
    case "quota":
      await cmdQuota(args);
      break;
    case "logout":
      await cmdLogout(args);
      break;
    case "print-config":
      cmdPrintConfig(args);
      break;
    case "help":
    default:
      console.log(HELP);
      if (args.command !== "help") process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConnectorError ? error.toUserMessage() : error instanceof Error ? error.message : String(error);
  console.error(`❌ ${redactSecrets(message)}`);
  process.exit(1);
});
