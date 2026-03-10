import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubWebhookEvent } from "../src/integrations/github/github-webhook.ts";
import { clearDuplicateRequestState } from "../src/testing/runtime-state-test-api.ts";

const logger = {
  info: () => undefined,
  error: () => undefined,
};

function withIssueAutoTriageEnv(
  fn: () => Promise<void>,
): Promise<void> {
  const original = {
    PR_AGENT_LOCALE: process.env.PR_AGENT_LOCALE,
    GITHUB_ISSUE_AUTO_TRIAGE_ENABLED: process.env.GITHUB_ISSUE_AUTO_TRIAGE_ENABLED,
    GITHUB_ISSUE_AUTO_TRIAGE_AUTO_LABELS: process.env.GITHUB_ISSUE_AUTO_TRIAGE_AUTO_LABELS,
    GITHUB_ISSUE_TRIAGE_DISABLE_AI: process.env.GITHUB_ISSUE_TRIAGE_DISABLE_AI,
  };

  process.env.PR_AGENT_LOCALE = "en";
  process.env.GITHUB_ISSUE_AUTO_TRIAGE_ENABLED = "true";
  process.env.GITHUB_ISSUE_AUTO_TRIAGE_AUTO_LABELS = "true";
  process.env.GITHUB_ISSUE_TRIAGE_DISABLE_AI = "true";

  return fn().finally(() => {
    process.env.PR_AGENT_LOCALE = original.PR_AGENT_LOCALE;
    process.env.GITHUB_ISSUE_AUTO_TRIAGE_ENABLED =
      original.GITHUB_ISSUE_AUTO_TRIAGE_ENABLED;
    process.env.GITHUB_ISSUE_AUTO_TRIAGE_AUTO_LABELS =
      original.GITHUB_ISSUE_AUTO_TRIAGE_AUTO_LABELS;
    process.env.GITHUB_ISSUE_TRIAGE_DISABLE_AI = original.GITHUB_ISSUE_TRIAGE_DISABLE_AI;
  });
}

test("github issues webhook auto-triages issue and labels when .pr-agent.yml is missing", async () => {
  clearDuplicateRequestState();
  const postedComments: string[] = [];
  const postedLabels: string[][] = [];

  await withIssueAutoTriageEnv(async () => {
    const result = await handleGitHubWebhookEvent({
      eventName: "issues",
      payload: {
        action: "opened",
        repository: {
          name: "demo",
          owner: { login: "acme" },
          default_branch: "main",
        },
        issue: {
          number: 2,
          title: "bug: dynamic icon name can crash at runtime",
          body: [
            "## Summary",
            "Dynamic icon rendering can crash with an undefined component symbol.",
            "",
            "## Steps to Reproduce",
            "1. Render `<Icon name=\"Company\" />`.",
            "2. Open the target page.",
            "",
            "## Expected Behavior",
            "Icon should render without runtime failures.",
          ].join("\n"),
          user: { login: "alice" },
        },
      },
      octokit: {
        repos: {
          getContent: async ({ path }: { path: string }) => {
            throw new Error(`not found: ${path}`);
          },
        },
        pulls: {
          get: async () => {
            throw new Error("not expected");
          },
          listFiles: async () => ({ data: [] }),
          createReviewComment: async () => ({}),
          update: async () => ({}),
        },
        issues: {
          listForRepo: async () => ({
            data: [
              {
                number: 101,
                title: "icon name unresolved causes runtime error",
                body: "rendering icon map throws undefined symbol",
                state: "open",
                html_url: "https://github.com/acme/demo/issues/101",
              },
            ],
          }),
          createComment: async ({ body }: { body: string }) => {
            postedComments.push(body);
            return { data: { id: 1 } };
          },
          updateComment: async () => ({}),
          addLabels: async ({ labels }: { labels: string[] }) => {
            postedLabels.push(labels);
            return {};
          },
        },
        paginate: async () => [],
      } as never,
      logger,
      runtimeMode: "github-webhook",
    });

    assert.equal(result.ok, true);
    assert.equal(result.message, "issue policy check triggered");
    assert.equal(postedComments.length, 1);
    assert.match(postedComments[0] ?? "", /## AI Issue Triage/);
    assert.match(postedComments[0] ?? "", /Similar Issues/);
    assert.match(postedComments[0] ?? "", /issues\/101/);
    assert.equal(postedLabels.length, 1);
    assert.ok((postedLabels[0] ?? []).includes("bug"));
    assert.ok((postedLabels[0] ?? []).includes("has-similar-issue"));
    assert.ok((postedLabels[0] ?? []).includes("ai-triaged"));
  });

  clearDuplicateRequestState();
});

test("github issues webhook skips auto-triage when .pr-agent.yml exists", async () => {
  clearDuplicateRequestState();
  const postedComments: string[] = [];
  const postedLabels: string[][] = [];
  let listForRepoCalls = 0;

  await withIssueAutoTriageEnv(async () => {
    const result = await handleGitHubWebhookEvent({
      eventName: "issues",
      payload: {
        action: "edited",
        repository: {
          name: "demo-config",
          owner: { login: "acme" },
          default_branch: "main",
        },
        issue: {
          number: 3,
          title: "feature: add keyboard shortcut",
          body: "Add cmd+k shortcut for global search.",
        },
      },
      octokit: {
        repos: {
          getContent: async ({ path }: { path: string }) => {
            if (path === ".pr-agent.yml") {
              return {
                data: {
                  type: "file",
                  content: Buffer.from(
                    "mode: remind\nissue:\n  enabled: false\n",
                    "utf8",
                  ).toString("base64"),
                  encoding: "base64",
                },
              };
            }
            throw new Error(`not found: ${path}`);
          },
        },
        pulls: {
          get: async () => {
            throw new Error("not expected");
          },
          listFiles: async () => ({ data: [] }),
          createReviewComment: async () => ({}),
          update: async () => ({}),
        },
        issues: {
          listForRepo: async () => {
            listForRepoCalls += 1;
            return { data: [] };
          },
          createComment: async ({ body }: { body: string }) => {
            postedComments.push(body);
            return { data: { id: 1 } };
          },
          updateComment: async () => ({}),
          addLabels: async ({ labels }: { labels: string[] }) => {
            postedLabels.push(labels);
            return {};
          },
        },
        paginate: async () => [],
      } as never,
      logger,
      runtimeMode: "github-webhook",
    });

    assert.equal(result.ok, true);
    assert.equal(result.message, "issue policy check triggered");
    assert.equal(postedComments.length, 0);
    assert.equal(postedLabels.length, 0);
    assert.equal(listForRepoCalls, 0);
  });

  clearDuplicateRequestState();
});
