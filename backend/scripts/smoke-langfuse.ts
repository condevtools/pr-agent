/** Synthetic-only runtime acceptance fixture; never a model-quality or cost benchmark. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import type { ModelBudgetStore, ModelExecutionPolicy } from "../src/agent-runtime/budget/model-budget-store.js";
import { observeCheckpoint } from "../src/agent-runtime/execution/checkpoint-observability.js";
import { currentRunExecutionContext } from "../src/agent-runtime/execution/run-context.js";
import { RunWorker } from "../src/agent-runtime/execution/run-worker.js";
import type { RunExecutionStore } from "../src/agent-runtime/execution/store.js";
import type { RunCheckpoint, RunLease, RunStepKind } from "../src/agent-runtime/runs/contracts.js";
import { executeModelRequest, modelRequestHash } from "../src/model/execution-context.js";
import { createAgentObservability, observeAgentOperation, withAgentObservability } from "../src/observability/index.js";
import { runDeepReviewCritic } from "../src/review/deep/critic.js";
import type { DeepReviewSource, DeepWorkflowContext, RoleLimits } from "../src/review/deep/contracts.js";
import { runDeepReviewRole } from "../src/review/deep/roles/role-loop.js";
import { verifyLangfuseTrace } from "./langfuse-readback.js";
const runId = randomUUID();
const CHECKPOINT_STATE_MARKER = "synthetic-checkpoint-state-must-not-export";
const cachedStepId = randomUUID();
const cachedStepAttemptId = randomUUID();
const cachedOutputHash = "b".repeat(64);
const cachedArtifactHash = "c".repeat(64);
let checkpointSequence = 1;
let traceId: string | undefined;
let physicalCalls = 0;
let outcome = "not_started";
async function main(): Promise<void> {
  const environment = { ...process.env, LANGFUSE_TRACING_ENVIRONMENT: "integration-smoke",
    LANGFUSE_CAPTURE_CONTENT: process.env.LANGFUSE_CAPTURE_CONTENT?.trim() || "redacted",
  };
  const serverVersion = await assertLangfuseHealthy(environment);
  const observability = createAgentObservability({ env: environment });
  if (!observability.enabled) throw new Error("LangfuseObservabilityDisabled");
  const lease = fixtureLease(runId);
  const store = fixtureStore(lease, (next) => { outcome = next; });
  const budget = fixtureBudget(lease);
  const worker = new RunWorker({
    store, budget,
    bindings: async () => [fixtureBinding(lease)],
    runtimeHash: async () => lease.runtimeVersionHash,
    execute: async () => executeSyntheticDeepReview(), onError: () => undefined,
  });
  try {
    await withAgentObservability(observability, async () => {
      await worker.tick(); await worker.drain();
    });
  } finally {
    await worker.stop();
    await observability.shutdown();
  }
  if (!traceId || physicalCalls !== 3 || outcome !== "succeeded")
    throw new Error("LangfuseSyntheticRunIncomplete");
  const verification = await verifyLangfuseTrace({
    baseUrl: environment.LANGFUSE_BASE_URL!, publicKey: environment.LANGFUSE_PUBLIC_KEY!,
    secretKey: environment.LANGFUSE_SECRET_KEY!, traceId, serverVersion,
  });
  process.stdout.write(`${JSON.stringify({ runId, traceId, outcome, physicalCalls, ...verification })}\n`);
}
async function executeSyntheticDeepReview(): Promise<void> {
  const runtime = currentRunExecutionContext();
  if (!runtime) throw new Error("RunExecutionContextMissing");
  await observeAgentOperation("capture-smoke-trace", "span", {
    metadata: { fixture: "langfuse-integration-smoke" },
  }, async (observation) => { traceId = observation.traceId; });
  await runtime.step("smoke.cached", "coordination", "cached-input", async () => {
    throw new Error("CachedStepActionExecuted");
  });
  await runtime.step("smoke.synthetic-tool", "tool", "tool-input", async () => ({
    source: "synthetic", result: "available",
  }));
  const source = fixtureSource(runtime.lease);
  const context = fixtureDeepContext(runtime);
  const limits = fixtureRoleLimits();
  const [security, correctness] = await Promise.all([
    runDeepReviewRole({ role: "security", source, context, limits }),
    runDeepReviewRole({ role: "correctness", source, context, limits }),
  ]);
  await runDeepReviewCritic({
    candidates: [...security.candidates, ...correctness.candidates],
    coverage: [security.coverage, correctness.coverage], context,
    policy: {
      roleLimits: { security: limits, correctness: limits },
      criticInputCandidateLimit: 10,
      criticLimits: { maxWallTimeMs: 5_000, maxInputBytes: 64_000, maxOutputTokens: 256 },
    },
  });
  const publicationBatchId = randomUUID();
  await observeCheckpoint("save", { ...runtime.lease, checkpointKind: "publication_frozen",
    publicationBatchId }, async (record) => {
    record(fixtureCheckpoint({ kind: "publication_frozen", publicationBatchId,
      state: { stage: "publication_frozen", publicationBatchId,
        operationSetHash: "e".repeat(64), fixtureMarker: CHECKPOINT_STATE_MARKER } }), "saved");
  });
}
function fixtureDeepContext(runtime: NonNullable<ReturnType<typeof currentRunExecutionContext>>): DeepWorkflowContext {
  return {
    lease: runtime.lease,
    step: runtime.step,
    model: {
      generate: async (request) => executeModelRequest(
        {
          provider: "openai-compatible",
          model: "langfuse-smoke-model",
          requestKind: "synthetic-structured",
          requestHash: modelRequestHash({ role: request.role, turn: request.turn }),
          inputTokenUpperBound: 24,
          maxOutputTokens: request.maxOutputTokens ?? 256,
          metadata: { role: request.role, turn: request.turn, schemaName: request.schemaName },
        },
        async () => {
          physicalCalls += 1;
          const value = request.role === "critic" ? { decisions: [] } : { action: "finish", request: null, candidates: [] };
          return {
            value,
            rawResponse: { fixture: true },
            observationOutput: value,
            providerRequestId: `synthetic-${physicalCalls}`,
            modelVersion: "langfuse-smoke-model-v1",
            httpStatus: 200,
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, original: {} },
          };
        },
        { input: [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.prompt }],
          parameters: { max_tokens: request.maxOutputTokens ?? 256, response_format: {
            type: "json_schema", json_schema: request.jsonSchema,
          } } },
      ).then((value) => request.schema.parse(value)),
    },
    tools: { catalog: () => [], invoke: async () => { throw new Error("SyntheticToolUnexpected"); } },
    store: {
      loadArtifact: async () => undefined,
      registerEvidence: async () => undefined,
      registerCandidates: async () => undefined,
      registerDecisions: async () => undefined,
      loadUsableEvidence: async () => new Map(),
      saveArtifact: async () => undefined,
    },
    signal: runtime.signal,
  };
}
function fixtureStore(lease: RunLease, setOutcome: (value: string) => void): RunExecutionStore {
  let claimed = false;
  const cachedCheckpoint = fixtureCheckpoint({ sequence: 1, kind: "step_completed",
    stepId: cachedStepId, stepAttemptId: cachedStepAttemptId,
    state: { stage: "smoke.cached", stepId: cachedStepId,
      outputHash: cachedOutputHash, fixtureMarker: CHECKPOINT_STATE_MARKER } });
  return {
    claimPublicationOutcome: async () => undefined,
    claimManualResume: async () => undefined,
    claim: async () => claimed ? undefined : (claimed = true, lease),
    latestCheckpoint: async () => observeCheckpoint("validate", lease, async (record) => {
      record(cachedCheckpoint, "validated");
      return cachedCheckpoint;
    }),
    withLease: async (_lease, action) => action({ query: async () =>
      ({ rows: [{ allowed: true }], rowCount: 1 }) } as unknown as PoolClient),
    heartbeat: async () => lease,
    beginStep: async (_lease, input) => ({
      id: input.stepKey === "smoke.cached" ? cachedStepId : randomUUID(),
      runId, stepKey: input.stepKey, kind: input.kind as RunStepKind,
      inputHash: input.inputHash, status: input.stepKey === "smoke.cached" ? "succeeded" : "running",
      attemptId: input.stepKey === "smoke.cached" ? cachedStepAttemptId : randomUUID(),
      attemptNumber: 1, reused: input.stepKey === "smoke.cached",
      ...(input.stepKey === "smoke.cached"
        ? { outputHash: cachedOutputHash, resultRef: cachedArtifactHash } : {}),
    }),
    loadStepOutput: async (_lease, step) => observeCheckpoint("reuse", {
      ...lease, checkpointKind: "step_completed", stepId: step.id,
      stepAttemptId: step.attemptId, outputHash: step.outputHash, artifactHash: step.resultRef,
    }, async (record) => {
      record(cachedCheckpoint, "reused");
      return { fixture: "cached" };
    }),
    completeStep: async (_lease, input) => observeCheckpoint("save", {
      ...lease, checkpointKind: "step_completed", stepId: input.stepId,
      stepAttemptId: input.attemptId, outputHash: input.outputHash,
      artifactHash: input.preparedArtifact?.artifactHash ?? input.resultRef,
    }, async (record) => {
      const checkpoint = fixtureCheckpoint({ kind: "step_completed", stepId: input.stepId,
        stepAttemptId: input.attemptId, state: { ...input.checkpoint.state,
          fixtureMarker: CHECKPOINT_STATE_MARKER } });
      record(checkpoint, "saved");
      return checkpoint;
    }),
    failStep: async () => undefined,
    transition: async (_lease, input) => { setOutcome(input.to); },
    relinquishSettledLease: async () => undefined,
  } as unknown as RunExecutionStore;
}
function fixtureCheckpoint(input: {
  sequence?: number;
  kind: RunCheckpoint["kind"];
  stepId?: string;
  stepAttemptId?: string;
  publicationBatchId?: string;
  state: Record<string, unknown>;
}): RunCheckpoint {
  const sequence = input.sequence ?? ++checkpointSequence;
  return {
    id: randomUUID(), runId, sequence, kind: input.kind,
    publicationBatchId: input.publicationBatchId,
    stepId: input.stepId, stepAttemptId: input.stepAttemptId,
    schemaVersion: 1, runtimeVersionHash: "a".repeat(64),
    stateHash: sequence.toString(16).padStart(64, "0"), state: input.state,
    createdAt: new Date().toISOString(),
  };
}
function fixtureBudget(lease: RunLease): ModelBudgetStore {
  return {
    prepare: async (input: { stepId: string; stepAttemptId: string; physicalOrdinal: number;
      intent: { requestHash: string } }) => ({
      id: randomUUID(), tenantId: lease.tenantId, runId, stepId: input.stepId,
      stepAttemptId: input.stepAttemptId, physicalOrdinal: input.physicalOrdinal,
      requestHash: input.intent.requestHash, status: "prepared", reservationStatus: "reserved",
    }),
    markDispatched: async () => undefined,
    settleKnown: async () => undefined,
    settleProviderFailure: async () => undefined,
    settleUnknown: async () => undefined,
    closeRunBudgetInTransaction: async () => "closed",
  } as unknown as ModelBudgetStore;
}
function fixtureLease(id: string): RunLease {
  return {
    tenantId: randomUUID(), runId: id, integrationId: randomUUID(), jobId: randomUUID(),
    jobKind: "start", owner: "langfuse-smoke", epoch: 1, jobAttempt: 1,
    authorityGeneration: 1, executionModeGeneration: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), baseSha: "synthetic-base",
    headSha: "synthetic-head", workflowVersionHash: "synthetic-workflow",
    promptVersionHash: "synthetic-prompt", modelVersionHash: "synthetic-model",
    toolVersionHash: "synthetic-tool", policyVersionHash: "synthetic-policy",
    runtimeVersionHash: "synthetic-runtime", input: { workflow: "review.deep.v1" }, limits: {},
    runtimeConfig: { maxJobAttempts: 1, maxCheckpointBytes: 4 * 1024 * 1024,
      modelPolicy: fixturePolicy() },
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
function fixtureBinding(lease: RunLease): PublicationBinding {
  return { id: lease.integrationId, tenantId: lease.tenantId, platform: "github",
    origin: "https://api.github.com", repository: "synthetic/langfuse-smoke",
    providerRepositoryId: 1, providerActorId: 1, credentialRef: "synthetic", generation: 1,
    version: 1, state: "active", reviewExecutionMode: "harness_async",
    capabilities: { reviewSingle: true, reviewDeep: true, issueTriage: true, fix: false,
      evolution: false, defaultReviewWorkflow: "review.single.v1" } };
}
function fixtureSource(lease: RunLease): DeepReviewSource {
  return { identity: { tenantId: lease.tenantId, integrationId: lease.integrationId,
    runId, platform: "github", repository: "synthetic/langfuse-smoke",
    baseSha: lease.baseSha, headSha: lease.headSha }, input: {} as DeepReviewSource["input"],
  files: [], coverage: { status: "complete", reasonCodes: [] } };
}
function fixtureRoleLimits(): RoleLimits {
  return { maxTurns: 1, maxToolCalls: 1, maxCandidates: 2, maxWallTimeMs: 5_000,
    maxInputBytesPerTurn: 64_000, maxOutputTokensPerTurn: 256 };
}
function fixturePolicy(): ModelExecutionPolicy {
  return { version: "synthetic-v1", hash: "synthetic-pricing", currency: "USD",
    periodKey: "synthetic", provider: "openai-compatible", model: "langfuse-smoke-model",
    rates: { inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000,
      cacheWriteInputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 4_000_000,
      thoughtOutputMicrosPerMillion: 4_000_000, toolInputMicrosPerMillion: 1_000_000 },
    tenantLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 1_000_000 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 1_000_000 },
    maxOutputTokens: 256, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" };
}
async function assertLangfuseHealthy(env: NodeJS.ProcessEnv): Promise<string> {
  const base = env.LANGFUSE_BASE_URL?.trim();
  if (!base) throw new Error("LangfuseBaseUrlMissing");
  const response = await fetch(new URL("/api/public/health", base), { redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("LangfuseHealthCheckFailed");
  const payload = await response.json() as { version?: unknown };
  if (typeof payload.version !== "string") throw new Error("LangfuseHealthVersionMissing");
  return payload.version;
}
main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ runId, outcome: "failed",
    errorType: error instanceof Error ? error.name : "Error" })}\n`);
  process.exitCode = 1;
});
