import assert from "node:assert/strict";
import test from "node:test";

import { clearDuplicateRequestState } from "../../support/runtime-state-test-api.ts";
import { runGitLabReview } from "../../../src/review/platforms/gitlab/workflow.js";
import { runGitLabWebhook } from "../../../src/integrations/gitlab/webhooks/adapter.js";

function buildDraftMergeRequestPayload() {
  return {
    object_kind: "merge_request",
    project: {
      id: 11,
      name: "demo",
      web_url: "https://gitlab.example.com/acme/demo",
      path_with_namespace: "acme/demo",
    },
    object_attributes: {
      action: "update",
      iid: 12,
      title: "Draft: add new webhook flow",
      source_branch: "feat/draft",
      target_branch: "main",
      url: "https://gitlab.example.com/acme/demo/-/merge_requests/12",
      last_commit: {
        id: "head-sha-1",
      },
    },
    user: {
      username: "alice",
    },
  };
}

const logger = {
  info: () => undefined,
  error: () => undefined,
};

test("gitlab webhook ignores x-ai-mode when auto-review policy is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  const originalToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_HTTP_RETRIES = "0";
  process.env.GITLAB_TOKEN = "server-token";
  clearDuplicateRequestState();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (decodeURIComponent(url).includes("/repository/files/.pr-agent.yml/raw?ref=main")) {
      return new Response(["review:", "  enabled: false", "  mode: comment"].join("\n"), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const payload = buildDraftMergeRequestPayload();

    const withoutHeader = await runGitLabWebhook({
      payload: payload as never,
      headers: {
        "x-gitlab-api-token": "token",
      },
      logger,
      skipSecurityVerification: true,
    });
    assert.equal(withoutHeader.message, "merge_request action ignored by review policy");

    const withHeaderOverride = await runGitLabWebhook({
      payload: payload as never,
      headers: {
        "x-gitlab-api-token": "token",
        "x-ai-mode": "comment",
      },
      logger,
      skipSecurityVerification: true,
    });
    assert.equal(withHeaderOverride.message, "merge_request action ignored by review policy");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
    if (originalToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = originalToken;
    clearDuplicateRequestState();
  }
});

test("gitlab review dedupe key ignores x-ai-mode header value", async () => {
  clearDuplicateRequestState();
  const originalToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "server-token";

  try {
    const payload = buildDraftMergeRequestPayload();
    const headers = {
      "x-gitlab-api-token": "token",
    };

    const firstComment = await runGitLabReview({
      payload: payload as never,
      headers: {
        ...headers,
        "x-ai-mode": "comment",
      },
      logger,
      trigger: "pr-synchronize",
      dedupeSuffix: payload.object_attributes.last_commit.id,
    });
    assert.equal(firstComment.message, "draft merge request skipped");

    const reportMode = await runGitLabReview({
      payload: payload as never,
      headers: {
        ...headers,
        "x-ai-mode": "report",
      },
      logger,
      trigger: "pr-synchronize",
      dedupeSuffix: payload.object_attributes.last_commit.id,
    });
    assert.equal(reportMode.message, "duplicate request ignored");

    const secondComment = await runGitLabReview({
      payload: payload as never,
      headers: {
        ...headers,
        "x-ai-mode": "comment",
      },
      logger,
      trigger: "pr-synchronize",
      dedupeSuffix: payload.object_attributes.last_commit.id,
    });
    assert.equal(secondComment.message, "duplicate request ignored");
  } finally {
    if (originalToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = originalToken;
    clearDuplicateRequestState();
  }
});
