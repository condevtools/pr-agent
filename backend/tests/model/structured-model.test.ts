import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  estimateInputTokenUpperBound,
  modelRequestHash,
  withModelExecutionContext,
  type ModelRequestIntent,
} from "../../src/model/execution-context.js";
import { createStructuredModel } from "../../src/model/structured-model.js";
import { createAiConcurrencyLimiter } from "../../src/model/concurrency.js";
import type { OpenAIClientCache } from "../../src/model/client-cache.js";
import { deepRoleTurnJsonSchema, deepRoleTurnResponseSchema } from "../../src/review/deep/roles/role-loop.js";
import { deepCriticJsonSchema, deepCriticResponseSchema } from "../../src/review/deep/critic.js";

test("structured Gemini transport enforces the per-turn output cap", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const intents: ModelRequestIntent[] = [];
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { generationConfig: { maxOutputTokens: number } };
    assert.equal(body.generationConfig.maxOutputTokens, 7);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }],
    }), { status: 200 });
  };
  try {
    const model = createStructuredModel({ configuration: { provider: "gemini", model: "gemini-test" } });
    const result = await withModelExecutionContext({
      policy: { maxOutputTokens: 100 },
      async execute(intent, transport) {
        intents.push(intent);
        return (await transport()).value;
      },
    }, () => model.generate({
      schemaName: "evolution_candidate_v1", jsonSchema: { type: "object" },
      schema: z.object({ ok: z.boolean() }).strict(),
      systemPrompt: "system", prompt: "prompt", role: "evolution", turn: 1,
      maxInputBytes: 10_000, maxOutputTokens: 7,
    }));
    assert.deepEqual(result, { ok: true });
    assert.equal(intents[0]?.maxOutputTokens, 7);
    assert.equal(intents[0]?.requestKind, "structured:generate-content-schema");
    assert.deepEqual(intents[0]?.metadata, {
      schemaName: "evolution_candidate_v1",
      role: "evolution",
      turn: 1,
      physicalAttempt: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("GEMINI_API_KEY", originalKey);
  }
});

test("structured transport rejects oversized role input before provider I/O", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  let calls = 0;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
  try {
    const model = createStructuredModel({ configuration: { provider: "gemini", model: "gemini-test" } });
    await assert.rejects(model.generate({
      schemaName: "bounded", jsonSchema: { type: "object" },
      schema: z.object({ ok: z.boolean() }).strict(),
      systemPrompt: "system", prompt: "too large", role: "security", turn: 1,
      maxInputBytes: 1, maxOutputTokens: 7,
    }), /input exceeds the role turn limit/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("GEMINI_API_KEY", originalKey);
  }
});

