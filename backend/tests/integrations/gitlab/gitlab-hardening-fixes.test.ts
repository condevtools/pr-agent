import assert from "node:assert/strict";
import test from "node:test";

import { handlePlainGitHubWebhook } from "../../../src/integrations/github/webhooks/handler.ts";
import { parseGitLabReviewPolicyConfig } from "../../../src/review/policy/gitlab.js";
import { runGitLabWebhook } from "../../../src/integrations/gitlab/webhooks/adapter.js";

test("gitlab policy parser accepts quoted mode/boolean values", () => {
  const policy = parseGitLabReviewPolicyConfig(
    [
      "review:",
      '  mode: "comment"',
    ].join("\n"),
  );

  assert.equal(policy.mode, "comment");
});

test("plain github webhook forbids signature-skip mode in production", async () => {
  const originalSkip = process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalToken = process.env.GITHUB_WEBHOOK_TOKEN;
  process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = "true";
  process.env.NODE_ENV = "production";
  process.env.GITHUB_WEBHOOK_TOKEN = "token";

  try {
    await assert.rejects(
      handlePlainGitHubWebhook({
        payload: {},
        rawBody: "{}",
        headers: {
          "x-github-event": "issues",
        },
        logger: {
          info: () => undefined,
          error: () => undefined,
        },
      }),
      /GITHUB_WEBHOOK_SKIP_SIGNATURE.*production/i,
    );
  } finally {
    process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = originalSkip;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.GITHUB_WEBHOOK_TOKEN = originalToken;
  }
});

test("gitlab webhook rejects insecure http base url by default", async () => {
  const originalBaseUrl = process.env.GITLAB_BASE_URL;
  const originalAllowInsecure = process.env.ALLOW_INSECURE_GITLAB_HTTP;
  process.env.GITLAB_BASE_URL = "http://gitlab.example.com";
  delete process.env.ALLOW_INSECURE_GITLAB_HTTP;

  try {
    await assert.rejects(
      runGitLabWebhook({
        payload: {
          object_kind: "merge_request",
          project: {
            id: 1,
            name: "demo",
            web_url: "https://gitlab.example.com/acme/demo",
          },
          object_attributes: {
            action: "update",
            iid: 12,
            source_branch: "feat/x",
            target_branch: "main",
          },
          user: {
            username: "alice",
          },
        },
        headers: {
          "x-gitlab-api-token": "token",
        },
        logger: {
          info: () => undefined,
          error: () => undefined,
        },
        skipSecurityVerification: true,
      }),
      /insecure.*http.*gitlab/i,
    );
  } finally {
    process.env.GITLAB_BASE_URL = originalBaseUrl;
    process.env.ALLOW_INSECURE_GITLAB_HTTP = originalAllowInsecure;
  }
});
