import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import {
  PendingPublicationError,
  PublicationDefiniteFailureError,
  PublicationLookupIndeterminateError,
  type PublicationOperation,
} from "../src/agent-runtime/publication/publication.js";
import { createGitHubPublicationAdapter } from "../src/integrations/github/publication/adapter.js";
import { type GitHubPublicationBinding } from "../src/integrations/github/publication/contracts.js";
import type { MinimalGitHubOctokit } from "../src/integrations/github/api/types.js";
import { runGitHubReview } from "../src/review/platforms/github/workflow.js";
import { withRunExecutionContext } from "../src/agent-runtime/execution/run-context.js";

const binding: GitHubPublicationBinding = {
  platform: "github",
  origin: "https://api.github.com",
  repository: "acme/widgets",
  providerRepositoryId: 9001,
  providerActorId: 77,
  credentialRef: "env:GITHUB_TOKEN",
};

test("GitHub reconciliation rejects a copied marker from the wrong actor", async () => {
  const operation = issueOperation();
  const octokit = octokitFixture({
    comments: [{ id: 12, body: rendered(operation), user: { id: 999 } }],
  });
  const adapter = createGitHubPublicationAdapter({ binding, octokit, operation, verifyCredentialIdentity: verifiedActor });

  await assert.rejects(
    adapter.find(operation.marker, operation.payload!, operation),
    (error: unknown) => error instanceof PublicationLookupIndeterminateError && error.code === "github_marker_actor_mismatch",
  );
});

test("GitHub reconciliation requires a freshly verified credential actor", async () => {
  const operation = issueOperation();
  const octokit = octokitFixture({ comments: [{ id: 12, body: rendered(operation), user: { id: 77 } }] });
  const adapter = createGitHubPublicationAdapter({
    binding, octokit, operation,
    verifyCredentialIdentity: async () => ({ actorId: 999, kind: "user-token", login: "attacker" }),
  });
  await assert.rejects(
    adapter.find(operation.marker, operation.payload!, operation),
    (error: unknown) => error instanceof PublicationLookupIndeterminateError && error.code === "github_credential_actor_mismatch",
  );
});

test("GitHub App reconciliation evidence records the verified app and installation identity", async () => {
  const operation = issueOperation();
  const octokit = octokitFixture({ comments: [{ id: 12, body: rendered(operation), user: { id: 77 } }] });
  const adapter = createGitHubPublicationAdapter({
    binding, octokit, operation,
    verifyCredentialIdentity: async () => ({ actorId: 77, kind: "github-app-installation", appId: 501, installationId: 601 }),
  });
  const found = await adapter.find(operation.marker, operation.payload!, operation) as { evidence?: Record<string, unknown> };
  assert.equal(found.evidence?.actorId, 77);
  assert.equal(found.evidence?.appId, 501);
  assert.equal(found.evidence?.installationId, 601);
  assert.equal(found.evidence?.credentialKind, "github-app-installation");
});

test("GitHub reconciliation rejects marker evidence on the wrong target body", async () => {
  const operation = issueOperation();
  const octokit = octokitFixture({
    comments: [{ id: 12, body: `forged\n\n${operation.marker}`, user: { id: 77 } }],
  });
  const adapter = createGitHubPublicationAdapter({ binding, octokit, operation, verifyCredentialIdentity: verifiedActor });

  await assert.rejects(
    adapter.find(operation.marker, operation.payload!, operation),
    (error: unknown) => error instanceof PublicationLookupIndeterminateError && error.code === "github_marker_body_mismatch",
  );
});

test("GitHub reconciliation rejects a repository identity mismatch", async () => {
  const operation = issueOperation();
  const octokit = octokitFixture({ comments: [{ id: 12, body: rendered(operation), user: { id: 77 } }] });
  octokit.repos.get = async () => ({ data: { id: 9999 } });
  const adapter = createGitHubPublicationAdapter({ binding, octokit, operation, verifyCredentialIdentity: verifiedActor });
  await assert.rejects(
    adapter.find(operation.marker, operation.payload!, operation),
    (error: unknown) => error instanceof PublicationLookupIndeterminateError && error.code === "github_repository_identity_mismatch",
  );
});

test("GitHub reconciliation can confirm the frozen comment after head movement and report the new head", async () => {
  const operation = issueOperation();
  const octokit = octokitFixture({ comments: [{ id: 12, body: rendered(operation), user: { id: 77 } }] });
  octokit.pulls.get = async () => ({ data: { id: 4200, number: 42, head: { sha: "head-2" } } as never });
  const adapter = createGitHubPublicationAdapter({ binding, octokit, operation, verifyCredentialIdentity: verifiedActor });
  assert.equal((await adapter.find(operation.marker, operation.payload!, operation))?.id, 12);
  assert.equal(await adapter.currentRevision?.(), "head-2");
});