test("OpenAI strict schemas require nullable optional fields and normalize null responses", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const requests: Array<Record<string, any>> = [];
  const intents: ModelRequestIntent[] = [];
  process.env.OPENAI_API_KEY = "test-key";
  const responses = [
    { action: "finish", request: null, candidates: [{ severity: "medium", title: "Issue", body: "Body",
      location: { path: "src/a.ts", side: "new", startLine: 1, endLine: 1 },
      evidenceIds: ["evidence"], crossFileEvidenceIds: [], suggestion: null }] },
    { decisions: [{ candidateId: "candidate", decision: "accept", reasonCode: "supported",
      duplicateOfCandidateId: null }] },
  ];
  const clientCache = { get: () => ({ chat: { completions: { create: async (body: Record<string, unknown>) => {
    requests.push(body); const value = responses.shift();
    return { id: "response", model: "fixture", choices: [{ message: { content: JSON.stringify(value) } }] };
  } } } }) } as unknown as OpenAIClientCache;
  try {
    const model = createStructuredModel({ configuration: { provider: "openai", model: "fixture" }, clientCache,
      concurrencyLimiter: createAiConcurrencyLimiter() });
    const { role, critic } = await withModelExecutionContext({
      async execute(intent, transport) {
        intents.push(intent);
        return (await transport()).value;
      },
    }, async () => ({
      role: await model.generate({ schemaName: "role", jsonSchema: deepRoleTurnJsonSchema as unknown as Record<string, unknown>,
        schema: deepRoleTurnResponseSchema, systemPrompt: "system", prompt: "prompt", role: "security", turn: 1,
        maxInputBytes: 100_000, maxOutputTokens: 100 }),
      critic: await model.generate({ schemaName: "critic", jsonSchema: deepCriticJsonSchema as unknown as Record<string, unknown>,
        schema: deepCriticResponseSchema, systemPrompt: "system", prompt: "prompt", role: "critic", turn: 1,
        maxInputBytes: 100_000, maxOutputTokens: 100 }),
    }));

    assert.deepEqual(role, { action: "finish", candidates: [{ severity: "medium", title: "Issue", body: "Body",
      location: { path: "src/a.ts", side: "new", startLine: 1, endLine: 1 },
      evidenceIds: ["evidence"], crossFileEvidenceIds: [] }] });
    assert.deepEqual(critic, { decisions: [{ candidateId: "candidate", decision: "accept", reasonCode: "supported" }] });
    assert.deepEqual(requests[0]!.messages, [{ role: "system", content: "system" },
      { role: "user", content: "prompt" }]);
    assert.equal(requests[0]!.max_completion_tokens, 100);
    assert.deepEqual(requests[1]!.messages, [{ role: "system", content: "system" },
      { role: "user", content: "prompt" }]);
    assert.equal(requests[1]!.max_completion_tokens, 100);
    assert.equal(intents[0]?.requestHash, modelRequestHash(requests[0]));
    assert.equal(intents[0]?.inputTokenUpperBound, estimateInputTokenUpperBound(requests[0]));
    assert.equal(intents[1]?.requestHash, modelRequestHash(requests[1]));
    assert.equal(intents[1]?.inputTokenUpperBound, estimateInputTokenUpperBound(requests[1]));
    const roleSchema = requests[0]!.response_format.json_schema;
    assert.equal(roleSchema.strict, true);
    assert.equal(roleSchema.schema.type, "object");
    assert.equal("oneOf" in roleSchema.schema, false);
    assert.equal("anyOf" in roleSchema.schema, false);
    assert.deepEqual(roleSchema.schema.required, ["action", "request", "candidates"]);
    assert.equal(roleSchema.schema.additionalProperties, false);
    const candidate = roleSchema.schema.properties.candidates.anyOf[0].items;
    assert.ok(candidate.required.includes("suggestion"));
    assert.deepEqual(candidate.properties.suggestion.anyOf, [{ type: "string" }, { type: "null" }]);
    const criticItem = requests[1]!.response_format.json_schema.schema.properties.decisions.items;
    assert.ok(criticItem.required.includes("duplicateOfCandidateId"));
    assert.deepEqual(criticItem.properties.duplicateOfCandidateId.anyOf,
      [{ type: "string" }, { type: "null" }]);
    assertStrictObjectFields(roleSchema.schema);
    assertStrictObjectFields(requests[1]!.response_format.json_schema.schema);
  } finally {
    restoreEnv("OPENAI_API_KEY", originalKey);
  }
});

