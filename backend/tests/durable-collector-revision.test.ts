import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { runGitLabReview } from "../src/review/platforms/gitlab/workflow.js";
import { ReviewRunRevisionChangedError, withRunExecutionContext } from "../src/agent-runtime/execution/run-context.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";

test("durable GitLab collection rejects changed diff refs before reading guidelines or running the model", async () => {
  const previousFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith("/api/v4/projects/101/merge_requests/42/changes")) {
      return Response.json({
        diff_refs: { base_sha: "base-sha", head_sha: "head-moved", start_sha: "start-sha" },
        changes: [{ old_path: "src/value.ts", new_path: "src/value.ts", diff: "@@ -0,0 +1 @@\n+value" }],
      });
    }
    throw new Error(`unexpected request after revision mismatch: ${url}`);
  }) as typeof fetch;

  const lease = fixtureLease();
  let modelSteps = 0;
  try {
    await assert.rejects(
      withRunExecutionContext({
        lease,
        assertActive: async () => undefined,
        step: async (_key, kind, _inputHash, action) => {
          if (kind === "model") modelSteps += 1;
          return action();
        },
      }, () => runGitLabReview({
        payload: {
          object_kind: "merge_request",
          user: { username: "alice" },
          project: { id: 101, name: "repo", path_with_namespace: "acme/repo", web_url: "https://gitlab.example.test/acme/repo" },
          object_attributes: { iid: 42, action: "update", state: "opened", title: "Revision test",
            description: "", url: "https://gitlab.example.test/acme/repo/-/merge_requests/42",
            source_branch: "feature", target_branch: "main", draft: false,
            last_commit: { id: "head-sha" } },
        },
        headers: {}, logger: { info: () => undefined, error: () => undefined },
        mode: "report", trigger: "comment-command", includeCiChecks: false,
        enableSecretScan: false, enableAutoLabel: false,
        sourceKey: "gitlab-durable-revision", sourceHash: hash("gitlab-durable-revision"),
        publicationRuntime: {
          binding: { id: lease.integrationId, tenantId: lease.tenantId, platform: "gitlab",
            origin: "https://gitlab.example.test", repository: "acme/repo", providerRepositoryId: 101,
            providerActorId: 202, credentialRef: "env:GITLAB_TOKEN", generation: 1, version: 1,
            state: "active", reviewExecutionMode: "harness_async", executionModeGeneration: 1 },
          scope: { tenantId: lease.tenantId, integrationId: lease.integrationId, platform: "gitlab",
            origin: "https://gitlab.example.test", repository: "acme/repo", authorityGeneration: 1 },
          resolveCredential: async () => "local-token",
          batchStore: { findBySource: async () => undefined },
          batchCoordinator: {}, createAdapter: async () => { throw new Error("must not publish"); },
        } as never,
        throwOnError: true,
      })),
      ReviewRunRevisionChangedError,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(modelSteps, 0);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/changes$/);
});

function fixtureLease(): RunLease {
  const digest = hash("version");
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    integrationId: "00000000-0000-4000-8000-000000000003",
    jobId: "00000000-0000-4000-8000-000000000004",
    owner: "fixture-worker", epoch: 1, jobAttempt: 1, authorityGeneration: 1,
    executionModeGeneration: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    baseSha: "base-sha", headSha: "head-sha", workflowVersionHash: digest,
    promptVersionHash: digest, modelVersionHash: digest, toolVersionHash: digest,
    policyVersionHash: digest, runtimeVersionHash: digest, input: {}, limits: {}, runtimeConfig: {},
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
