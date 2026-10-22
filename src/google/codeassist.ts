import {
  buildClientMetadata,
  buildProfileHeaders,
  endpointCandidates,
  type BackendProfile,
  type ConnectorConfig,
  type ProfileMode,
} from "../config.js";
import { CODE_ASSIST_API_VERSION } from "../constants.js";
import { CodeAssistError, ConnectorError } from "../errors.js";
import { asString, isRecord, redactSecrets, sleep } from "../log.js";

/**
 * Client for Google's Cloud Code Assist private API (`v1internal`), the same
 * backend that serves Gemini CLI and Gemini Code Assist IDE extensions, plus
 * the account-eligibility resolver built on top of it.
 *
 * The request/response shapes mirror the public Apache-2.0 Gemini CLI source
 * (packages/core/src/code_assist/*). This is a clean-room implementation of the
 * client logic; Google may change these internal APIs without notice.
 */

export interface GeminiUserTier {
  id?: string;
  name?: string;
  description?: string;
  userDefinedCloudaicompanionProject?: boolean | null;
  isDefault?: boolean;
  hasOnboardedPreviously?: boolean;
  availableCredits?: Array<{ creditType?: string; creditAmount?: string }>;
  privacyNotice?: { showNotice?: boolean; noticeText?: string };
}

export interface IneligibleTier {
  reasonCode?: string;
  reasonMessage?: string;
  tierId?: string;
  tierName?: string;
  validationUrl?: string;
  validationErrorMessage?: string;
}

export interface LoadCodeAssistResponse {
  currentTier?: GeminiUserTier | null;
  allowedTiers?: GeminiUserTier[] | null;
  ineligibleTiers?: IneligibleTier[] | null;
  cloudaicompanionProject?: string | null;
  paidTier?: GeminiUserTier | null;
}

export interface LongRunningOperation {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
  error?: { code?: number; message?: string };
}

export interface AvailableModel {
  id: string;
  displayName?: string;
  remainingFraction?: number;
  resetTime?: string;
  supportsImages?: boolean;
  supportsVideo?: boolean;
  maxOutputTokens?: number;
}

export interface QuotaBucket {
  modelId?: string;
  tokenType?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
}

/** Minimal transport surface the eligibility resolver needs (fakeable in tests). */
export interface CodeAssistTransport {
  readonly endpoint: string;
  readonly profile: BackendProfile;
  loadCodeAssist(projectId?: string, signal?: AbortSignal): Promise<LoadCodeAssistResponse>;
  onboardUser(request: Record<string, unknown>, signal?: AbortSignal): Promise<LongRunningOperation>;
  getOperation(name: string, signal?: AbortSignal): Promise<LongRunningOperation>;
  fetchAvailableModels(projectId?: string, signal?: AbortSignal): Promise<AvailableModel[]>;
  retrieveUserQuota(projectId?: string, signal?: AbortSignal): Promise<QuotaBucket[]>;
}

export interface CodeAssistClientOptions {
  endpoint: string;
  profile: BackendProfile;
  getAccessToken: () => Promise<string> | string;
  config?: Pick<ConnectorConfig, "userAgentOverride">;
  fetchImpl?: typeof fetch;
}

export class CodeAssistClient implements CodeAssistTransport {
  readonly endpoint: string;
  readonly profile: BackendProfile;
  private readonly getAccessToken: () => Promise<string> | string;
  private readonly config?: Pick<ConnectorConfig, "userAgentOverride">;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodeAssistClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.profile = options.profile;
    this.getAccessToken = options.getAccessToken;
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private methodUrl(method: string, params?: Record<string, string>): string {
    const query = params ? `?${new URLSearchParams(params).toString()}` : "";
    return `${this.endpoint}/${CODE_ASSIST_API_VERSION}:${method}${query}`;
  }

