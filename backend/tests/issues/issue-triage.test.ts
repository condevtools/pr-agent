import assert from "node:assert/strict";
import test from "node:test";

import type { StructuredModel } from "../../src/model/contracts.js";
import { analyzeIssueTriage, issueTriageResultSchema } from "../../src/issues/triage/analysis.js";
import { collectIssueTriageContext } from "../../src/issues/triage/collection.js";
import { inferIssueTriageLabels, selectExistingIssueLabels } from "../../src/issues/triage/labels.js";
import { renderIssueTriageComment } from "../../src/issues/triage/presentation.js";

const result = { summary: "A bounded summary", feasibility: { level: "medium" as const, reason: "Needs evidence" },
  risks: ["A regression risk"], actions: ["Add a reproduction"] };

test("issue triage runs one bounded structured model role without swallowing failures", async () => {
  const calls: unknown[] = [];
  const model: StructuredModel = { generate: async (request) => { calls.push(request); return result as never; } };
  assert.deepEqual(await analyzeIssueTriage({ issue: { id: 1, number: 2, title: "Timeout", body: "Fails",
    state: "open" }, repository: "acme/widget", similar: [], locale: "en" }, model), result);
  const request = calls[0] as { role: string; turn: number; maxOutputTokens: number; prompt: string };
  assert.equal(request.role, "issue-triage"); assert.equal(request.turn, 1); assert.equal(request.maxOutputTokens, 4096);
  assert.match(request.prompt, /Timeout/u);
  await assert.rejects(analyzeIssueTriage({ issue: { id: 1, number: 2, title: "Timeout", body: "Fails",
    state: "open" }, repository: "acme/widget", similar: [], locale: "en" },
  { generate: async () => { throw new Error("provider down"); } }), /provider down/u);
  assert.equal(issueTriageResultSchema.safeParse({ ...result, risks: [] }).success, false);
});

test("collection excludes PRs and self, bounds similarity, and requires complete label enumeration", async () => {
  const labels = Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` }));
  const context = await collectIssueTriageContext({
    owner: "acme", repo: "widget", issueNumber: 5, title: "auth token timeout", body: "refresh fails",
    octokit: { repos: { getContent: async () => ({ data: [] }) }, pulls: {} as never, issues: {
      createComment: async () => ({ data: { id: 1 } }), updateComment: async () => ({}),
      listForRepo: async () => ({ data: [
        { number: 5, title: "self", html_url: "https://github.com/acme/widget/issues/5" },
        { number: 6, title: "auth token timeout", body: "refresh", state: "open",
          html_url: "https://evil.example/x" },
        { number: 7, title: "auth token PR", html_url: "https://github.com/acme/widget/pull/7", pull_request: {} },
        { number: 8, title: "Update language translations", body: "French strings", state: "open",
          html_url: "https://github.com/acme/widget/issues/8" },
      ] }),
      listLabelsForRepo: async ({ page }: { page: number }) => ({ data: page <= 3 ? labels : [] }),
    } as never },
  });
  assert.deepEqual(context.similar.map(({ id }) => id), [6]);
  assert.equal(context.similar[0]?.url, "https://evil.example/x");
  assert.equal(context.labelsComplete, false); assert.equal(context.coverage.labelsPages, 3);
  assert.deepEqual(selectExistingIssueLabels(["bug"], context.repositoryLabels, context.labelsComplete), []);
});

test("collection preserves repository label spelling after a complete page", async () => {
  const context = await collectIssueTriageContext({ owner: "acme", repo: "widget", issueNumber: 1,
    title: "security bug", body: "token", octokit: {
      repos: { getContent: async () => ({ data: [] }) }, pulls: {} as never,
      issues: { createComment: async () => ({ data: { id: 1 } }), updateComment: async () => ({}),
        listLabelsForRepo: async () => ({ data: [{ name: "Security" }, { name: "BUG" }] }) } as never,
    } });
  assert.equal(context.labelsComplete, true);
  assert.deepEqual(selectExistingIssueLabels(["security", "bug", "missing"], context.repositoryLabels, true),
    ["Security", "BUG"]);
});

test("label inference stays allowlisted and comment neutralizes untrusted markdown and links", () => {
  const similar = [{ id: 9, title: "@all [spoof](https://evil.example)", body: "", state: "open",
    url: "https://evil.example/issues/9", score: 9, matchedTerms: ["token"] }];
  const suggested = inferIssueTriageLabels({ title: "Security bug and docs", body: "token test is slow", similar });
  assert.deepEqual(suggested, ["bug", "documentation", "security", "performance", "testing",
    "has-similar-issue", "ai-triaged"]);
  const body = renderIssueTriageComment({ result: { summary: "<script>@all</script>",
    feasibility: { level: "high", reason: "**possible**" }, risks: ["[click](https://evil.example)\n- injected"],
    actions: ["ping @team"] }, similar, suggestedLabels: suggested, autoLabels: ["Security"],
    labelsComplete: true, revision: "abcdef1234567890", repository: "acme/widget", locale: "en" });
  assert.match(body, /## AI Issue Triage/u); assert.match(body, /https:\/\/github\.com\/acme\/widget\/issues\/9/u);
  assert.doesNotMatch(body, /https:\/\/evil\.example/u); assert.doesNotMatch(body, /<script>/u);
  assert.doesNotMatch(body, /@all/u); assert.doesNotMatch(body, /\n- injected/u); assert.match(body, /abcdef123456/u);
});
