import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubIssueCommentCommand } from "../../src/commands/platforms/github/handler.js";
import { runGitLabWebhook } from "../../src/integrations/gitlab/webhooks/adapter.js";

test("postgres comment ingress ignores ordinary human content before database or permission lookup", async () => {
  const previousMode = process.env.HARNESS_PUBLICATION_MODE;
  process.env.HARNESS_PUBLICATION_MODE = "postgres";
  let permissionReads = 0;
  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    octokit: {
      repos: {
        getContent: async () => ({ data: [] }),
        getCollaboratorPermissionLevel: async () => {
          permissionReads += 1;
          return { data: { permission: "admin" } };
        },
      },
      pulls: { get: async () => ({ data: {} }), listFiles: async () => ({ data: [] }),
        createReviewComment: async () => ({}), update: async () => ({}) },
      issues: { createComment: async () => ({ data: { id: 1 } }), updateComment: async () => ({}) },
      paginate: async () => [],
    },
  };
  try {
    const github = await handleGitHubIssueCommentCommand({
      context: context as never,
      owner: "acme",
      repo: "demo",
      issueNumber: 7,
      body: "LGTM",
      commentUser: { type: "User", login: "alice" },
      rateLimitPlatform: "github-app",
      throwOnError: true,
    });
    assert.deepEqual(github, { ok: true, message: "ignored issue_comment content" });

    const gitlab = await runGitLabWebhook({
      payload: {
        object_kind: "note",
        project: { id: 1, name: "demo", web_url: "https://gitlab.example/acme/demo", path_with_namespace: "acme/demo" },
        user: { id: 2, username: "alice" },
        object_attributes: { action: "create", noteable_type: "MergeRequest", note: "LGTM" },
      } as never,
      headers: {},
      logger: { info: () => undefined, error: () => undefined },
      skipSecurityVerification: true,
    });
    assert.deepEqual(gitlab, { ok: true, message: "ignored note content" });
    assert.equal(permissionReads, 0);
  } finally {
    if (previousMode === undefined) delete process.env.HARNESS_PUBLICATION_MODE;
    else process.env.HARNESS_PUBLICATION_MODE = previousMode;
  }
});
