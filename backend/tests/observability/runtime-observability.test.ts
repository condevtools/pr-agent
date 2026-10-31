import assert from "node:assert/strict";
import test from "node:test";

import type { SpanContext } from "@opentelemetry/api";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import type { ModelBudgetStore } from "../../src/agent-runtime/budget/model-budget-store.js";
import { currentRunExecutionContext } from "../../src/agent-runtime/execution/run-context.js";
import { RunWorker } from "../../src/agent-runtime/execution/run-worker.js";
import type { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";
import { executeModelRequest } from "../../src/model/execution-context.js";
import { runDeepReviewCritic } from "../../src/review/deep/critic.js";
import type { DeepReviewSource, DeepWorkflowContext } from "../../src/review/deep/contracts.js";
import { runDeepReviewRole } from "../../src/review/deep/roles/role-loop.js";
import {
  createAgentObservability,
  withAgentObservability,
  type AgentObservationAttributes,
  type AgentObservationDriver,
  type AgentObservationType,
  observeAgentOperation,
} from "../../src/observability/index.js";

test("Run telemetry nests a reused durable step and records the committed outcome", async () => {
  const records: ObservationRecord[] = [];
  const observability = createAgentObservability({
    env: telemetryEnvironment(),
    driver: recordingDriver(records),
  });
  const lease = workerLease("observed-run");
  let claimed = false;
  let providerCalls = 0;
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    beginStep: async () => ({
      id: "step-id", runId: lease.runId, stepKey: "review.analysis", kind: "model",
      inputHash: "input-hash", status: "succeeded", attemptId: "step-attempt-id",
      attemptNumber: 1, reused: true,
    }),
    loadStepOutput: async () => ({ cached: true }),
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    const result = await currentRunExecutionContext()!.step(
      "review.analysis", "model", "input-hash",
      async () => { providerCalls += 1; return { cached: false }; },
    );
    assert.deepEqual(result, { cached: true });
  }));

  await withAgentObservability(observability, async () => {
    await worker.tick();
    await worker.drain();
  });
  await worker.stop();

  assert.equal(providerCalls, 0);
  assert.equal(records.length, 2);
  const root = records.find(({ type }) => type === "agent")!;
  const step = records.find(({ name }) => name === "execute-model-step")!;
  assert.equal(root.options.sessionId, lease.runId);
  assert.equal(step.options.parentSpanContext?.spanId, root.spanContext.spanId);
  assert.deepEqual(root.updates.at(-1)?.output, { outcome: "succeeded" });
  assert.equal(step.updates.at(-1)?.metadata?.stepKey, "review.analysis");
  assert.equal(step.updates.at(-1)?.metadata?.stepKind, "model");
  assert.equal(step.updates.at(-1)?.metadata?.stepId, "step-id");
  assert.equal(step.updates.at(-1)?.metadata?.stepAttemptId, "step-attempt-id");
  assert.equal(step.updates.at(-1)?.metadata?.stepAttemptNumber, 1);
  assert.equal(step.updates.at(-1)?.metadata?.reused, true);
});

test("Run telemetry records retry_wait when workflow failure is handled internally", async () => {
  const records: ObservationRecord[] = [];
  const observability = createAgentObservability({
    env: telemetryEnvironment(),
    driver: recordingDriver(records),
  });
  const lease = workerLease("retry-run");
  let claimed = false;
  const store = workerStore({ claim: async () => claimed ? undefined : (claimed = true, lease) });
  const worker = new RunWorker(workerDependencies(store, async () => {
    throw new Error("temporary fixture failure");
  }));

  await withAgentObservability(observability, async () => {
    await worker.tick();
    await worker.drain();
  });
  await worker.stop();

  const root = records.find(({ type }) => type === "agent")!;
  assert.deepEqual(root.updates.at(-1)?.output, {
    outcome: "retry_wait",
    reasonCode: "Error",
  });
});

