import assert from "node:assert/strict";
import test from "node:test";
import { createBudgetedModelExecutionContext, type ModelBudgetStore, type ModelExecutionPolicy,
  type PreparedModelCall } from "../../src/agent-runtime/budget/model-budget-store.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";
import type { ModelRequestIntent, NormalizedModelUsage } from "../../src/model/execution-context.js";
import { modelObservationUsage } from "../../src/model/observability.js";
import { createAgentObservability, withAgentObservability,
  type AgentObservationAttributes, type AgentObservationDriver } from "../../src/observability/index.js";

test("provider usage categories are mutually exclusive and missing usage stays unknown", () => {
  const usage: NormalizedModelUsage = { inputTokens: 10, outputTokens: 6, cachedInputTokens: 3,
    cacheWriteInputTokens: 2, reasoningOrThoughtTokens: 2, toolInputTokens: 4, original: {} };
  assert.deepEqual(modelObservationUsage("openai", usage), {
    input: 7, input_cached: 3, output: 4, output_reasoning: 2,
  });
  assert.deepEqual(modelObservationUsage("anthropic", usage), {
    input: 10, input_cached: 3, input_cache_write: 2, output: 6,
  });
  assert.deepEqual(modelObservationUsage("gemini", usage), {
    input: 7, input_cached: 3, input_tool: 4, output: 6, output_reasoning: 2,
  });
  assert.equal(modelObservationUsage("openai", { original: {} }), undefined);
  assert.equal(modelObservationUsage("openai", { ...usage, cachedInputTokens: 11 }), undefined);
});

test("one physical dispatch emits one generation with settled cost; transient content is not persisted", async () => {
  const fixture = modelFixture();
  const value = await withAgentObservability(fixture.telemetry, () => fixture.context.execute(intent, async () => ({
    value: "business-result", rawResponse: { neverExport: "raw-provider-envelope" },
    observationOutput: [{ role: "assistant", content: "review complete" }],
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, original: {} },
    providerRequestId: "request-fixture", modelVersion: "fixture-model", httpStatus: 200,
  }), { input: [{ role: "user", content: "synthetic prompt" }] }));
  assert.equal(value, "business-result");
  assert.deepEqual(fixture.events, ["prepare", "dispatch", "start:generation", "settleKnown", "end"]);
  assert.equal(fixture.generations.length, 1);
  assert.equal(fixture.generations[0]?.model, "fixture-model");
  assert.deepEqual(fixture.generations[0]?.costDetails, { total: 0.00003 });
  assert.equal(fixture.generations[0]?.metadata?.settlementStatus, "settled");
  assert.equal(fixture.generations[0]?.metadata?.modelCallId, "model-call");
  assert.ok(!JSON.stringify(fixture.prepared).includes("synthetic prompt"));
  assert.ok(!JSON.stringify(fixture.generations).includes("raw-provider-envelope"));
});

test("terminal call reuse and pre-dispatch failure emit no generations or new transport calls", async () => {
  const fixture = modelFixture("succeeded");
  let calls = 0;
  assert.equal(await withAgentObservability(fixture.telemetry, () => fixture.context.execute(intent, async () => {
    calls += 1; return { value: "unexpected", rawResponse: {} };
  })), "cached response");
  assert.equal(calls, 0);
  assert.equal(fixture.generations.length, 0);
  const denied = modelFixture("prepared", true);
  await assert.rejects(withAgentObservability(denied.telemetry, () => denied.context.execute(intent, async () => {
    calls += 1; return { value: "unexpected", rawResponse: {} };
  })), /dispatch denied/u);
  assert.equal(calls, 0);
  assert.equal(denied.generations.length, 0);
});

test("unknown transport failure preserves the original error, pending accounting, and safe trace error", async () => {
  const fixture = modelFixture();
  const failure = new TypeError("secret transport payload must not leave process");
  await assert.rejects(withAgentObservability(fixture.telemetry, () => fixture.context.execute(intent,
    async () => { throw failure; })), (error) => error === failure);
  assert.deepEqual(fixture.events, ["prepare", "dispatch", "start:generation", "settleUnknown", "end"]);
  assert.equal(fixture.generations[0]?.metadata?.settlementStatus, "pending");
  assert.equal(fixture.generations[0]?.level, "ERROR");
  assert.equal(fixture.generations[0]?.costDetails, undefined);
  assert.ok(!JSON.stringify(fixture.generations).includes(failure.message));
});

