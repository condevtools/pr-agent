import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import type { OpenAIClientCache } from "../../src/model/client-cache.js";
import { createAiConcurrencyLimiter } from "../../src/model/concurrency.js";
import {
  type ModelRequestIntent,
  withModelExecutionContext,
} from "../../src/model/execution-context.js";
import type { ModelRuntime } from "../../src/model/runtime.js";
import { analyzePullRequest } from "../../src/review/standard/reviewer.js";

test("production adapters cannot bypass the model gateway provider dispatch", () => {
  const sourceRoot = join(process.cwd(), "src");
  const forbidden = /\b(?:callAnthropicJson|callGeminiJson|callOpenAIJsonWithFallback)\b/;
  const violations: string[] = [];
  for (const path of typeScriptFiles(sourceRoot)) {
    if (path.includes(`${join("src", "model")}/`) || path.includes(`${join("src", "model")}\\`)) {
      continue;
    }
    if (forbidden.test(readFileSync(path, "utf8"))) {
      violations.push(relative(sourceRoot, path));
    }
  }
  assert.deepEqual(violations, []);
});

test("Single Review uses the model gateway and preserves its request attribution", async () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalModel = process.env.AI_MODEL;
  const originalKey = process.env.OPENAI_API_KEY;
  const intents: ModelRequestIntent[] = [];
  let transportCalls = 0;
  process.env.AI_PROVIDER = "openai";
  process.env.AI_MODEL = "single-review-fixture";
  process.env.OPENAI_API_KEY = "test-key";
  const clientCache = {
    get: () => ({
      chat: {
        completions: {
          create: async () => {
            transportCalls += 1;
            return {
              id: "response-1",
              model: "single-review-fixture",
              choices: [{ message: { content: JSON.stringify({
                summary: "Looks good",
                riskLevel: "low",
                reviews: [],
                positives: ["Focused change"],
                actionItems: [],
              }) } }],
            };
          },
        },
      },
    }),
  } as unknown as OpenAIClientCache;
  const runtime: ModelRuntime = {
    clock: { now: () => 0 },
    clientCache,
    concurrencyLimiter: createAiConcurrencyLimiter(),
  };

  try {
    const result = await withModelExecutionContext({
      async execute(intent, transport) {
        intents.push(intent);
        return (await transport()).value;
      },
    }, () => analyzePullRequest({
      platform: "github",
      repository: "acme/demo",
      number: 12,
      title: "Small change",
      body: "Updates one behavior",
      author: "alice",
      baseBranch: "main",
      headBranch: "feature",
      additions: 1,
      deletions: 0,
      changedFilesCount: 1,
      changedFiles: [],
    }, { runtime }));

    assert.equal(result.summary, "Looks good");
    assert.equal(transportCalls, 1);
    assert.equal(intents[0]?.requestKind, "single-review:json-schema");
    assert.deepEqual(intents[0]?.metadata, {
      schemaName: "pr_review",
      tokenParameter: "max_completion_tokens",
    });
  } finally {
    restoreEnv("AI_PROVIDER", originalProvider);
    restoreEnv("AI_MODEL", originalModel);
    restoreEnv("OPENAI_API_KEY", originalKey);
  }
});

test("Single Review fails closed before provider transport without a Run context", async () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalModel = process.env.AI_MODEL;
  const originalKey = process.env.OPENAI_API_KEY;
  let transportCalls = 0;
  process.env.AI_PROVIDER = "openai";
  process.env.AI_MODEL = "single-review-fixture";
  process.env.OPENAI_API_KEY = "test-key";
  const runtime: ModelRuntime = {
    clock: { now: () => 0 },
    clientCache: {
      get: () => ({ chat: { completions: { create: async () => {
        transportCalls += 1;
        throw new Error("must not run");
      } } } }),
    } as unknown as OpenAIClientCache,
    concurrencyLimiter: createAiConcurrencyLimiter(),
  };

  try {
    await assert.rejects(analyzePullRequest({
      platform: "github", repository: "acme/demo", number: 12, title: "Small change",
      body: "Updates one behavior", author: "alice", baseBranch: "main", headBranch: "feature",
      additions: 1, deletions: 0, changedFilesCount: 1, changedFiles: [],
    }, { runtime }), /requires a Run execution context/);
    assert.equal(transportCalls, 0);
  } finally {
    restoreEnv("AI_PROVIDER", originalProvider);
    restoreEnv("AI_MODEL", originalModel);
    restoreEnv("OPENAI_API_KEY", originalKey);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function* typeScriptFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* typeScriptFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield path;
  }
}
