import assert from "node:assert/strict";
import test from "node:test";

import { clearDuplicateRequestState } from "../src/testing/runtime-state-test-api.ts";
import { runGitLabReview, runGitLabWebhook } from "../src/integrations/gitlab/gitlab-review.ts";

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

test("gitlab webhook allows x-ai-mode override even when auto-review policy is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  process.env.GITLAB_HTTP_RETRIES = "0";
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
    });
    assert.equal(withoutHeader.message, "merge_request action ignored by review policy");

    const withHeaderOverride = await runGitLabWebhook({
      payload: payload as never,
      headers: {
        "x-gitlab-api-token": "token",
        "x-ai-mode": "comment",
      },
      logger,
    });
    assert.equal(withHeaderOverride.message, "draft merge request skipped");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
    clearDuplicateRequestState();
  }
});

test("gitlab review dedupe key reflects x-ai-mode header value", async () => {
  clearDuplicateRequestState();

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
    assert.equal(reportMode.message, "draft merge request skipped");

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
    clearDuplicateRequestState();
  }
});
