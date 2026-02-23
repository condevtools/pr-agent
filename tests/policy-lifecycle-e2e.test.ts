import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubWebhookEvent } from "../src/integrations/github/github-webhook.ts";
import { clearDuplicateRequestState } from "../src/testing/runtime-state-test-api.ts";

function createWebhookOctokit(params: {
  policyYaml: string;
  onCreateComment: (body: string) => void;
  onCreateCheck: (request: { conclusion?: string; name?: string }) => void;
  onPullGet: () => void;
}) {
  const encoded = Buffer.from(params.policyYaml, "utf8").toString("base64");

  return {
    repos: {
      getContent: async ({ path }: { path: string }) => {
        if (path === ".mr-agent.yml") {
          return {
            data: {
              type: "file",
              content: encoded,
              encoding: "base64",
            },
          };
        }

        throw new Error(`unexpected path: ${path}`);
      },
    },
    pulls: {
      get: async () => {
        params.onPullGet();
        throw new Error("pulls.get should not be called when auto-review is disabled");
      },
      listFiles: async () => ({ data: [] }),
      createReviewComment: async () => ({}),
      update: async () => ({}),
    },
    issues: {
      createComment: async ({ body }: { body: string }) => {
        params.onCreateComment(body);
        return { data: { id: 1 } };
      },
      updateComment: async () => ({}),
    },
    checks: {
      create: async (request: { conclusion?: string; name?: string }) => {
        params.onCreateCheck(request);
        return {};
      },
    },
    paginate: async () => [],
  };
}

const logger = {
  info: () => undefined,
  error: () => undefined,
};

test("github pull_request webhook e2e: enforce mode posts failure check and reminder comment", async () => {
  const originalLocale = process.env.MR_AGENT_LOCALE;
  process.env.MR_AGENT_LOCALE = "en";
  clearDuplicateRequestState();

  const postedComments: string[] = [];
  const postedChecks: Array<{ conclusion?: string; name?: string }> = [];
  let pullGetCalls = 0;

  const octokit = createWebhookOctokit({
    policyYaml: [
      "mode: enforce",
      "pullRequest:",
      "  enabled: true",
      "  minBodyLength: 10",
      "  requiredSections:",
      "    - Summary",
      "review:",
      "  enabled: true",
      "  onOpened: false",
    ].join("\n"),
    onCreateComment: (body) => {
      postedComments.push(body);
    },
    onCreateCheck: (request) => {
      postedChecks.push(request);
    },
    onPullGet: () => {
      pullGetCalls += 1;
    },
  });

  try {
    const result = await handleGitHubWebhookEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: {
          name: "policy-fail",
          owner: { login: "acme" },
          default_branch: "main",
        },
        pull_request: {
          number: 12,
          title: "",
          body: "",
          html_url: "https://github.com/acme/policy-fail/pull/12",
          base: { ref: "main" },
          head: { sha: "head-sha-fail" },
        },
      },
      octokit: octokit as never,
      logger,
      runtimeMode: "github-webhook",
    });

    assert.equal(result.message, "pull_request policy check triggered");
    assert.equal(postedComments.length, 1);
    assert.match(postedComments[0] ?? "", /## MR Agent Flow Guard/);
    assert.match(postedComments[0] ?? "", /PR flow pre-check failed/i);
    assert.equal(postedChecks.length, 1);
    assert.equal(postedChecks[0]?.conclusion, "failure");
    assert.equal(postedChecks[0]?.name, "MR Agent Policy");
    assert.equal(pullGetCalls, 0);
  } finally {
    process.env.MR_AGENT_LOCALE = originalLocale;
    clearDuplicateRequestState();
  }
});

test("github pull_request webhook e2e: enforce mode posts success check for compliant PR body", async () => {
  const originalLocale = process.env.MR_AGENT_LOCALE;
  process.env.MR_AGENT_LOCALE = "en";
  clearDuplicateRequestState();

  const postedComments: string[] = [];
  const postedChecks: Array<{ conclusion?: string; name?: string }> = [];
  let pullGetCalls = 0;

  const octokit = createWebhookOctokit({
    policyYaml: [
      "mode: enforce",
      "pullRequest:",
      "  enabled: true",
      "  minBodyLength: 10",
      "  requiredSections:",
      "    - Summary",
      "review:",
      "  enabled: true",
      "  onOpened: false",
    ].join("\n"),
    onCreateComment: (body) => {
      postedComments.push(body);
    },
    onCreateCheck: (request) => {
      postedChecks.push(request);
    },
    onPullGet: () => {
      pullGetCalls += 1;
    },
  });

  try {
    const result = await handleGitHubWebhookEvent({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: {
          name: "policy-pass",
          owner: { login: "acme" },
          default_branch: "main",
        },
        pull_request: {
          number: 13,
          title: "feat: improve policy checks",
          body: "## Summary\nThis PR includes a complete template body.",
          html_url: "https://github.com/acme/policy-pass/pull/13",
          base: { ref: "main" },
          head: { sha: "head-sha-pass" },
        },
      },
      octokit: octokit as never,
      logger,
      runtimeMode: "github-webhook",
    });

    assert.equal(result.message, "pull_request policy check triggered");
    assert.equal(postedComments.length, 0);
    assert.equal(postedChecks.length, 1);
    assert.equal(postedChecks[0]?.conclusion, "success");
    assert.equal(postedChecks[0]?.name, "MR Agent Policy");
    assert.equal(pullGetCalls, 0);
  } finally {
    process.env.MR_AGENT_LOCALE = originalLocale;
    clearDuplicateRequestState();
  }
});
