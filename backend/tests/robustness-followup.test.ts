import assert from "node:assert/strict";
import test from "node:test";

import { encodePath } from "../src/core/path.ts";
import {
  createOpenAIClientCache,
} from "../src/review/ai-client-cache.ts";
import {
  buildAskPrompt,
  buildUserPrompt,
  resolveAskSystemPrompt,
  resolveReviewSystemPrompt,
} from "../src/review/ai-reviewer.ts";
import type { PullRequestReviewInput } from "../src/review/review-types.ts";
import { parseRepoPolicyConfig } from "../src/integrations/github/github-policy.ts";
import { parseGitLabReviewPolicyConfig } from "../src/integrations/gitlab/gitlab-review.ts";

const promptFixture: PullRequestReviewInput = {
  platform: "github",
  repository: "acme/demo",
  number: 1,
  title: "feat: add check",
  body: "desc",
  author: "alice",
  baseBranch: "main",
  headBranch: "feat/x",
  additions: 1,
  deletions: 1,
  changedFilesCount: 1,
  changedFiles: [
    {
      newPath: "src/a.ts",
      oldPath: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      extendedDiff: "@@ -1 +1 @@\n-a\n+b",
    },
  ],
};

test("encodePath keeps already-encoded path segments stable", () => {
  assert.equal(encodePath("docs/hello%20world.md"), "docs/hello%20world.md");
  assert.equal(encodePath("nested/a%2Fb.ts"), "nested/a%2Fb.ts");
});

test("ai system prompts follow locale", () => {
  const originalLocale = process.env.PR_AGENT_LOCALE;

  try {
    process.env.PR_AGENT_LOCALE = "en";
    assert.match(resolveReviewSystemPrompt(), /You are a senior code review engineer/i);
    assert.match(resolveAskSystemPrompt(), /You are a senior code review assistant/i);

    process.env.PR_AGENT_LOCALE = "zh";
    assert.match(resolveReviewSystemPrompt(), /你是资深代码评审工程师/);
    assert.match(resolveAskSystemPrompt(), /你是资深代码评审助手/);
  } finally {
    process.env.PR_AGENT_LOCALE = originalLocale;
  }
});

test("ai user prompts follow locale", () => {
  const originalLocale = process.env.PR_AGENT_LOCALE;

  try {
    process.env.PR_AGENT_LOCALE = "en";
    assert.match(buildUserPrompt(promptFixture), /Output requirements:/i);
    assert.match(
      buildAskPrompt(promptFixture, "What changed?"),
      /User question:/i,
    );

    process.env.PR_AGENT_LOCALE = "zh";
    assert.match(buildUserPrompt(promptFixture), /输出要求/);
    assert.match(buildAskPrompt(promptFixture, "发生了什么变化？"), /用户问题/);
  } finally {
    process.env.PR_AGENT_LOCALE = originalLocale;
  }
});

test("openai cache trims and keeps hit entry when max entries shrink", () => {
  const originalMaxEntries = process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES;
  process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES = "2";
  const cache = createOpenAIClientCache();

  try {
    const paramsA = {
      apiKey: "key-a",
      timeout: 1_000,
      maxRetries: 0,
    };
    const paramsB = {
      apiKey: "key-b",
      timeout: 1_000,
      maxRetries: 0,
    };

    const clientA = cache.get(paramsA);
    const clientB = cache.get(paramsB);

    process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES = "1";
    const hitA = cache.get(paramsA);
    assert.equal(hitA, clientA);

    const nextB = cache.get(paramsB);
    assert.notEqual(nextB, clientB);
  } finally {
    cache.clear();
    process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES = originalMaxEntries;
  }
});

test("github policy parses secretScanCustomPatterns", () => {
  const parsed = parseRepoPolicyConfig([
    "review:",
    "  secretScanCustomPatterns:",
    "    - \"x-api-key=[A-Za-z0-9]{16}\"",
  ].join("\n"));

  assert.deepEqual(parsed.review?.secretScanCustomPatterns, [
    "x-api-key=[A-Za-z0-9]{16}",
  ]);
});

test("gitlab policy parses secret_scan_custom_patterns", () => {
  const parsed = parseGitLabReviewPolicyConfig([
    "review:",
    "  secret_scan_custom_patterns:",
    "    - \"x-api-key=[A-Za-z0-9]{16}\"",
  ].join("\n"));

  assert.deepEqual(parsed.secretScanCustomPatterns, [
    "x-api-key=[A-Za-z0-9]{16}",
  ]);
});
