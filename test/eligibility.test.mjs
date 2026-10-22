import assert from "node:assert/strict";
import test from "node:test";

import {
  CodeAssistClient,
  parseAvailableModels,
  planLabelFromTier,
  resolveAccountAccess,
  resolveConnectorConfig,
  resolveEligibilityOnEndpoint,
} from "../dist/index.js";

function transport(overrides) {
  return {
    endpoint: "https://cloudcode-pa.googleapis.com",
    profile: "code-assist",
    loadCodeAssist: async () => ({}),
    onboardUser: async () => ({ done: true }),
    getOperation: async () => ({ done: true }),
    fetchAvailableModels: async () => [],
    retrieveUserQuota: async () => [],
    ...overrides,
  };
}

test("currentTier + paidTier resolves eligible with a server-derived plan label", async () => {
  const result = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({
        currentTier: { id: "free-tier", name: "Code Assist" },
        paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
        cloudaicompanionProject: "managed-proj",
      }),
    }),
  );
  assert.equal(result.status, "eligible");
  assert.equal(result.planLabel, "Google AI Pro");
  assert.equal(result.projectId, "managed-proj");
  assert.equal(result.tierId, "g1-pro-tier");
});

test("free-tier onboarding omits the project and polls the LRO", async () => {
  let onboardRequest;
  let polls = 0;
  const result = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({
        allowedTiers: [{ id: "free-tier", name: "Free", isDefault: true }],
      }),
      onboardUser: async (req) => {
        onboardRequest = req;
        return { done: false, name: "operations/abc" };
      },
      getOperation: async () => {
        polls++;
        return polls < 2
          ? { done: false, name: "operations/abc" }
          : { done: true, response: { cloudaicompanionProject: { id: "managed-123" } } };
      },
    }),
    { configuredProjectId: "should-be-ignored-for-free", sleepFn: async () => {}, pollIntervalMs: 1 },
  );
  assert.equal("cloudaicompanionProject" in onboardRequest, false);
  assert.equal(result.status, "eligible");
  assert.equal(result.projectId, "managed-123");
  assert.equal(result.managedProjectId, "managed-123");
});

test("probe-only mode reports needsOnboarding instead of onboarding", async () => {
  let onboarded = false;
  const result = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({ allowedTiers: [{ id: "standard-tier", isDefault: true }] }),
      onboardUser: async () => {
        onboarded = true;
        return { done: true };
      },
    }),
    { allowOnboard: false },
  );
  assert.equal(onboarded, false);
  assert.equal(result.status, "eligible");
  assert.equal(result.needsOnboarding, true);
});

test("VALIDATION_REQUIRED surfaces the validation URL", async () => {
  const result = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({
        ineligibleTiers: [
          { reasonCode: "VALIDATION_REQUIRED", reasonMessage: "Verify your account", validationUrl: "https://example.com/verify" },
        ],
      }),
    }),
  );
  assert.equal(result.status, "validation-required");
  assert.equal(result.validationUrl, "https://example.com/verify");
});

test("migration language maps to unsupported-client; bare ineligibility stays ineligible", async () => {
  const migrated = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({
        ineligibleTiers: [{ reasonMessage: "Consumer accounts migrated to Antigravity" }],
      }),
    }),
  );
  assert.equal(migrated.status, "unsupported-client");

  const plain = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({
        ineligibleTiers: [{ reasonCode: "UNSUPPORTED_LOCATION", reasonMessage: "Not available in your region" }],
      }),
    }),
  );
  assert.equal(plain.status, "ineligible");
});

test("tier without a project asks for one; numeric project numbers are rejected early", async () => {
  const needsProject = await resolveEligibilityOnEndpoint(
    transport({
      loadCodeAssist: async () => ({ currentTier: { id: "standard-tier", name: "Standard" } }),
    }),
  );
  assert.equal(needsProject.status, "project-required");

  await assert.rejects(
    resolveEligibilityOnEndpoint(transport({}), { configuredProjectId: "123456789" }),
    /project \*number\*/,
  );
});

test("multi-endpoint resolution falls through to the first eligible backend and discovers models", async () => {
  const config = resolveConnectorConfig({ experimentalAntigravity: true }, {});
  const result = await resolveAccountAccess({
    accessToken: "token",
    config,
    mode: "auto",
    clientFactory: (endpoint, profile) =>
      transport({
        endpoint,
        profile,
        loadCodeAssist: async () =>
          profile === "antigravity"
            ? { currentTier: { id: "free-tier" }, cloudaicompanionProject: "ag-proj" }
            : { ineligibleTiers: [{ reasonMessage: "Consumer accounts migrated to Antigravity" }] },
        fetchAvailableModels: async () => [{ id: "gemini-3.5-flash" }, { id: "gemini-2.5-pro" }],
      }),
  });
  assert.equal(result.status, "eligible");
  assert.equal(result.profile, "antigravity");
  assert.deepEqual(result.availableModelIds, ["gemini-3.5-flash", "gemini-2.5-pro"]);
});

test("VPC-SC blocked loadCodeAssist falls back to standard tier on the configured project", async () => {
  const client = new CodeAssistClient({
    endpoint: "https://cloudcode-pa.googleapis.com",
    profile: "code-assist",
    getAccessToken: () => "token",
    fetchImpl: async () =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Request is disallowed by organization's constraints",
            status: "PERMISSION_DENIED",
            details: [{ reason: "SECURITY_POLICY_VIOLATED" }],
          },
        },
        { status: 403 },
      ),
  });
  const withProject = await client.loadCodeAssist("corp-project");
  assert.equal(withProject.currentTier.id, "standard-tier");
  assert.equal(withProject.cloudaicompanionProject, "corp-project");
  await assert.rejects(client.loadCodeAssist(), /disallowed/);
});

test("available-model parsing handles record and array payloads", () => {
  const fromRecord = parseAvailableModels({
    models: {
      "gemini-2.5-pro": { displayName: "Pro", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-01-01T00:00:00Z" } },
    },
  });
  assert.equal(fromRecord[0].remainingFraction, 0.5);
  const fromArray = parseAvailableModels({ models: [{ name: "models/gemini-2.5-flash" }] });
  assert.equal(fromArray[0].id, "gemini-2.5-flash");
  assert.equal(planLabelFromTier("g1-ultra-tier"), "Google AI Ultra");
  assert.equal(planLabelFromTier(undefined, "Server Name"), "Server Name");
});