test("one dispatched model transport creates one Generation under its durable model step", async () => {
  const records: ObservationRecord[] = [];
  const observability = createAgentObservability({
    env: telemetryEnvironment(), driver: recordingDriver(records),
  });
  const lease = workerLease("model-run");
  lease.runtimeConfig.modelPolicy = modelPolicy();
  let claimed = false;
  let transportCalls = 0;
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    beginStep: async () => ({
      id: "model-step", runId: lease.runId, stepKey: "review.analysis", kind: "model",
      inputHash: "input-hash", status: "running", attemptId: "model-attempt",
      attemptNumber: 1, reused: false,
    }),
    completeStep: async () => undefined,
    failStep: async () => undefined,
  });
  const budget = {
    prepare: async () => ({
      id: "model-call", tenantId: lease.tenantId, runId: lease.runId,
      stepId: "model-step", stepAttemptId: "model-attempt", physicalOrdinal: 1,
      requestHash: "request-hash", status: "prepared", reservationStatus: "reserved",
    }),
    markDispatched: async () => undefined,
    settleKnown: async () => undefined,
    settleProviderFailure: async () => undefined,
    settleUnknown: async () => undefined,
    closeRunBudgetInTransaction: async () => "closed",
  } as unknown as ModelBudgetStore;
  const worker = new RunWorker(workerDependencies(store, async () => {
    await currentRunExecutionContext()!.step("review.analysis", "model", "input-hash", () =>
      executeModelRequest({
        provider: "openai-compatible", model: "fixture-model", requestKind: "structured",
        requestHash: "request-hash", inputTokenUpperBound: 20, maxOutputTokens: 100,
        metadata: { role: "reviewer", turn: 1 },
      }, async () => {
        transportCalls += 1;
        return {
          value: { verdict: "ok" }, rawResponse: { omitted: true },
          observationOutput: { verdict: "ok" }, providerRequestId: "provider-request",
          modelVersion: "fixture-model-v1", httpStatus: 200,
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, original: {} },
        };
      }, { input: { prompt: "review fixture" } }));
  }, budget));

  await withAgentObservability(observability, async () => {
    await worker.tick();
    await worker.drain();
  });
  await worker.stop();

  assert.equal(transportCalls, 1);
  const generations = records.filter(({ type }) => type === "generation");
  assert.equal(generations.length, 1);
  const step = records.find(({ name }) => name === "execute-model-step")!;
  assert.equal(generations[0]!.options.parentSpanContext?.spanId, step.spanContext.spanId);
  assert.deepEqual(generations[0]!.updates.at(-1)?.usageDetails, {
    input: 10, input_cached: 0, output: 4, output_reasoning: 0,
  });
});

test("Deep Review role and critic executions are distinct nested Agent observations", async () => {
  const records: ObservationRecord[] = [];
  const observability = createAgentObservability({
    env: telemetryEnvironment(),
    driver: recordingDriver(records),
  });
  const lease = workerLease("deep-run");
  const source = {
    identity: { tenantId: lease.tenantId, integrationId: lease.integrationId,
      runId: lease.runId, platform: "github", repository: "acme/repository",
      baseSha: lease.baseSha, headSha: lease.headSha },
    input: {},
    files: [],
    coverage: { status: "complete", reasonCodes: [] },
  } as unknown as DeepReviewSource;
  const context = {
    lease,
    step: async <T>(_key: string, _kind: string, _inputHash: string,
      action: () => Promise<T>) => action(),
    model: { generate: async (request: { role?: string }) => request.role === "critic"
      ? { decisions: [] }
      : { action: "finish", candidates: [] } },
    tools: { catalog: () => [], invoke: async () => { throw new Error("tool not expected"); } },
    store: {
      registerCandidates: async () => undefined,
      registerDecisions: async () => undefined,
    },
  } as unknown as DeepWorkflowContext;

  await withAgentObservability(observability, () => observeAgentOperation(
    "execute-review-deep-v1", "agent", {}, async () => {
      await Promise.all([
        runDeepReviewRole({ role: "security", source, context, limits: roleLimits() }),
        runDeepReviewRole({ role: "correctness", source, context, limits: roleLimits() }),
      ]);
      await runDeepReviewCritic({ candidates: [], coverage: [], context,
        policy: { roleLimits: { security: roleLimits(), correctness: roleLimits() },
          criticInputCandidateLimit: 10,
          criticLimits: { maxWallTimeMs: 1_000, maxInputBytes: 10_000, maxOutputTokens: 100 } } });
    },
  ));

  const root = records.find(({ name }) => name === "execute-review-deep-v1")!;
  const agents = records.filter(({ name }) => name.startsWith("deep-review-"));
  assert.deepEqual(agents.map(({ name }) => name).sort(), [
    "deep-review-correctness", "deep-review-critic", "deep-review-security",
  ]);
  assert.ok(agents.every(({ options }) => options.parentSpanContext?.spanId === root.spanContext.spanId));
});

