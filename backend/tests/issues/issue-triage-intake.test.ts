import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubWebhookEvent } from "../../src/integrations/github/webhooks/handler.js";
import type { MinimalGitHubOctokit } from "../../src/integrations/github/api/types.js";
import { issueTriageIdentity, type IssueTriageRunInput } from "../../src/issues/triage/input.js";
import { loadIssueTriagePolicy } from "../../src/issues/triage/policy.js";
import type { GitHubReviewContext, LoggerLike } from "../../src/review/platforms/github/contracts.js";

const logger: LoggerLike = {
  info: () => undefined,
  error: () => undefined,
};

test("production issues entry stops at the runtime feature flag before provider or database access", async () => {
  await withEnvironment({ FEATURE_ISSUE_TRIAGE: "off" }, async () => {
    const result = await deliverIssue(openedIssuePayload(), {} as MinimalGitHubOctokit);
    assert.deepEqual(result, { ok: true, message: "ignored Issue triage: disabled" });
  });
});

test("production issues entry ignores bot-authored and closed issues before provider or database access", async () => {
  await withEnvironment({ FEATURE_ISSUE_TRIAGE: "on" }, async () => {
    for (const payload of [
      openedIssuePayload({ sender: { login: "automation", type: "Bot" } }),
      openedIssuePayload({ issue: { user: { login: "dependabot[bot]", type: "User" } } }),
      openedIssuePayload({ issue: { state: "closed" } }),
    ]) {
      assert.deepEqual(await deliverIssue(payload, {} as MinimalGitHubOctokit), {
        ok: true,
        message: "ignored bot or closed issue",
      });
    }
  });
});

test("production issues entry ignores edits unrelated to title or body", async () => {
  await withEnvironment({ FEATURE_ISSUE_TRIAGE: "on" }, async () => {
    const payload = openedIssuePayload({ action: "edited", changes: { labels: { from: [] } } });
    assert.deepEqual(await deliverIssue(payload, {} as MinimalGitHubOctokit), {
      ok: true,
      message: "ignored issue edit without title or body changes",
    });
  });
});

test("production issues entry cannot treat a pull request payload as an Issue", async () => {
  await withEnvironment({ FEATURE_ISSUE_TRIAGE: "on" }, async () => {
    const payload = openedIssuePayload({ issue: { pull_request: { url: "https://api.github.com/pulls/42" } } });
    assert.deepEqual(await deliverIssue(payload, {} as MinimalGitHubOctokit), {
      ok: true,
      message: "ignored issue converted from pull request",
    });
  });
});

test("repository policy supports explicit JSON and YAML Issue triage opt-outs", async () => {
  for (const [name, raw] of [
    ["json", JSON.stringify({ issue: { triageEnabled: false } })],
    ["yaml", "issue:\n  enabled: false\n"],
  ] as const) {
    const policy = await loadIssueTriagePolicy(policyContext(`${name}-optout`, async () => file(raw)));
    assert.deepEqual(policy, { enabled: false, autoLabels: true });
  }

  const labels = await loadIssueTriagePolicy(policyContext("yaml-label-optout",
    async () => file("issue:\n  autoLabelEnabled: false\n")));
  assert.deepEqual(labels, { enabled: true, autoLabels: false });
});

test("an existing repository policy does not disable Issue triage merely by existing", async () => {
  const policy = await loadIssueTriagePolicy(policyContext("unrelated-policy",
    async () => file("review:\n  mode: comment\n")));
  assert.deepEqual(policy, { enabled: true, autoLabels: true });
  assert.deepEqual(await loadIssueTriagePolicy(policyContext("empty-policy", async () => file(""))),
    { enabled: true, autoLabels: true });
});

test("missing repository policies use defaults, while provider and unreadable-file errors fail closed", async () => {
  let reads = 0;
  const missing = await loadIssueTriagePolicy(policyContext("missing-policy", async () => {
    reads += 1;
    throw Object.assign(new Error("not found"), { status: 404 });
  }));
  assert.deepEqual(missing, { enabled: true, autoLabels: true });
  assert.equal(reads, 2, "both supported policy filenames must be checked");

  const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
  await assert.rejects(loadIssueTriagePolicy(policyContext("forbidden-policy", async () => {
    throw forbidden;
  })), (error) => error === forbidden);

  await assert.rejects(loadIssueTriagePolicy(policyContext("directory-policy", async () => ({
    data: { type: "dir" },
  }))), /must be a readable repository file/u);
});

