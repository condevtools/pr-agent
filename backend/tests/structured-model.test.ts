import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { withModelExecutionContext, type ModelRequestIntent } from "../src/harness/model-execution-context.js";
import { createStructuredModel } from "../src/review/structured-model.js";
import { createAiConcurrencyLimiter } from "../src/review/ai-concurrency.js";
import type { OpenAIClientCache } from "../src/review/ai-client-cache.js";
import { deepRoleTurnJsonSchema, deepRoleTurnResponseSchema } from "../src/agents/role-loop.js";
import { deepCriticJsonSchema, deepCriticResponseSchema } from "../src/agents/critic.js";

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
      schemaName: "bounded", jsonSchema: { type: "object" },
      schema: z.object({ ok: z.boolean() }).strict(),
      systemPrompt: "system", prompt: "prompt", role: "security", turn: 1,
      maxInputBytes: 10_000, maxOutputTokens: 7,
    }));
    assert.deepEqual(result, { ok: true });
    assert.equal(intents[0]?.maxOutputTokens, 7);
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
    const role = await model.generate({ schemaName: "role", jsonSchema: deepRoleTurnJsonSchema as unknown as Record<string, unknown>,
      schema: deepRoleTurnResponseSchema, systemPrompt: "system", prompt: "prompt", role: "security", turn: 1,
      maxInputBytes: 100_000, maxOutputTokens: 100 });
    const critic = await model.generate({ schemaName: "critic", jsonSchema: deepCriticJsonSchema as unknown as Record<string, unknown>,
      schema: deepCriticResponseSchema, systemPrompt: "system", prompt: "prompt", role: "critic", turn: 1,
      maxInputBytes: 100_000, maxOutputTokens: 100 });

    assert.deepEqual(role, { action: "finish", candidates: [{ severity: "medium", title: "Issue", body: "Body",
      location: { path: "src/a.ts", side: "new", startLine: 1, endLine: 1 },
      evidenceIds: ["evidence"], crossFileEvidenceIds: [] }] });
    assert.deepEqual(critic, { decisions: [{ candidateId: "candidate", decision: "accept", reasonCode: "supported" }] });
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