test("GitHub known 422 is a definite rejection and is not retried", async () => {
  const operation = issueOperation();
  let writes = 0;
  const octokit = octokitFixture({ comments: [] });
  octokit.issues.createComment = async () => {
    writes += 1;
    throw Object.assign(new Error("validation failed"), { status: 422 });
  };
  const adapter = createGitHubPublicationAdapter({ binding, octokit, operation, verifyCredentialIdentity: verifiedActor });

  await assert.rejects(
    adapter.dispatch(operation.marker, operation.payload!, operation),
    (error: unknown) => error instanceof PublicationDefiniteFailureError && error.status === 422,
  );
  assert.equal(writes, 1);
});

test("additive label reconciliation uses convergent read state without actor attribution", async () => {
  const operation = issueOperation({
    kind: "github-add-labels",
    labels: ["ai-reviewed", "security"],
  });
  const octokit = octokitFixture({ comments: [], labels: ["existing", "security", "ai-reviewed"] });
  const adapter = createGitHubPublicationAdapter({ binding, octokit, operation, verifyCredentialIdentity: verifiedActor });

  const found = await adapter.find(operation.marker, operation.payload!, operation) as { id: string; evidence?: Record<string, unknown> };
  assert.equal(found.id, "labels:4200:ai-reviewed,security");
  assert.equal(found.evidence?.actorId, undefined);
  assert.equal(found.evidence?.providerRepositoryId, 9001);
});