test("OpenAI-compatible sends the exact schema in the system prompt for initial and fallback requests", async () => {
  const originalCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const requests: Array<Record<string, any>> = [];
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://compatible.invalid/v1";
  const schema = { type: "object", properties: { ok: { type: "boolean" } },
    required: ["ok"], additionalProperties: false };
  const clientCache = { get: () => ({ chat: { completions: { create: async (body: Record<string, unknown>) => {
    requests.push(body);
    if (requests.length === 1) throw Object.assign(new Error("schema unsupported"), { status: 400 });
    return { id: "response", model: "compatible-fixture", choices: [{ message: { content: "{\"ok\":true}" } }] };
  } } } }) } as unknown as OpenAIClientCache;
  try {
    const result = await withTestModelContext(() => createStructuredModel({ configuration: { provider: "openai-compatible", model: "fixture" },
      clientCache, concurrencyLimiter: createAiConcurrencyLimiter() }).generate({
      schemaName: "compatible", jsonSchema: schema, schema: z.object({ ok: z.boolean() }).strict(),
      systemPrompt: "trusted system", prompt: "unchanged user prompt", role: "security", turn: 1,
      maxInputBytes: 10_000, maxOutputTokens: 100 }));
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.messages[0].role, "system");
      assert.match(request.messages[0].content, /only one JSON value/);
      assert.ok(request.messages[0].content.includes(JSON.stringify(schema)));
      assert.deepEqual(request.messages[1], { role: "user", content: "unchanged user prompt" });
    }
    assert.equal(requests[0]!.response_format.type, "json_schema");
    assert.deepEqual(requests[0]!.response_format.json_schema.schema, schema);
    assert.equal(requests[1]!.response_format.type, "json_object");
  } finally {
    restoreEnv("OPENAI_COMPATIBLE_API_KEY", originalCompatibleKey);
    restoreEnv("OPENAI_BASE_URL", originalBaseUrl);
  }
});

test("OpenAI-compatible rejects invalid wrapper responses after schema prompting", async () => {
  const originalCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://compatible.invalid/v1";
  const clientCache = { get: () => ({ chat: { completions: { create: async () => ({ id: "response", model: "fixture",
    choices: [{ message: { content: JSON.stringify({ action: "request_tool", tool: "read_file_range",
      arguments: { path: "src/a.ts" } }) } }] }) } } }) } as unknown as OpenAIClientCache;
  try {
    const model = createStructuredModel({ configuration: { provider: "openai-compatible", model: "fixture" },
      clientCache, concurrencyLimiter: createAiConcurrencyLimiter() });
    await assert.rejects(withTestModelContext(() => model.generate({ schemaName: "role",
      jsonSchema: deepRoleTurnJsonSchema as unknown as Record<string, unknown>, schema: deepRoleTurnResponseSchema,
      systemPrompt: "system", prompt: "prompt", role: "security", turn: 1,
      maxInputBytes: 100_000, maxOutputTokens: 100 })), z.ZodError);
  } finally {
    restoreEnv("OPENAI_COMPATIBLE_API_KEY", originalCompatibleKey);
    restoreEnv("OPENAI_BASE_URL", originalBaseUrl);
  }
});

test("OpenAI-compatible bounds the augmented schema system prompt before provider I/O", async () => {
  const originalCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  let calls = 0;
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://compatible.invalid/v1";
  const clientCache = { get: () => ({ chat: { completions: { create: async () => {
    calls += 1; throw new Error("must not run");
  } } } }) } as unknown as OpenAIClientCache;
  try {
    const model = createStructuredModel({ configuration: { provider: "openai-compatible", model: "fixture" },
      clientCache, concurrencyLimiter: createAiConcurrencyLimiter() });
    await assert.rejects(model.generate({ schemaName: "bounded", jsonSchema: { type: "object" },
      schema: z.object({}).strict(), systemPrompt: "system", prompt: "prompt", role: "security", turn: 1,
      maxInputBytes: 100, maxOutputTokens: 10 }), /input exceeds the role turn limit/);
    assert.equal(calls, 0);
  } finally {
    restoreEnv("OPENAI_COMPATIBLE_API_KEY", originalCompatibleKey);
    restoreEnv("OPENAI_BASE_URL", originalBaseUrl);
  }
});

