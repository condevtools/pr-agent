import assert from "node:assert/strict";
import test from "node:test";

import { publishGitHubIssueCommentDurably } from "../src/integrations/github/github-publication.js";
import { publishGitLabNoteDurably } from "../src/integrations/gitlab/gitlab-publication.js";

const previousMode = process.env.HARNESS_PUBLICATION_MODE;

test("durable GitHub publication refuses an unplanned provider write", async () => {
  process.env.HARNESS_PUBLICATION_MODE = "postgres";
  let publishes = 0;
  const runtime = runtimeFor("github", () => { publishes += 1; });
  await assert.rejects(
    publishGitHubIssueCommentDurably({
      runtime: runtime as never,
      context: {
        octokit: {
          pulls: { get: async () => ({ data: { id: 42, head: { sha: "head" } } }) },
        },
      } as never,
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      revision: "head",
      slot: "review-report",
      body: "review",
    }),
    /durable publication must be planned as a frozen batch operation/,
  );
  assert.equal(publishes, 0);
});

test("durable GitLab publication refuses an unplanned provider write", async () => {
  process.env.HARNESS_PUBLICATION_MODE = "postgres";
  let publishes = 0;
  const runtime = runtimeFor("gitlab", () => { publishes += 1; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 84 });
  try {
    await assert.rejects(
      publishGitLabNoteDurably({
        runtime: runtime as never,
        token: "test-token",
        target: { baseUrl: "https://gitlab.example.test", projectId: 10, mrId: 8 },
        revision: "head",
        slot: "review-report",
        body: "review",
      }),
      /durable publication must be planned as a frozen batch operation/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(publishes, 0);
});

test("isolated legacy fixtures retain the direct publication fallback", async () => {
  process.env.HARNESS_PUBLICATION_MODE = "legacy";
  let publishes = 0;
  const runtime = runtimeFor("github", () => { publishes += 1; });
  const result = await publishGitHubIssueCommentDurably({
    runtime: runtime as never,
    context: {
      octokit: {
        pulls: { get: async () => ({ data: { id: 42, head: { sha: "head" } } }) },
      },
    } as never,
    owner: "acme",
    repo: "widgets",
    pullNumber: 7,
    revision: "head",
    slot: "review-report",
    body: "review",
  });
  assert.equal(result.remoteId, "legacy-fixture");
  assert.equal(publishes, 1);
  process.env.HARNESS_PUBLICATION_MODE = previousMode;
});

function runtimeFor(platform: "github" | "gitlab", onPublish: () => void) {
  return {
    service: {
      publish: async () => {
        onPublish();
        return {
          businessOperationId: "legacy-fixture",
          marker: "legacy-fixture",
          remoteId: "legacy-fixture",
          reused: false,
          reconciled: false,
        };
      },
    },
    scope: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      integrationId: "22222222-2222-4222-8222-222222222222",
      platform,
      origin: platform === "github" ? "https://api.github.com" : "https://gitlab.example.test",
      repository: "acme/widgets",
      authorityGeneration: 1,
    },
    binding: {
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "11111111-1111-4111-8111-111111111111",
      platform,
      origin: platform === "github" ? "https://api.github.com" : "https://gitlab.example.test",
      repository: "acme/widgets",
      providerRepositoryId: 10,
      providerActorId: 20,
      credentialRef: "env:TOKEN",
      generation: 1,
      version: 1,
      state: "active",
    },
  };
}