  async post<T = unknown>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const accessToken = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(this.methodUrl(method), {
        method: "POST",
        headers: buildProfileHeaders(this.profile, accessToken, this.config),
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (cause) {
      throw new ConnectorError("code_assist_unreachable", `Could not reach ${this.endpoint} (network error).`, { cause });
    }
    return parseCodeAssistResponse<T>(response);
  }

  async getOperation(name: string, signal?: AbortSignal): Promise<LongRunningOperation> {
    const accessToken = await this.getAccessToken();
    const url = `${this.endpoint}/${CODE_ASSIST_API_VERSION}/${name.replace(/^\/+/, "")}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: buildProfileHeaders(this.profile, accessToken, this.config),
        signal,
      });
    } catch (cause) {
      throw new ConnectorError("code_assist_unreachable", `Could not reach ${this.endpoint} (network error).`, { cause });
    }
    return parseCodeAssistResponse<LongRunningOperation>(response);
  }

  async loadCodeAssist(projectId?: string, signal?: AbortSignal): Promise<LoadCodeAssistResponse> {
    try {
      return await this.post<LoadCodeAssistResponse>(
        "loadCodeAssist",
        {
          ...(projectId ? { cloudaicompanionProject: projectId } : {}),
          metadata: buildClientMetadata(this.profile, projectId),
        },
        signal,
      );
    } catch (error) {
      // VPC Service Controls can block the eligibility call itself for
      // enterprise projects. Like Gemini CLI, treat a SECURITY_POLICY_VIOLATED
      // verdict *with a configured project* as standard-tier eligibility on
      // that project. Generation still goes through the org's perimeter.
      if (
        projectId &&
        error instanceof CodeAssistError &&
        error.bodySnippet?.includes("SECURITY_POLICY_VIOLATED")
      ) {
        return {
          currentTier: { id: "standard-tier", name: "Gemini Code Assist Standard" },
          cloudaicompanionProject: projectId,
        };
      }
      throw error;
    }
  }

  onboardUser(request: Record<string, unknown>, signal?: AbortSignal): Promise<LongRunningOperation> {
    return this.post<LongRunningOperation>("onboardUser", request, signal);
  }

  async fetchAvailableModels(projectId?: string, signal?: AbortSignal): Promise<AvailableModel[]> {
    const payload = await this.post<unknown>(
      "fetchAvailableModels",
      projectId ? { project: projectId } : {},
      signal,
    );
    return parseAvailableModels(payload);
  }

  async retrieveUserQuota(projectId?: string, signal?: AbortSignal): Promise<QuotaBucket[]> {
    const payload = await this.post<unknown>(
      "retrieveUserQuota",
      projectId ? { project: projectId } : {},
      signal,
    );
    if (!isRecord(payload) || !Array.isArray(payload.buckets)) return [];
    return payload.buckets.filter(isRecord).map((bucket) => ({
      modelId: asString(bucket.modelId),
      tokenType: asString(bucket.tokenType),
      remainingFraction: typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : undefined,
      remainingAmount: asString(bucket.remainingAmount) ?? (typeof bucket.remainingAmount === "number" ? String(bucket.remainingAmount) : undefined),
      resetTime: asString(bucket.resetTime),
    }));
  }
}

async function parseCodeAssistResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let message = `Code Assist request failed (HTTP ${response.status}).`;
    let googleStatus: string | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed.error)) {
        message = asString(parsed.error.message) ?? message;
        googleStatus = asString(parsed.error.status);
      }
    } catch {
      // keep generic message; snippet below carries the raw detail
    }
    throw new CodeAssistError(response.status, message, {
      googleStatus,
      bodySnippet: redactSecrets(text.slice(0, 500)),
    });
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export function parseAvailableModels(payload: unknown): AvailableModel[] {
  if (!isRecord(payload)) return [];
  const raw = payload.models;
  const out: AvailableModel[] = [];

  const push = (id: string, value: Record<string, unknown>) => {
    const quota = isRecord(value.quotaInfo) ? value.quotaInfo : undefined;
    out.push({
      id,
      displayName: asString(value.displayName) ?? asString(value.name),
      remainingFraction: typeof quota?.remainingFraction === "number" ? (quota.remainingFraction as number) : undefined,
      resetTime: quota ? asString(quota.resetTime) : undefined,
      supportsImages: typeof value.supportsImages === "boolean" ? value.supportsImages : undefined,
      supportsVideo: typeof value.supportsVideo === "boolean" ? value.supportsVideo : undefined,
      maxOutputTokens: typeof value.maxOutputTokens === "number" ? value.maxOutputTokens : undefined,
    });
  };

  if (isRecord(raw)) {
    for (const [id, value] of Object.entries(raw)) {
      if (isRecord(value)) push(id, value);
    }
  } else if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isRecord(value)) continue;
      const id = asString(value.id) ?? asString(value.name)?.replace(/^models\//, "");
      if (id) push(id, value);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Eligibility resolution                                              */
/* ------------------------------------------------------------------ */

export type EligibilityStatus =
  | "eligible"
  | "ineligible"
  | "project-required"
  | "validation-required"
  | "unsupported-client";

export interface EligibilityResult {
  status: EligibilityStatus;
  endpoint: string;
  profile: BackendProfile;
  projectId?: string;
  /** Google-managed project created by free-tier onboarding, when applicable. */
  managedProjectId?: string;
  tierId?: string;
  tierName?: string;
  paidTierName?: string;
  /** Human label like "Google AI Pro" or "Code Assist Standard". Always server-derived when possible. */
  planLabel: string;
  /** True when eligibility exists but onboarding still has to run (probe-only mode). */
  needsOnboarding?: boolean;
  availableModelIds?: string[];
  reasons: string[];
  validationUrl?: string;
  privacyNotice?: string;
}

export interface ResolveOptions {
  configuredProjectId?: string;
  /** When false, never call onboardUser. Report `needsOnboarding` instead. */
  allowOnboard?: boolean;
  pollIntervalMs?: number;
  maxPollMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const KNOWN_TIER_LABELS: Record<string, string> = {
  "free-tier": "Gemini Code Assist (Individual, free)",
  "standard-tier": "Gemini Code Assist Standard",
  "enterprise-tier": "Gemini Code Assist Enterprise",
  "legacy-tier": "Gemini Code Assist (legacy)",
  "g1-pro-tier": "Google AI Pro",
  "g1-ultra-tier": "Google AI Ultra",
  "g1-advanced-tier": "Google AI (Advanced)",
};

export function planLabelFromTier(tierId?: string, ...names: Array<string | undefined>): string {
  for (const name of names) {
    if (name?.trim()) return name.trim();
  }
  if (tierId && KNOWN_TIER_LABELS[tierId]) return KNOWN_TIER_LABELS[tierId];
  if (!tierId) return "Unknown plan";
  if (/ultra/i.test(tierId)) return "Google AI Ultra";
  if (/pro/i.test(tierId)) return "Google AI Pro";
  if (/enterprise/i.test(tierId)) return "Gemini Code Assist Enterprise";
  if (/standard/i.test(tierId)) return "Gemini Code Assist Standard";
  if (/free/i.test(tierId)) return "Gemini Code Assist (Individual, free)";
  return tierId.replace(/-tier$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function collectReasons(load: LoadCodeAssistResponse): string[] {
  const reasons: string[] = [];
  for (const tier of load.ineligibleTiers ?? []) {
    const message = tier.reasonMessage ?? tier.validationErrorMessage ?? tier.reasonCode;
    if (message) reasons.push(tier.tierName ? `${tier.tierName}: ${message}` : message);
  }
  return reasons;
}

const MIGRATION_SIGNAL =
  /unsupported[_ ]?client|antigravity|migrat|no longer (?:supported|available|serving)|consumer (?:accounts?|tier).*(?:deprecat|stopped|removed)|ineligibletier/i;

export function hasMigrationSignal(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => t !== undefined && MIGRATION_SIGNAL.test(t));
}

function findValidation(load: LoadCodeAssistResponse): IneligibleTier | undefined {
  return (load.ineligibleTiers ?? []).find(
    (tier) => tier.validationUrl && tier.reasonCode === "VALIDATION_REQUIRED",
  );
}

/**
 * Resolve eligibility against a single endpoint.
 * Mirrors the decision tree Google's own setup flow uses:
 * currentTier → use it; otherwise onboard into the default allowed tier
 * (free tier omits the project so Google provisions a managed one).
 */
export async function resolveEligibilityOnEndpoint(
  transport: CodeAssistTransport,
  options: ResolveOptions = {},
): Promise<EligibilityResult> {
  const configuredProjectId = options.configuredProjectId?.trim() || undefined;
  if (configuredProjectId && /^\d+$/.test(configuredProjectId)) {
    throw new ConnectorError(
      "invalid_project_id",
      `"${configuredProjectId}" looks like a numeric Google Cloud project *number*, not a project *ID*.`,
      { hint: "Use the string project ID (e.g. \"my-project-123\") from the Google Cloud console." },
    );
  }

  const base: Pick<EligibilityResult, "endpoint" | "profile"> = {
    endpoint: transport.endpoint,
    profile: transport.profile,
  };

  const load = await transport.loadCodeAssist(configuredProjectId, options.signal);
  const reasons = collectReasons(load);
  const validation = findValidation(load);
  const privacyNotice = load.currentTier?.privacyNotice?.showNotice
    ? load.currentTier.privacyNotice.noticeText
    : load.paidTier?.privacyNotice?.showNotice
      ? load.paidTier.privacyNotice.noticeText
      : undefined;

  if (!load.currentTier && validation?.validationUrl) {
    return {
      ...base,
      status: "validation-required",
      planLabel: "Validation required",
      reasons,
      validationUrl: validation.validationUrl,
    };
  }

  if (load.currentTier) {
    const tierId = load.paidTier?.id ?? load.currentTier.id ?? "standard-tier";
    const planLabel = planLabelFromTier(tierId, load.paidTier?.name, load.currentTier.name);
    const projectId = asString(load.cloudaicompanionProject) ?? configuredProjectId;
    if (projectId) {
      return {
        ...base,
        status: "eligible",
        projectId,
        managedProjectId: asString(load.cloudaicompanionProject),
        tierId,
        tierName: load.currentTier.name,
        paidTierName: load.paidTier?.name,
        planLabel,
        reasons,
        privacyNotice,
      };
    }
    return {
      ...base,
      status: hasMigrationSignal(...reasons) ? "unsupported-client" : "project-required",
      tierId,
      tierName: load.currentTier.name,
      paidTierName: load.paidTier?.name,
      planLabel,
      reasons:
        reasons.length > 0
          ? reasons
          : ["This tier requires you to supply your own Google Cloud project ID."],
    };
  }

  const onboardTier =
    (load.allowedTiers ?? []).find((tier) => tier.isDefault) ?? (load.allowedTiers ?? [])[0];
  if (!onboardTier?.id) {
    return {
      ...base,
      status: hasMigrationSignal(...reasons) ? "unsupported-client" : reasons.length > 0 ? "ineligible" : "project-required",
      planLabel: "No eligible plan",
      reasons: reasons.length > 0 ? reasons : ["Google returned no eligible tier and no project for this account."],
    };
  }

  const tierId = onboardTier.id;
  const planLabel = planLabelFromTier(tierId, onboardTier.name);
  if (options.allowOnboard === false) {
    return {
      ...base,
      status: "eligible",
      needsOnboarding: true,
      projectId: configuredProjectId,
      tierId,
      tierName: onboardTier.name,
      planLabel,
      reasons,
    };
  }

  // Free tier uses a Google-managed project; sending one triggers FAILED_PRECONDITION.
  const isFreeTier = tierId === "free-tier";
  const request: Record<string, unknown> = {
    tierId,
    metadata: buildClientMetadata(transport.profile, isFreeTier ? undefined : configuredProjectId),
  };
  if (!isFreeTier && configuredProjectId) request.cloudaicompanionProject = configuredProjectId;

  let operation = await transport.onboardUser(request, options.signal);
  const sleepFn = options.sleepFn ?? sleep;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const deadline = Date.now() + (options.maxPollMs ?? 120_000);
  while (!operation.done && operation.name && Date.now() < deadline) {
    await sleepFn(pollIntervalMs);
    operation = await transport.getOperation(operation.name, options.signal);
  }
  if (!operation.done) {
    throw new ConnectorError("onboarding_timeout", "Google account onboarding did not finish in time. Try signing in again.");
  }
  if (operation.error?.message) {
    throw new ConnectorError("onboarding_failed", `Google account onboarding failed: ${operation.error.message}`);
  }

  const onboardedProject = asString(operation.response?.cloudaicompanionProject?.id);
  const projectId = onboardedProject ?? configuredProjectId;
  if (!projectId) {
    return {
      ...base,
      status: reasons.length > 0 ? "ineligible" : "project-required",
      tierId,
      tierName: onboardTier.name,
      planLabel,
      reasons: reasons.length > 0 ? reasons : ["Onboarding completed without a project. A Google Cloud project ID is required for this account."],
    };
  }
  return {
    ...base,
    status: "eligible",
    projectId,
    managedProjectId: onboardedProject,
    tierId,
    tierName: onboardTier.name,
    planLabel,
    reasons,
  };
}

export interface ResolveAccountAccessOptions extends ResolveOptions {
  accessToken: string;
  config: ConnectorConfig;
  mode?: ProfileMode;
  fetchImpl?: typeof fetch;
  /** Factory override for tests. */
  clientFactory?: (endpoint: string, profile: BackendProfile) => CodeAssistTransport;
}

const STATUS_PRIORITY: Record<EligibilityStatus, number> = {
  eligible: 0,
  "validation-required": 1,
  "project-required": 2,
  "unsupported-client": 3,
  ineligible: 4,
};

/**
 * Probe candidate endpoints (load-only), then complete onboarding on the first
 * endpoint that accepts the account, and best-effort discover available models.
 */
export async function resolveAccountAccess(
  options: ResolveAccountAccessOptions,
): Promise<EligibilityResult> {
  const mode = options.mode ?? options.config.profileMode;
  const candidates = endpointCandidates(mode, options.config);
  const makeClient =
    options.clientFactory ??
    ((endpoint: string, profile: BackendProfile) =>
      new CodeAssistClient({
        endpoint,
        profile,
        getAccessToken: () => options.accessToken,
        config: options.config,
        fetchImpl: options.fetchImpl,
      }));

  const attempts: EligibilityResult[] = [];
  for (const candidate of candidates) {
    const client = makeClient(candidate.endpoint, candidate.profile);
    let probe: EligibilityResult;
    try {
      probe = await resolveEligibilityOnEndpoint(client, { ...options, allowOnboard: false });
    } catch (error) {
      if (error instanceof CodeAssistError && error.status === 401) throw error;
      attempts.push({
        status: "ineligible",
        endpoint: candidate.endpoint,
        profile: candidate.profile,
        planLabel: "Endpoint probe failed",
        reasons: [`${candidate.endpoint}: ${error instanceof Error ? error.message : String(error)}`],
      });
      continue;
    }
    attempts.push(probe);
    if (probe.status !== "eligible") continue;

    const resolved =
      probe.needsOnboarding && options.allowOnboard !== false
        ? await resolveEligibilityOnEndpoint(client, { ...options, allowOnboard: true })
        : probe;
    if (resolved.status !== "eligible") {
      attempts.push(resolved);
      continue;
    }

    try {
      const models = await client.fetchAvailableModels(resolved.projectId, options.signal);
      if (models.length > 0) resolved.availableModelIds = models.map((m) => m.id);
    } catch {
      // Model discovery is best-effort; the static catalog is the fallback.
    }
    return resolved;
  }

  const best = [...attempts].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])[0];
  if (!best) {
    throw new ConnectorError("no_endpoints", "No Google endpoints were available to check eligibility.");
  }
  // Attach the other attempts' reasons so users can see every verdict, not just one.
  const extraReasons = attempts
    .filter((attempt) => attempt !== best)
    .flatMap((attempt) => attempt.reasons.map((r) => `[${attempt.profile}] ${r}`));
  return { ...best, reasons: [...best.reasons, ...extraReasons] };
}