for (const provider of ["openai", "openai-compatible"] as const) {
  test(`active ${provider} cancellation aborts transport without fallback or limiter leakage`, async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalCompatibleKey = process.env.OPENAI_COMPATIBLE_API_KEY;
    const originalBaseUrl = process.env.OPENAI_BASE_URL;
    const controller = new AbortController();
    const limiter = createAiConcurrencyLimiter({ resolveMaxConcurrency: () => 1 });
    const intents: ModelRequestIntent[] = [];
    let physicalCalls = 0;
    let transportCancelled = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_COMPATIBLE_API_KEY = "compatible-test-key";
    process.env.OPENAI_BASE_URL = "https://compatible.invalid/v1";
    const clientCache = { get: () => ({ chat: { completions: { create: async (
      _body: Record<string, unknown>,
      options: { signal?: AbortSignal },
    ) => {
      physicalCalls += 1;
      const signal = options.signal;
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          transportCancelled = true;
          reject(signal.reason);
        }, { once: true });
      });
    } } } }) } as unknown as OpenAIClientCache;

    try {
      const model = createStructuredModel({
        configuration: { provider, model: "fixture" },
        clientCache,
        concurrencyLimiter: limiter,
      });
      const pending = withModelExecutionContext({
        async execute(intent, transport) {
          intents.push(intent);
          return (await transport()).value;
        },
      }, () => model.generate({
        schemaName: "active_abort",
        jsonSchema: { type: "object" },
        schema: z.object({ ok: z.boolean() }).strict(),
        systemPrompt: "system",
        prompt: "prompt",
        role: "fix",
        turn: 1,
        maxInputBytes: 10_000,
        maxOutputTokens: 100,
        signal: controller.signal,
      }));
      await started;
      assert.equal(limiter.getStats().activeRequests, 1);
      controller.abort(new DOMException("active request cancelled", "AbortError"));
      await assert.rejects(pending, /active request cancelled/);
      assert.equal(transportCancelled, true);
      assert.equal(physicalCalls, 1);
      assert.equal(intents.length, 1);
      assert.equal(limiter.getStats().activeRequests, 0);
      assert.equal(limiter.getStats().queuedRequests, 0);
      assert.equal(await limiter.withLimit(async () => "released"), "released");
    } finally {
      restoreEnv("OPENAI_API_KEY", originalOpenAiKey);
      restoreEnv("OPENAI_COMPATIBLE_API_KEY", originalCompatibleKey);
      restoreEnv("OPENAI_BASE_URL", originalBaseUrl);
    }
  });
}

test("a queued deep model deadline removes its waiter before transport starts", async () => {
  const limiter = createAiConcurrencyLimiter({ resolveMaxConcurrency: () => 1 });
  let release!: () => void;
  const active = limiter.withLimit(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not run"); };
  const keepAlive = setTimeout(() => undefined, 2_000);
  try {
    const model = createStructuredModel({ configuration: { provider: "gemini", model: "fixture" }, concurrencyLimiter: limiter });
    await assert.rejects(model.generate({ schemaName: "bounded", jsonSchema: { type: "object" },
      schema: z.object({ ok: z.boolean() }), systemPrompt: "system", prompt: "prompt", role: "security", turn: 1,
      maxInputBytes: 1_000, maxOutputTokens: 10, signal: AbortSignal.timeout(40) }), /timeout/i);
    assert.equal(limiter.getStats().queuedRequests, 0);
    assert.equal(limiter.getStats().activeRequests, 1);
    assert.equal(calls, 0);
  } finally {
    clearTimeout(keepAlive); globalThis.fetch = originalFetch; release(); await active;
  }
  assert.equal(await limiter.withLimit(async () => "next"), "next");
  assert.equal(limiter.getStats().activeRequests, 0);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withTestModelContext<T>(callback: () => Promise<T>): Promise<T> {
  return withModelExecutionContext({
    async execute(_intent, transport) {
      return (await transport()).value;
    },
  }, callback);
}

function assertStrictObjectFields(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object") {
    assert.equal(record.additionalProperties, false);
    const properties = record.properties as Record<string, unknown>;
    assert.deepEqual([...(record.required as string[])].sort(), Object.keys(properties).sort());
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach(assertStrictObjectFields);
    else assertStrictObjectFields(value);
  }
}