test("invalid Issue policy booleans fail closed", async () => {
  await assert.rejects(loadIssueTriagePolicy(policyContext("invalid-boolean",
    async () => file("issue:\n  triageEnabled: sometimes\n"))), /Issue policy flags must be boolean values/u);
});

test("Issue content identity is stable across webhook deliveries and non-content options", () => {
  const first = { deliveryId: "delivery-a", input: triageInput(true) };
  const redelivery = { deliveryId: "delivery-b", input: triageInput(false) };
  assert.notEqual(first.deliveryId, redelivery.deliveryId);
  assert.notDeepEqual(first.input.options, redelivery.input.options);
  assert.deepEqual(issueTriageIdentity("binding-1", first.input),
    issueTriageIdentity("binding-1", redelivery.input));
});

async function deliverIssue(payload: unknown, octokit: MinimalGitHubOctokit) {
  return handleGitHubWebhookEvent({
    eventName: "issues",
    payload,
    octokit,
    logger,
    runtimeMode: "github-app",
    deliveryId: "delivery-intake-test",
    sourceHash: "f".repeat(64),
  });
}

function openedIssuePayload(overrides: {
  action?: string;
  changes?: Record<string, unknown>;
  sender?: { login?: string; type?: string };
  issue?: Partial<{
    state: string;
    user: { login?: string; type?: string };
    pull_request: unknown;
  }>;
} = {}) {
  return {
    action: overrides.action ?? "opened",
    ...(overrides.changes ? { changes: overrides.changes } : {}),
    sender: overrides.sender ?? { login: "alice", type: "User" },
    repository: { id: 9001, name: "widgets", owner: { login: "acme" }, default_branch: "main" },
    issue: {
      id: 4200,
      number: 42,
      title: "Timeout during token refresh",
      body: "The token refresh request times out consistently.",
      state: "open",
      user: { login: "alice", type: "User" },
      ...overrides.issue,
    },
  };
}

function policyContext(repo: string, getContent: MinimalGitHubOctokit["repos"]["getContent"]): GitHubReviewContext {
  return {
    repo: () => ({ owner: "acme", repo }),
    octokit: { repos: { getContent }, pulls: {} as MinimalGitHubOctokit["pulls"],
      issues: {} as MinimalGitHubOctokit["issues"], checks: {} as MinimalGitHubOctokit["checks"] },
    log: logger,
  };
}

function file(raw: string): Awaited<ReturnType<MinimalGitHubOctokit["repos"]["getContent"]>> {
  return { data: { type: "file", encoding: "base64", content: Buffer.from(raw).toString("base64") } };
}

function triageInput(autoLabels: boolean): IssueTriageRunInput {
  return {
    schemaVersion: 1,
    workflow: "issue.triage.v1",
    platform: "github",
    target: { origin: "https://api.github.com", repository: "acme/widgets",
      providerRepositoryId: 9001, number: 42, issueId: 4200 },
    revision: "a".repeat(64),
    issue: { id: 4200, number: 42, title: "Timeout during token refresh",
      body: "The token refresh request times out consistently.", state: "open",
      user: { id: 7001, login: "alice", type: "User" } },
    options: { autoLabels, locale: autoLabels ? "zh" : "en" },
  };
}

test("an Issue whose author was deleted is acknowledged before provider access", async () => {
  await withEnvironment({ FEATURE_ISSUE_TRIAGE: "on" }, async () => {
    const payload = openedIssuePayload();
    const response = await handleGitHubWebhookEvent({ eventName: "issues",
      payload: { ...payload, issue: { ...payload.issue, user: null } },
      octokit: {} as MinimalGitHubOctokit, logger, runtimeMode: "github-webhook" });
    assert.match(response.message, /without a stable author/u);
  });
});

test("malformed YAML Issue section cannot silently enable paid analysis", async () => {
  await assert.rejects(loadIssueTriagePolicy(policyContext("invalid-section", async () => file("issue: false"))),
    /mapping object/u);
});

async function withEnvironment<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