interface ObservationRecord {
  name: string;
  type: AgentObservationType;
  attributes: AgentObservationAttributes;
  options: { parentSpanContext?: SpanContext; sessionId?: string };
  spanContext: SpanContext;
  updates: AgentObservationAttributes[];
  ended: boolean;
}

function recordingDriver(records: ObservationRecord[]): AgentObservationDriver {
  let ordinal = 0;
  return {
    start(name, type, attributes, options) {
      ordinal += 1;
      const spanContext: SpanContext = {
        traceId: ordinal === 1
          ? "1".repeat(32)
          : options.parentSpanContext?.traceId ?? `${ordinal}`.repeat(32).slice(0, 32),
        spanId: ordinal.toString(16).padStart(16, "0"),
        traceFlags: 1,
      };
      const record: ObservationRecord = {
        name, type, attributes, options, spanContext, updates: [], ended: false,
      };
      records.push(record);
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        spanContext,
        update(update) { record.updates.push(update); },
        end() { record.ended = true; },
      };
    },
    shutdown: async () => undefined,
  };
}

function telemetryEnvironment(): NodeJS.ProcessEnv {
  return {
    LANGFUSE_ENABLED: "on",
    LANGFUSE_CAPTURE_CONTENT: "redacted",
    LANGFUSE_PUBLIC_KEY: "fixture-public",
    LANGFUSE_SECRET_KEY: "fixture-secret",
    LANGFUSE_BASE_URL: "http://127.0.0.1:43189",
  };
}

function workerLease(runId: string): RunLease {
  return {
    tenantId: "tenant", runId, integrationId: "integration", jobId: `job-${runId}`,
    jobKind: "start", owner: "owner", epoch: 2, jobAttempt: 1,
    authorityGeneration: 1, executionModeGeneration: 1,
    deadlineAt: new Date(Date.now() + 300_000).toISOString(), baseSha: "base", headSha: "head",
    workflowVersionHash: "workflow", promptVersionHash: "prompt", modelVersionHash: "model",
    toolVersionHash: "tool", policyVersionHash: "policy", runtimeVersionHash: "runtime",
    input: { workflow: "review.single.v1" }, limits: {},
    runtimeConfig: { maxJobAttempts: 3, maxCheckpointBytes: 4 * 1024 * 1024 },
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

function workerStore(overrides: Partial<RunExecutionStore>): RunExecutionStore {
  return {
    claimPublicationOutcome: async () => undefined,
    claimManualResume: async () => undefined,
    claim: async () => undefined,
    latestCheckpoint: async () => undefined,
    withLease: async (_lease: RunLease, action: () => Promise<unknown>) => action(),
    heartbeat: async (lease: RunLease) => lease,
    transition: async () => undefined,
    relinquishSettledLease: async () => undefined,
    ...overrides,
  } as unknown as RunExecutionStore;
}

function workerDependencies(
  store: RunExecutionStore,
  execute: () => Promise<void>,
  budget: ModelBudgetStore = {
    closeRunBudgetInTransaction: async () => "closed",
  } as unknown as ModelBudgetStore,
) {
  const binding = {
    id: "integration", tenantId: "tenant", platform: "github", origin: "https://api.github.com",
    repository: "acme/repository", reviewExecutionMode: "harness_async",
  } as PublicationBinding;
  return {
    store,
    budget,
    bindings: async () => [binding],
    runtimeHash: async () => "runtime",
    execute,
    onError: () => undefined,
  };
}

function modelPolicy() {
  const rates = {
    inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000,
    cacheWriteInputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 4_000_000,
    thoughtOutputMicrosPerMillion: 4_000_000, toolInputMicrosPerMillion: 1_000_000,
  };
  return {
    version: "fixture-v1", hash: "pricing-hash", currency: "USD", periodKey: "fixture-period",
    provider: "openai-compatible", model: "fixture-model", rates,
    tenantLimits: { inputTokens: 1_000, outputTokens: 1_000, costMicros: 1_000_000 },
    runLimits: { inputTokens: 1_000, outputTokens: 1_000, costMicros: 1_000_000 },
    maxOutputTokens: 100, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens",
  };
}

function roleLimits() {
  return {
    maxTurns: 1, maxToolCalls: 1, maxCandidates: 2, maxWallTimeMs: 1_000,
    maxInputBytesPerTurn: 10_000, maxOutputTokensPerTurn: 100,
  };
}
