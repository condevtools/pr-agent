import assert from "node:assert/strict";
import test from "node:test";

import {
  currentModelOutputLimit,
  executeModelRequest,
  ModelExecutionContextRequiredError,
  withModelExecutionContext,
} from "../../src/model/execution-context.js";
import {
  calculateActualModelUsage,
  getModelExecutionPolicy as loadPolicy,
  type ModelPriceRates,
} from "../../src/agent-runtime/budget/model-budget-store.js";

const rates: ModelPriceRates = {
  inputMicrosPerMillion: 1_000_000,
  cachedInputMicrosPerMillion: 500_000,
  cacheWriteInputMicrosPerMillion: 2_000_000,
  outputMicrosPerMillion: 3_000_000,
  thoughtOutputMicrosPerMillion: 4_000_000,
  toolInputMicrosPerMillion: 5_000_000,
};

test("provider usage normalization does not double count cached or reasoning subsets", () => {
  assert.deepEqual(
    calculateActualModelUsage({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOrThoughtTokens: 10,
      original: {},
    }, rates, "openai"),
    { inputTokens: 100, outputTokens: 30, costMicros: 180 },
  );
  assert.deepEqual(
    calculateActualModelUsage({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 30,
      original: {},
    }, rates, "anthropic"),
    { inputTokens: 130, outputTokens: 30, costMicros: 220 },
  );
  assert.deepEqual(
    calculateActualModelUsage({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOrThoughtTokens: 10,
      toolInputTokens: 5,
      original: {},
    }, rates, "gemini"),
    { inputTokens: 105, outputTokens: 40, costMicros: 245 },
  );
  assert.equal(calculateActualModelUsage({
    inputTokens: 10,
    cachedInputTokens: 11,
    outputTokens: 1,
    original: {},
  }, rates, "openai"), undefined);
});

test("durable model context owns the physical request and frozen output cap", async () => {
  const intents: string[] = [];
  const result = await withModelExecutionContext({
    policy: { maxOutputTokens: 64 },
    async execute(intent, transport) {
      intents.push(intent.requestHash);
      return (await transport()).value;
    },
  }, async () => {
    assert.equal(currentModelOutputLimit(200), 64);
    return executeModelRequest({
      provider: "openai",
      model: "model-a",
      requestKind: "test",
      requestHash: "a".repeat(64),
      inputTokenUpperBound: 20,
      maxOutputTokens: 64,
    }, async () => ({ value: "ok", rawResponse: { value: "ok" } }));
  });
  assert.equal(result, "ok");
  assert.deepEqual(intents, ["a".repeat(64)]);
  assert.equal(currentModelOutputLimit(200), 200);
});

test("model requests fail closed before transport without a Run execution context", async () => {
  let transportCalls = 0;
  await assert.rejects(
    executeModelRequest({
      provider: "openai",
      model: "model-a",
      requestKind: "context-required",
      requestHash: "b".repeat(64),
      inputTokenUpperBound: 20,
      maxOutputTokens: 64,
    }, async () => {
      transportCalls += 1;
      return { value: "unexpected", rawResponse: {} };
    }),
    (error: unknown) => error instanceof ModelExecutionContextRequiredError
      && error.requestKind === "context-required",
  );
  assert.equal(transportCalls, 0);
});

test("trusted pricing is required outside the explicit isolated test policy", () => {
  assert.throws(
    () => loadPolicy("openai", "model-a", {}),
    /HARNESS_MODEL_PRICING_JSON is required/,
  );
  const policy = loadPolicy("openai", "model-a", {
    NODE_ENV: "test",
    HARNESS_ALLOW_ZERO_COST_MODEL_POLICY: "isolated-test-only",
  });
  assert.equal(policy.maxPhysicalCallsPerStep, 8);
  assert.equal(policy.openAiTokenParameter, "max_completion_tokens");
  assert.match(policy.hash, /^[0-9a-f]{64}$/);
  assert.throws(
    () => loadPolicy("openai-compatible", "model-a", {
      HARNESS_MODEL_PRICING_JSON: JSON.stringify({
        version: "v1",
        currency: "USD",
        periodKey: "test",
        tenantLimits: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
        runLimits: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
        models: {
          "openai-compatible:model-a": {
            rates,
            maxOutputTokens: 1,
            maxPhysicalCallsPerStep: 1,
          },
        },
      }),
    }),
    /openAiTokenParameter/,
  );
});
