import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { bindingAllowsCapability, resolveRuntimeCapabilities } from "../../src/agent-runtime/runtime/capabilities.js";
import { requiredHeartbeatRoles, checkRuntimeReadiness,
  verifierReportsMatch } from "../../src/agent-runtime/runtime/readiness.js";
import { AgentRuntimeComposition, supportedWorkflowIds,
  validateCapabilityDependencies } from "../../src/agent-runtime/runtime/composition.js";
import { providerReviewWorkflow } from "../../src/review/intake/provider-intake.js";
import { resolveFrozenModelExecutionPolicy,
  resolveWorkerCompatibility } from "../../src/agent-runtime/runtime/worker-compatibility.js";

const workerCompatibility = { runtimeVersionHash: "a".repeat(64),
  supportedWorkflowIds: ["review.single.v1", "review.deep.v1"] };

test("capabilities default to Single plus explicit Deep while Fix and Evolution stay off", () => {
  const capabilities = resolveRuntimeCapabilities({});
  assert.deepEqual(capabilities, { reviewSingle: true, reviewDeep: true, fix: false, evolution: false });
  assert.deepEqual(supportedWorkflowIds(capabilities), ["review.single.v1", "review.deep.v1"]);
  assert.deepEqual(requiredHeartbeatRoles("web", capabilities), ["worker", "recovery"]);
  assert.throws(() => resolveRuntimeCapabilities({ FEATURE_FIX: "true" }), /exactly on or off/u);
  assert.throws(() => resolveRuntimeCapabilities({ FEATURE_FIX: "on" }), /FIX_DEFAULT_POLICY_ID/u);
  assert.throws(() => validateCapabilityDependencies({ FEATURE_FIX: "on", FIX_DEFAULT_POLICY_ID: "missing" }),
    /FIX_POLICY_REGISTRY_JSON/u);
  assert.throws(() => validateCapabilityDependencies({ FEATURE_FIX: "on", FIX_DEFAULT_POLICY_ID: "missing",
    FIX_POLICY_REGISTRY_JSON: "not-json" }), /JSON/u);
  assert.throws(() => validateCapabilityDependencies({ FEATURE_FIX: "on", FIX_DEFAULT_POLICY_ID: "missing",
    FIX_POLICY_REGISTRY_JSON: "{}" }), /FIX_DEFAULT_POLICY_ID/u);
});

test("trusted binding defaults select Single and can explicitly select Deep", () => {
  const binding = fixtureBinding();
  assert.equal(bindingAllowsCapability(binding, "review.deep", resolveRuntimeCapabilities({})), true);
  assert.equal(providerReviewWorkflow(binding), "review.single.v1");
  binding.capabilities.defaultReviewWorkflow = "review.deep.v1";
  assert.equal(providerReviewWorkflow(binding), "review.deep.v1");
  binding.capabilities.reviewDeep = false;
  assert.equal(providerReviewWorkflow(binding), "review.single.v1");
});

test("readiness is redacted for PostgreSQL failure and ignores disabled verifier", async () => {
  const down = { query: async () => { throw new Error("secret database URL"); } } as unknown as Pool;
  const warnings: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message?: unknown) => { warnings.push(String(message)); };
  let unavailable;
  try {
    unavailable = await checkRuntimeReadiness({ pool: down, role: "web", env: {}, workerCompatibility });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(unavailable.ok, false);
  assert.deepEqual(unavailable.checks, { postgres: false, runtimeRole: false, schema: false,
    heartbeats: { worker: false, recovery: false } });
  assert.doesNotMatch(JSON.stringify(unavailable), /secret database URL/u);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"event":"runtime_readiness.failed"/u);
  assert.match(warnings[0]!, /"domainCode":"READINESS_CHECK_FAILED"/u);
  assert.doesNotMatch(warnings[0]!, /secret database URL/u);

  const healthy = fakeReadinessPool({ worker: true, recovery: true, verifier: false });
  const ready = await checkRuntimeReadiness({ pool: healthy, role: "web", env: {}, workerCompatibility });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.checks.heartbeats, { worker: true, recovery: true });
});

test("an unmigrated PostgreSQL database is reachable but not schema-ready", async () => {
  const empty = ({ query: async () => ({
    rows: [{ safe_role: true, migration_ledger_ready: false }],
  }) }) as unknown as Pool;
  const status = await checkRuntimeReadiness({ pool: empty, role: "web", env: {}, workerCompatibility });
  assert.equal(status.ok, false);
  assert.equal(status.checks.postgres, true);
  assert.equal(status.checks.runtimeRole, true);
  assert.equal(status.checks.schema, false);
});