test("HTTP failure with missing usage is visible without inventing zero usage/cost", async () => {
  const fixture = modelFixture();
  await withAgentObservability(fixture.telemetry, () => fixture.context.execute(intent, async () => ({
    value: "http-failure", rawResponse: { body: "provider error details" }, httpStatus: 429,
  })));
  assert.deepEqual(fixture.events, ["prepare", "dispatch", "start:generation", "settleProviderFailure", "end"]);
  assert.equal(fixture.generations[0]?.level, "ERROR");
  assert.equal(fixture.generations[0]?.metadata?.usageStatus, "unavailable");
  assert.equal(fixture.generations[0]?.usageDetails, undefined);
  assert.equal(fixture.generations[0]?.costDetails, undefined);
});

test("non-USD accounting is preserved in metadata and never mislabeled as Langfuse USD", async () => {
  const fixture = modelFixture("prepared", false, "CNY");
  await withAgentObservability(fixture.telemetry, () => fixture.context.execute(intent, async () => ({
    value: "ok", rawResponse: {}, usage: { inputTokens: 10, outputTokens: 5, original: {} },
  })));
  assert.equal(fixture.generations[0]?.metadata?.currency, "CNY");
  assert.equal(fixture.generations[0]?.metadata?.actualCostMicros, 30);
  assert.equal(fixture.generations[0]?.costDetails, undefined);
});

const intent: ModelRequestIntent = { provider: "openai-compatible", model: "fixture-model",
  requestKind: "structured", requestHash: "request-hash", inputTokenUpperBound: 100, maxOutputTokens: 20 };

function modelFixture(status: PreparedModelCall["status"] = "prepared", failDispatch = false, currency = "USD") {
  const events: string[] = [];
  const prepared: unknown[] = [];
  const generations: AgentObservationAttributes[] = [];
  const driver: AgentObservationDriver = {
    start: (_name, type, attributes) => {
      events.push(`start:${type}`);
      const record = { ...attributes };
      generations.push(record);
      return { update: (update) => Object.assign(record, update), end: () => { events.push("end"); } };
    }, shutdown: async () => undefined,
  };
  const telemetry = createAgentObservability({ driver, env: {
    LANGFUSE_ENABLED: "on", LANGFUSE_CAPTURE_CONTENT: "redacted", LANGFUSE_BASE_URL: "https://fixture.invalid",
    LANGFUSE_PUBLIC_KEY: "pk-fixture", LANGFUSE_SECRET_KEY: "sk-fixture",
  } });
  const store = {
    prepare: async (input: unknown) => {
      events.push("prepare"); prepared.push(input);
      return { id: "model-call", status, response: "cached response" };
    },
    markDispatched: async () => { events.push("dispatch"); if (failDispatch) throw new Error("dispatch denied"); },
    settleKnown: async () => { events.push("settleKnown"); },
    settleProviderFailure: async () => { events.push("settleProviderFailure"); },
    settleUnknown: async () => { events.push("settleUnknown"); },
  } as unknown as ModelBudgetStore;
  const policy = { provider: "openai-compatible", currency, maxOutputTokens: 20, hash: "pricing-hash",
    rates: { inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000,
      cacheWriteInputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 4_000_000,
      thoughtOutputMicrosPerMillion: 4_000_000, toolInputMicrosPerMillion: 1_000_000 },
  } as ModelExecutionPolicy;
  const context = createBudgetedModelExecutionContext({ store, policy,
    lease: { runId: "run-fixture", runType: "issue.triage.v1", input: {} } as RunLease,
    stepId: "step", stepAttemptId: "step-attempt", stepKey: "issue.triage.analyze" });
  return { context, telemetry, events, prepared, generations };
}
