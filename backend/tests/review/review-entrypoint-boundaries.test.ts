import assert from "node:assert/strict";
import test from "node:test";

import { enqueueGitHubReview, executeGitHubReview } from "../../src/review/platforms/github/workflow.js";
import { executeGitLabReview } from "../../src/review/platforms/gitlab/workflow.js";
import { withRunExecutionContext } from "../../src/agent-runtime/execution/run-context.js";

test("provider review execution entries reject calls without a leased worker before side effects", async () => {
  let providerReads = 0;
  const executionRuntime = {
    binding: { platform: "github" },
  };

  await assert.rejects(
    executeGitHubReview({
      context: {
        repo: () => ({ owner: "acme", repo: "demo" }),
        octokit: new Proxy({}, { get: () => { providerReads += 1; return undefined; } }),
        log: { info: () => undefined, error: () => undefined },
      } as never,
      pullNumber: 7,
      mode: "report",
      trigger: "comment-command",
      sourceKey: "test:github",
      sourceHash: "hash",
      publicationRuntime: executionRuntime as never,
    }),
    /leased worker/i,
  );

  await assert.rejects(
    executeGitLabReview({
      payload: {
        object_kind: "merge_request",
        project: { id: 1, name: "demo", path_with_namespace: "acme/demo", web_url: "https://gitlab.example/acme/demo" },
        object_attributes: { iid: 7, action: "update", title: "demo", source_branch: "feature", target_branch: "main" },
      } as never,
      headers: {},
      logger: { info: () => undefined, error: () => undefined },
      sourceKey: "test:gitlab",
      sourceHash: "hash",
      publicationRuntime: { ...executionRuntime, binding: { platform: "gitlab" } } as never,
    }),
    /leased worker/i,
  );

  assert.equal(providerReads, 0);
});

test("public review enqueue does not switch to execution inside an AsyncLocalStorage context", async () => {
  let providerReads = 0;
  await assert.rejects(
    withRunExecutionContext({
      lease: { runId: "run-1" } as never,
      assertActive: async () => undefined,
      step: async (_key, _kind, _inputHash, action) => action(),
    }, () => enqueueGitHubReview({
      context: {
        repo: () => ({ owner: "acme", repo: "demo" }),
        octokit: new Proxy({}, { get: () => { providerReads += 1; return undefined; } }),
        log: { info: () => undefined, error: () => undefined },
      } as never,
      pullNumber: 7,
      mode: "report",
      trigger: "comment-command",
      publicationRuntime: { binding: { platform: "github" } } as never,
    })),
    /authenticated source identity/i,
  );
  assert.equal(providerReads, 0);
});
