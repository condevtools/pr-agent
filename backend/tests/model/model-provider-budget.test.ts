import { ProviderHttpError } from "../../src/core/http/provider-error.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  type ModelRequestIntent,
  withModelExecutionContext,
} from "../../src/model/execution-context.js";
import { callGeminiJson } from "../../src/model/providers/gemini.js";

test("durable Gemini compatibility fallback is two visible physical calls with no hidden retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalRetries = process.env.AI_HTTP_RETRIES;
  const intents: ModelRequestIntent[] = [];
  let fetchCount = 0;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_HTTP_RETRIES = "5";
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response("responseSchema unsupported", { status: 400 });
    }
    return new Response(JSON.stringify({
      responseId: "response-2",
      modelVersion: "gemini-test-v1",
      candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }],
      usageMetadata: {
        promptTokenCount: 12,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 1,
        totalTokenCount: 17,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await withModelExecutionContext({
      policy: { maxOutputTokens: 32 },
      async execute(intent, transport) {
        intents.push(intent);
        return (await transport()).value;
      },
    }, () => callGeminiJson({
      model: "gemini-test",
      systemPrompt: "system",
      prompt: "prompt",
      responseSchema: { type: "object" },
    }));
    assert.deepEqual(result, { ok: true });
    assert.equal(fetchCount, 2);
    assert.deepEqual(intents.map((intent) => intent.requestKind), [
      "generate-content-schema",
      "generate-content-json",
    ]);
    assert.deepEqual(intents.map((intent) => intent.maxOutputTokens), [32, 32]);
    assert.notEqual(intents[0]?.requestHash, intents[1]?.requestHash);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("GEMINI_API_KEY", originalKey);
    restoreEnv("AI_HTTP_RETRIES", originalRetries);
  }
});

test("durable Gemini path disables fetch retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalRetries = process.env.AI_HTTP_RETRIES;
  let fetchCount = 0;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_HTTP_RETRIES = "5";
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("temporary", { status: 500 });
  };
  try {
    await assert.rejects(
      withModelExecutionContext({
        policy: { maxOutputTokens: 32 },
        async execute(_intent, transport) {
          return (await transport()).value;
        },
      }, () => callGeminiJson({
        model: "gemini-test",
        systemPrompt: "system",
        prompt: "prompt",
      })),
      (error: unknown) => error instanceof ProviderHttpError && error.status === 500,
    );
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("GEMINI_API_KEY", originalKey);
    restoreEnv("AI_HTTP_RETRIES", originalRetries);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