test("existing frozen review batch resumes before context collection or model analysis", async () => {
  const originalFetch = globalThis.fetch;
  const previousNotifyUrl = process.env.NOTIFY_WEBHOOK_URL;
  let executions = 0;
  let providerReads = 0;
  let notifications = 0;
  let attachments = 0;
  process.env.NOTIFY_WEBHOOK_URL = "https://notify.invalid/hook";
  globalThis.fetch = async () => { notifications += 1; return new Response(null, { status: 204 }); };
  const existing = {
    id: "batch-1",
    scope: issueOperation().scope,
    sourceKey: "github:delivery:delivery-1",
    sourceHash: "c".repeat(64),
    status: "waiting_reconciliation" as const,
    operations: [],
  };
  const runtime = {
    service: {} as never,
    scope: {
      tenantId: existing.scope.tenantId,
      integrationId: existing.scope.integrationId,
      platform: "github" as const,
      origin: binding.origin,
      repository: binding.repository,
      authorityGeneration: 1,
    },
    binding,
    batchStore: {
      findBySource: async () => existing,
      attachExistingBatchToRun: async (_lease: unknown, batchId: string) => {
        assert.equal(batchId, existing.id);
        attachments += 1;
        return existing;
      },
    },
    batchCoordinator: { execute: async () => {
      assert.equal(attachments, 1);
      executions += 1;
      return { ...existing, status: "succeeded" as const };
    } },
    createAdapter: async () => { throw new Error("adapter should be requested only by the coordinator fixture"); },
  };
  const context = {
    repo: () => ({ owner: "acme", repo: "widgets" }),
    octokit: new Proxy({}, { get: () => { providerReads += 1; throw new Error("provider context collection must not run"); } }),
    log: { info: () => undefined, error: () => undefined },
  };

  try {
    await withRunExecutionContext({
      lease: {
        tenantId: existing.scope.tenantId, integrationId: existing.scope.integrationId,
        runId: "run-1", jobId: "job-1", owner: "worker", epoch: 1, jobAttempt: 1,
        authorityGeneration: 1, executionModeGeneration: 1,
        baseSha: "base", headSha: existing.scope.revision,
      } as never,
      assertActive: async () => undefined,
      step: async (_key, _kind, _inputHash, action) => action(),
    }, () => runGitHubReview({
        context: context as never,
        pullNumber: 42,
        mode: "report",
        trigger: "comment-command",
        publicationRuntime: runtime as never,
        sourceKey: existing.sourceKey,
        sourceHash: existing.sourceHash,
      }));
    assert.equal(attachments, 1);
    assert.equal(executions, 1);
    assert.equal(providerReads, 0);
    assert.equal(notifications, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousNotifyUrl === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
    else process.env.NOTIFY_WEBHOOK_URL = previousNotifyUrl;
  }
});

test("two-operation review replay reconciles response loss without model rerun or first redispatch", async () => {
  const savedProvider = process.env.AI_PROVIDER;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedBase = process.env.OPENAI_BASE_URL;
  let modelCalls = 0;
  let coordinatorCalls = 0;
  let firstDispatches = 0;
  let secondDispatches = 0;
  let frozen: any;
  process.env.AI_PROVIDER = "openai-compatible";
  process.env.OPENAI_API_KEY = "pipeline-test-key";
  const server = createServer((_request, response) => {
    modelCalls += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "chatcmpl-pipeline", object: "chat.completion", created: 1, model: "pipeline-test",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ summary: "reviewed", reviews: [] }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("pipeline model server did not bind");
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  const scope = issueOperation().scope;
  const runtime = {
    service: {} as never,
    scope: { tenantId: scope.tenantId, integrationId: scope.integrationId, platform: "github" as const, origin: binding.origin, repository: binding.repository, authorityGeneration: 1 },
    binding,
    batchStore: {
      findBySource: async () => frozen,
      assertLegacyBatchExecution: async () => undefined,
      freeze: async (input: any) => {
        assert.equal(input.operations.length, 2);
        frozen = { id: "pipeline-batch", scope: input.scope, sourceKey: input.sourceKey, sourceHash: input.sourceHash, status: "pending", operations: input.operations };
        return frozen;
      },
    },
    batchCoordinator: {
      execute: async () => {
        coordinatorCalls += 1;
        if (coordinatorCalls === 1) {
          firstDispatches += 1;
          secondDispatches += 1;
          return { ...frozen, status: "waiting_reconciliation" };
        }
        return { ...frozen, status: "succeeded" };
      },
    },
    createAdapter: async () => ({} as never),
  };
  const pull = { id: 424200, number: 4242, title: "feat: pipeline", body: "body", user: { login: "alice" }, draft: false, base: { ref: "main", sha: "base" }, head: { ref: "feature", sha: "head-pipeline" }, additions: 1, deletions: 1, changed_files: 1, html_url: "https://github.com/acme/widgets/pull/4242" };
  const context = {
    repo: () => ({ owner: "acme", repo: "widgets" }),
    log: { info: () => undefined, error: () => undefined },
    octokit: {
      repos: { getContent: async () => ({ data: [] }) },
      pulls: { get: async () => ({ data: pull }), listFiles: async () => ({ data: [] }), createReviewComment: async () => ({ data: { id: 1 } }), update: async () => ({}) },
      issues: { createComment: async () => ({ data: { id: 1 } }), updateComment: async () => ({}), addLabels: async () => ({}) },
      paginate: async () => [{ filename: "src/pipeline.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }],
      getLastListFilesTruncated: () => false,
    },
  };
  const request = { context: context as never, pullNumber: 4242, mode: "report" as const, trigger: "comment-command" as const, publicationRuntime: runtime as never, sourceKey: "github:delivery:pipeline", sourceHash: "e".repeat(64), includeCiChecks: false, enableSecretScan: false, enableAutoLabel: true, throwOnError: true };
  try {
    await assert.rejects(runGitHubReview(request), PendingPublicationError);
    await runGitHubReview(request);
    assert.equal(modelCalls, 1);
    assert.equal(firstDispatches, 1);
    assert.equal(secondDispatches, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreEnv("AI_PROVIDER", savedProvider);
    restoreEnv("OPENAI_API_KEY", savedKey);
    restoreEnv("OPENAI_BASE_URL", savedBase);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function issueOperation(overrides: Record<string, unknown> = {}): PublicationOperation {
  const payload = {
    kind: "github-issue-comment",
    owner: "acme",
    repo: "widgets",
    pullNumber: 42,
    targetId: 4200,
    providerRepositoryId: 9001,
    providerActorId: 77,
    revision: "head-1",
    body: "review body",
    managedMarkerKey: null,
    ...overrides,
  };
  return {
    businessOperationId: "a".repeat(64),
    scope: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      integrationId: "22222222-2222-4222-8222-222222222222",
      platform: "github",
      origin: binding.origin,
      repository: binding.repository,
      target: "42",
      revision: "head-1",
      authorityGeneration: 1,
    },
    slot: "review-report",
    payloadHash: "b".repeat(64),
    payload,
    marker: `<!-- pr-agent-operation:${"a".repeat(64)} -->`,
    status: "unknown",
    attemptCount: 1,
    version: 2,
  };
}

function rendered(operation: PublicationOperation): string {
  return `review body\n\n${operation.marker}`;
}

async function verifiedActor() {
  return { actorId: 77, kind: "user-token" as const, login: "pr-agent-bot" };
}

function octokitFixture(params: {
  comments: Array<{ id: number; body: string; user: { id: number } }>;
  labels?: string[];
}): MinimalGitHubOctokit {
  return {
    repos: {
      get: async () => ({ data: { id: 9001 } }),
      getContent: async () => ({ data: [] }),
    },
    pulls: {
      get: async () => ({ data: { id: 4200, number: 42, head: { sha: "head-1" } } as never }),
      listFiles: async () => ({ data: [] }),
      createReviewComment: async () => ({ data: { id: 1 } }),
      update: async () => ({}),
    },
    issues: {
      get: async () => ({ data: { labels: params.labels ?? [] } }),
      listComments: async () => ({ data: params.comments }),
      createComment: async () => ({ data: { id: 1 } }),
      updateComment: async () => ({}),
      addLabels: async () => ({}),
    },
    paginate: async () => [],
  };
}