test("complete App mode requires its restrictive onboarding role only on the web process", async () => {
  let probes = 0;
  const options = { pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }),
    env: { APP_ID: "123", PRIVATE_KEY: "private-key", WEBHOOK_SECRET: "webhook-secret" }, workerCompatibility,
    checkOnboarding: async () => { probes += 1; return false; } };
  const web = await checkRuntimeReadiness({ ...options, role: "web" });
  assert.equal(web.ok, false);
  assert.equal(web.checks.githubOnboarding, false);
  const emergencyOff = await checkRuntimeReadiness({ ...options, role: "web",
    env: { ...options.env, FEATURE_GITHUB_ONBOARDING: "off" } });
  assert.equal(emergencyOff.ok, false);
  assert.equal(emergencyOff.checks.githubOnboarding, false);
  const worker = await checkRuntimeReadiness({ ...options, role: "worker" });
  assert.equal(worker.ok, true);
  assert.equal(worker.checks.githubOnboarding, undefined);
  assert.equal(probes, 2);
});

test("provider discovery failure degrades onboarding diagnostics without failing local readiness", async () => {
  const status = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }),
    role: "web",
    env: { APP_ID: "123", PRIVATE_KEY: "private-key", WEBHOOK_SECRET: "webhook-secret" },
    workerCompatibility,
    checkOnboarding: async () => true,
    onboardingStatus: () => ({ running: true, lastErrorCode: "github_api_temporary" }),
    onboardingMetrics: async () => ({ pendingSyncCount: 2, oldestSyncAgeSeconds: 400,
      pendingDeferredCount: 3, oldestDeferredAgeSeconds: 350, syncConflictCount: 1, deferredConflictCount: 0 }),
  });
  assert.equal(status.ok, true);
  assert.equal(status.checks.githubOnboarding, true);
  assert.equal(status.checks.githubOnboardingLoop, true);
  assert.equal(status.checks.githubOnboardingDegraded, true);
  assert.equal(status.checks.githubOnboardingLastErrorCode, "github_api_temporary");
  assert.equal(status.checks.githubOnboardingQueue?.pendingDeferredCount, 3);
  assert.equal(status.checks.githubOnboardingDiscoveryCompleted, false);
});

test("stale required process heartbeat makes readiness fail", async () => {
  const status = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: false, verifier: true }),
    role: "web",
    env: {},
    workerCompatibility,
  });
  assert.equal(status.ok, false);
  assert.deepEqual(status.checks.heartbeats, { worker: true, recovery: false });
});

test("web readiness rejects a worker that cannot execute an enabled capability", async () => {
  const status = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }),
    role: "web",
    env: { FEATURE_EVOLUTION: "on" },
    workerCompatibility: { ...workerCompatibility,
      supportedWorkflowIds: [...workerCompatibility.supportedWorkflowIds, "evolution.propose.v1", "eval.replay.v1"] },
  });
  assert.equal(status.ok, false);
  assert.deepEqual(status.checks.heartbeats, { worker: false, recovery: true });
});

test("readiness ignores fresh workers with the wrong runtime hash or workflow set", async () => {
  const wrongHash = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }, {
      runtimeVersionHash: "b".repeat(64), supportedWorkflowIds: workerCompatibility.supportedWorkflowIds,
    }),
    role: "web", env: {}, workerCompatibility,
  });
  assert.equal(wrongHash.ok, false);
  const missingWorkflow = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }, {
      runtimeVersionHash: workerCompatibility.runtimeVersionHash,
      supportedWorkflowIds: ["review.single.v1"],
    }),
    role: "web", env: {}, workerCompatibility,
  });
  assert.equal(missingWorkflow.ok, false);
  const extraWorkflow = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }, {
      runtimeVersionHash: workerCompatibility.runtimeVersionHash,
      supportedWorkflowIds: [...workerCompatibility.supportedWorkflowIds, "fix.propose.v1"],
    }),
    role: "web", env: {}, workerCompatibility,
  });
  assert.equal(extraWorkflow.ok, false);
  const extraCapability = await checkRuntimeReadiness({
    pool: fakeReadinessPool({ worker: true, recovery: true, verifier: false }, {
      runtimeVersionHash: workerCompatibility.runtimeVersionHash,
      supportedWorkflowIds: workerCompatibility.supportedWorkflowIds,
      capabilities: { reviewSingle: true, reviewDeep: true, fix: true, evolution: false },
    }),
    role: "web", env: {}, workerCompatibility,
  });
  assert.equal(extraCapability.ok, false);
});

