import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeGitHubDurableCommand,
  authorizeGitLabDurableCommand,
  classifyDurableCommand,
} from "../../src/commands/authorization.js";
import { verifyGitLabWebhookToken } from "../../src/integrations/gitlab/webhooks/security.js";
import { requireGitLabToken } from "../../src/integrations/gitlab/repository/context.js";

test("durable command classification preserves platform capabilities", () => {
  assert.equal(classifyDurableCommand("github", "/ai-review"), "review");
  assert.equal(classifyDurableCommand("github", "/improve make this clearer"), "improve");
  assert.equal(classifyDurableCommand("github", "/add_doc"), "add_doc");
  assert.equal(classifyDurableCommand("github", "/improve_component api"), "improve_component");
  assert.equal(classifyDurableCommand("gitlab", "/ai-review"), "review");
  assert.equal(classifyDurableCommand("gitlab", "/improve make this clearer"), undefined);
  assert.equal(classifyDurableCommand("github", "LGTM"), undefined);
});

test("GitHub durable commands require repository write permission", async () => {
  for (const permission of ["write", "maintain", "admin"] as const) {
    await authorizeGitHubDurableCommand({
      owner: "acme",
      repo: "demo",
      login: "alice",
      userId: 42,
      getPermission: async () => permission,
    });
  }
  for (const permission of ["none", "read", "triage"] as const) {
    await assert.rejects(
      authorizeGitHubDurableCommand({
        owner: "acme",
        repo: "demo",
        login: "alice",
        userId: 42,
        getPermission: async () => permission,
      }),
      /write permission/i,
    );
  }
  await assert.rejects(
    authorizeGitHubDurableCommand({
      owner: "acme",
      repo: "demo",
      getPermission: async () => "admin",
    }),
    /identity/i,
  );
});

test("GitLab durable review requires Developer access", async () => {
  for (const accessLevel of [30, 40, 50]) {
    await authorizeGitLabDurableCommand({
      projectId: 12,
      userId: 34,
      getAccessLevel: async () => accessLevel,
    });
  }
  for (const accessLevel of [0, 5, 10, 20]) {
    await assert.rejects(
      authorizeGitLabDurableCommand({
        projectId: 12,
        userId: 34,
        getAccessLevel: async () => accessLevel,
      }),
      /Developer access/i,
    );
  }
  await assert.rejects(
    authorizeGitLabDurableCommand({
      projectId: 12,
      getAccessLevel: async () => 50,
    }),
    /identity/i,
  );
});

test("GitLab webhook and API credentials fail closed on server configuration", () => {
  const previousSecret = process.env.GITLAB_WEBHOOK_SECRET;
  const previousRequired = process.env.GITLAB_REQUIRE_WEBHOOK_SECRET;
  const previousToken = process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_WEBHOOK_SECRET;
  process.env.GITLAB_REQUIRE_WEBHOOK_SECRET = "false";
  delete process.env.GITLAB_TOKEN;
  try {
    assert.throws(
      () => verifyGitLabWebhookToken({ "x-gitlab-token": "request-controlled" }),
      /GITLAB_WEBHOOK_SECRET is required/,
    );
    assert.throws(
      () => requireGitLabToken({ "x-gitlab-api-token": "request-controlled" }),
      /server-side GITLAB_TOKEN/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.GITLAB_WEBHOOK_SECRET;
    else process.env.GITLAB_WEBHOOK_SECRET = previousSecret;
    if (previousRequired === undefined) delete process.env.GITLAB_REQUIRE_WEBHOOK_SECRET;
    else process.env.GITLAB_REQUIRE_WEBHOOK_SECRET = previousRequired;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  }
});