test("recovery readiness never depends on the Fix verifier", () => {
  assert.deepEqual(requiredHeartbeatRoles("recovery", { reviewSingle: true, reviewDeep: true,
    fix: true, evolution: false }), ["recovery"]);
});

test("worker compatibility fails closed on invalid local provider configuration", async () => {
  await assert.rejects(resolveWorkerCompatibility(resolveRuntimeCapabilities({}), {
    AI_PROVIDER: "openai-compatible", AI_MODEL: "fixture", OPENAI_COMPATIBLE_API_KEY: "key",
    HARNESS_MODEL_PRICING_JSON: "{}",
  }), /OPENAI_BASE_URL/u);
});

test("web model contract rejects malformed pricing and a missing selected model", () => {
  assert.throws(() => resolveFrozenModelExecutionPolicy({ AI_PROVIDER: "openai", AI_MODEL: "fixture",
    HARNESS_MODEL_PRICING_JSON: "not-json" }), /JSON/u);
  assert.throws(() => resolveFrozenModelExecutionPolicy({ AI_PROVIDER: "openai", AI_MODEL: "fixture",
    HARNESS_MODEL_PRICING_JSON: JSON.stringify({ version: "v1", currency: "USD", models: {},
      tenantLimits: {}, runLimits: {} }) }), /model pricing entry/u);
});

test("web-only startup validates durable heartbeat configuration", async () => {
  const previous = process.env.RUNTIME_HEARTBEAT_INTERVAL_MS;
  process.env.RUNTIME_HEARTBEAT_INTERVAL_MS = "invalid";
  try {
    await assert.rejects(new AgentRuntimeComposition().start("web"), /must be an integer/u);
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_HEARTBEAT_INTERVAL_MS;
    else process.env.RUNTIME_HEARTBEAT_INTERVAL_MS = previous;
  }
});

test("any compatible verifier heartbeat satisfies a mixed fleet", () => {
  const expected = { verifierCapabilityHash: "a".repeat(64), policyId: "default",
    policyHash: "b".repeat(64), nodeImageDigest: `sha256:${"c".repeat(64)}` };
  assert.equal(verifierReportsMatch([
    { verifierCapabilityHash: "d".repeat(64), policies: [] },
    { verifierCapabilityHash: expected.verifierCapabilityHash,
      policies: [{ id: expected.policyId, hash: expected.policyHash,
        nodeImageDigest: expected.nodeImageDigest }] },
  ], expected), true);
  assert.equal(verifierReportsMatch([
    { verifierCapabilityHash: expected.verifierCapabilityHash,
      policies: [{ id: expected.policyId, hash: "e".repeat(64),
        nodeImageDigest: expected.nodeImageDigest }] },
  ], expected), false);
});

function fakeReadinessPool(
  freshness: Record<"worker" | "recovery" | "verifier", boolean>,
  worker: typeof workerCompatibility & { capabilities?: ReturnType<typeof resolveRuntimeCapabilities> }
    = workerCompatibility,
): Pool {
  return { query: async (sql: string) => {
    if (sql.includes("migration_ledger_ready")) {
      return { rows: [{ safe_role: true, migration_ledger_ready: true }] };
    }
    if (sql.includes("migration_name='032_github_installation_sync.sql'")) return { rows: [{ schema_ready: true }] };
    return { rows: (Object.entries(freshness) as Array<[keyof typeof freshness, boolean]>).map(
      ([process_role, fresh]) => ({ process_role, fresh,
        capability_reports: process_role === "worker" && fresh
          ? [{ schemaVersion: 2, capabilities: worker.capabilities ?? resolveRuntimeCapabilities({}),
            runtimeVersionHash: worker.runtimeVersionHash,
            supportedWorkflowIds: worker.supportedWorkflowIds }] : [] })) };
  } } as unknown as Pool;
}

function fixtureBinding(): PublicationBinding {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: "11111111-1111-4111-8111-111111111111",
    platform: "github",
    origin: "https://api.github.com",
    repository: "acme/widgets",
    providerRepositoryId: 1,
    providerActorId: 2,
    credentialRef: "env:GITHUB_TOKEN",
    generation: 1,
    version: 1,
    state: "active",
    reviewExecutionMode: "harness_async",
    capabilities: { reviewSingle: true, reviewDeep: true, fix: false, evolution: false,
      defaultReviewWorkflow: "review.single.v1" },
  };
}
