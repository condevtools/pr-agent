import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicationDefiniteFailureError,
  PublicationPreflightError,
  type PublicationOperation,
} from "../../../src/agent-runtime/publication/publication.js";
import type { MinimalGitHubOctokit } from "../../../src/integrations/github/api/types.js";
import { createRestBackedOctokit } from "../../../src/integrations/github/api/http-client.js";
import { githubIssueRevision, parseGitHubIssue, parseGitHubIssueSubject } from
  "../../../src/integrations/github/issues/identity.js";
import {
  createGitHubPublicationAdapter,
  publishGitHubIssueCommentDurably,
} from "../../../src/integrations/github/publication/adapter.js";
import type { GitHubPublicationBinding } from "../../../src/integrations/github/publication/contracts.js";
import { issueTriageRunInputSchema } from "../../../src/issues/triage/input.js";
import { buildManagedCommentBody } from "../../../src/review/rendering/managed-comments.js";

const binding: GitHubPublicationBinding = {
  platform: "github",
  origin: "https://api.github.com",
  repository: "acme/widgets",
  providerRepositoryId: 9001,
  providerActorId: 77,
  credentialRef: "env:GITHUB_TOKEN",
};

test("ordinary Issue identity is strict and its revision ignores labels and comment metadata", () => {
  const first = parseGitHubIssue(issue({ labels: ["bug"], comments: 1 }));
  const second = parseGitHubIssue(issue({ labels: ["security"], comments: 99, updated_at: "2099-01-01" }));
  assert.equal(githubIssueRevision(first), githubIssueRevision(second));
  assert.throws(() => parseGitHubIssue(issue({ pull_request: { url: "https://example.test/pr/42" } })));
  assert.throws(() => parseGitHubIssue(issue({ pull_request: null })));
  assert.throws(() => parseGitHubIssue({ ...issue(), user: null }));
  assert.deepEqual(parseGitHubIssueSubject(issue({ user: null })), {
    id: 4200,
    number: 42,
    title: "Broken widget",
    body: "Steps to reproduce",
    state: "open",
  });
});

test("realistic GitHub Issue extras are stripped before strict triage input validation", () => {
  const parsed = parseGitHubIssue(issue({
    html_url: "https://github.com/acme/widgets/issues/42",
    url: "https://api.github.com/repos/acme/widgets/issues/42",
    labels: [{ id: 1, name: "bug", color: "d73a4a" }],
    comments: 7,
    created_at: "2026-10-31T00:00:00Z",
    updated_at: "2026-10-31T01:00:00Z",
    user: {
      id: 88,
      login: "alice",
      type: "User",
      avatar_url: "https://avatars.githubusercontent.com/u/88",
      site_admin: false,
    },
  }));

  assert.deepEqual(parsed, {
    id: 4200,
    number: 42,
    title: "Broken widget",
    body: "Steps to reproduce",
    state: "open",
    user: { id: 88, login: "alice", type: "User" },
  });
  assert.equal(issueTriageRunInputSchema.safeParse({
    schemaVersion: 1,
    workflow: "issue.triage.v1",
    platform: "github",
    target: { origin: "https://api.github.com", repository: "acme/widgets",
      providerRepositoryId: 9001, number: parsed.number, issueId: parsed.id },
    revision: githubIssueRevision(parsed),
    issue: parsed,
    options: { autoLabels: true, locale: "zh" },
  }).success, true);
});

test("REST client lists repository labels through the bounded labels endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return Response.json([{ name: "bug" }, { name: "" }, { color: "ffffff" }, { name: "Security" }]);
  };
  try {
    const client = createRestBackedOctokit({ token: "test-token", baseUrl: "https://api.github.test" });
    const result = await client.issues.listLabelsForRepo!({ owner: "acme", repo: "widgets", per_page: 100, page: 3 });
    assert.deepEqual(result.data, [{ name: "bug" }, { name: "Security" }]);
    assert.match(requested, /\/repos\/acme\/widgets\/labels\?per_page=100&page=3$/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ordinary Issue planning resolves the immutable Issue target without reading Pull APIs", async () => {
  const current = parseGitHubIssue(issue());
  const revision = githubIssueRevision(current);
  const octokit = fixture({ current });
  let planned: { slot: string; payload: Record<string, unknown> } | undefined;

  await publishGitHubIssueCommentDurably({
    runtime: {
      service: {} as never,
      scope: { tenantId: "11111111-1111-4111-8111-111111111111",
        integrationId: "22222222-2222-4222-8222-222222222222", platform: "github",
        origin: binding.origin, repository: binding.repository, authorityGeneration: 1 },
      binding,
      planOperation: (operation) => { planned = operation; },
    },
    context: { octokit }, owner: "acme", repo: "widgets", pullNumber: 42,
    revision, targetKind: "issue", slot: "issue-triage-comment", body: "triage",
  });

  assert.equal(planned?.slot, "issue-triage-comment");
  assert.deepEqual(planned?.payload, {
    kind: "github-issue-comment", owner: "acme", repo: "widgets", pullNumber: 42,
    targetId: 4200, providerRepositoryId: 9001, providerActorId: 77,
    targetKind: "issue", revision, body: "triage", managedMarkerKey: null,
    managedTargetId: null, managedTargetBodySha256: null,
  });
});

test("ordinary Issue comments and additive labels dispatch without a Pull lookup", async () => {
  const current = parseGitHubIssue(issue());
  const octokit = fixture({ current });
  const comment = operation(current);
  const commentAdapter = createGitHubPublicationAdapter({
    binding, octokit, operation: comment, verifyCredentialIdentity: verifiedActor,
  });
  await commentAdapter.preflight?.(comment.marker, comment.payload!);
  const posted = await commentAdapter.dispatch(comment.marker, comment.payload!, comment);
  assert.equal(posted.id, 501);

  const labels = operation(current, { kind: "github-add-labels", labels: ["bug", "security"] });
  const labelAdapter = createGitHubPublicationAdapter({
    binding, octokit, operation: labels, verifyCredentialIdentity: verifiedActor,
  });
  await labelAdapter.preflight?.(labels.marker, labels.payload!);
  const added = await labelAdapter.dispatch(labels.marker, labels.payload!, labels);
  assert.equal(added.id, "labels:4200:bug,security");
});

test("ordinary Issue preflight rejects a PR, identity mismatch, stale content and closed state", async () => {
  const original = parseGitHubIssue(issue());
  for (const [name, current, code] of [
    ["pull request", { ...issue(), pull_request: { url: "pr" } }, "github_issue_identity_invalid"],
    ["identity mismatch", issue({ id: 9999 }), "github_issue_identity_mismatch"],
    ["stale content", issue({ title: "changed" }), "github_issue_revision_mismatch"],
    ["closed", issue({ state: "closed" }), "github_issue_not_open"],
  ] as const) {
    const frozen = operation(original);
    const adapter = createGitHubPublicationAdapter({
      binding, octokit: fixture({ current }), operation: frozen, verifyCredentialIdentity: verifiedActor,
    });
    await assert.rejects(adapter.preflight?.(frozen.marker, frozen.payload!),
      (error: unknown) => error instanceof PublicationPreflightError && error.code === code, name);
  }
});

test("ordinary Issue targets cannot be used for inline review comments", async () => {
  const current = parseGitHubIssue(issue());
  const frozen = operation(current, {
    kind: "github-inline-comment", path: "src/value.ts", line: 1, side: "RIGHT",
  });
  const adapter = createGitHubPublicationAdapter({
    binding, octokit: fixture({ current }), operation: frozen, verifyCredentialIdentity: verifiedActor,
  });
  await assert.rejects(adapter.preflight?.(frozen.marker, frozen.payload!),
    (error: unknown) => error instanceof PublicationPreflightError
      && error.code === "github_issue_inline_comment_forbidden");
});

test("ordinary Issue reconciliation remains possible after edit while reporting the new revision", async () => {
  const original = parseGitHubIssue(issue());
  const changed = parseGitHubIssue(issue({ title: "changed after dispatch", state: "closed" }));
  const frozen = operation(original);
  const octokit = fixture({ current: changed, comments: [{ id: 501,
    body: `triage\n\n${frozen.marker}`, user: { id: 77 } }] });
  const adapter = createGitHubPublicationAdapter({
    binding, octokit, operation: frozen, verifyCredentialIdentity: verifiedActor,
  });

  assert.equal((await adapter.find(frozen.marker, frozen.payload!, frozen))?.id, 501);
  assert.equal(await adapter.currentRevision?.(), githubIssueRevision(changed));
  assert.notEqual(await adapter.currentRevision?.(), frozen.scope.revision);
});

test("ordinary Issue reconciliation survives a deleted author", async () => {
  const original = parseGitHubIssue(issue());
  const frozen = operation(original);
  const current = issue({ user: null });
  const octokit = fixture({ current, comments: [{ id: 501,
    body: `triage\n\n${frozen.marker}`, user: { id: 77 } }] });
  const adapter = createGitHubPublicationAdapter({
    binding, octokit, operation: frozen, verifyCredentialIdentity: verifiedActor,
  });

  assert.equal((await adapter.find(frozen.marker, frozen.payload!, frozen))?.id, 501);
  assert.equal(await adapter.currentRevision?.(), githubIssueRevision(parseGitHubIssueSubject(current)));
});

test("ordinary Issue managed comment fingerprint remains bound to the publisher actor", async () => {
  const current = parseGitHubIssue(issue());
  const frozen = operation(current, {
    managedMarkerKey: "issue-ai-triage:revision",
    managedTargetId: 501,
    managedTargetBodySha256: "0".repeat(64),
  });
  const octokit = fixture({ current, exactComment: {
    id: 501,
    body: buildManagedCommentBody("old", "issue-ai-triage:revision"),
    user: { id: 999 },
  } });
  const adapter = createGitHubPublicationAdapter({
    binding, octokit, operation: frozen, verifyCredentialIdentity: verifiedActor,
  });
  await assert.rejects(adapter.preflight?.(frozen.marker, frozen.payload!),
    (error: unknown) => error instanceof PublicationDefiniteFailureError
      && error.code === "github_managed_target_changed");
});

function operation(current: ReturnType<typeof parseGitHubIssue>, overrides: Record<string, unknown> = {}): PublicationOperation {
  const revision = githubIssueRevision(current);
  const payload = {
    kind: "github-issue-comment", owner: "acme", repo: "widgets", pullNumber: 42,
    targetId: 4200, providerRepositoryId: 9001, providerActorId: 77,
    targetKind: "issue", revision, body: "triage", managedMarkerKey: null,
    managedTargetId: null, managedTargetBodySha256: null, ...overrides,
  };
  return {
    businessOperationId: "a".repeat(64),
    scope: { tenantId: "11111111-1111-4111-8111-111111111111",
      integrationId: "22222222-2222-4222-8222-222222222222", platform: "github",
      origin: binding.origin, repository: binding.repository, target: "42", revision,
      authorityGeneration: 1 },
    slot: "issue-triage", payloadHash: "b".repeat(64), payload,
    marker: `<!-- pr-agent-operation:${"a".repeat(64)} -->`, status: "unknown",
    attemptCount: 1, version: 2,
  };
}

function issue(overrides: Record<string, unknown> = {}) {
  return { id: 4200, number: 42, title: "Broken widget", body: "Steps to reproduce",
    state: "open", user: { id: 88, login: "alice", type: "User" }, labels: [], ...overrides };
}

function fixture(params: {
  current: unknown;
  comments?: Array<{ id: number; body: string; user: { id: number } }>;
  exactComment?: { id: number; body: string; user: { id: number } };
}): MinimalGitHubOctokit {
  return {
    repos: { get: async () => ({ data: { id: 9001 } }), getContent: async () => ({ data: [] }) },
    pulls: {
      get: async () => { throw new Error("ordinary Issue publication must not read Pull APIs"); },
      listFiles: async () => ({ data: [] }), createReviewComment: async () => ({ data: { id: 1 } }),
      update: async () => ({}),
    },
    issues: {
      get: async () => ({ data: params.current as never }),
      getComment: async () => ({ data: params.exactComment ?? { id: 501, body: "old", user: { id: 77 } } }),
      listComments: async () => ({ data: params.comments ?? [] }),
      createComment: async () => ({ data: { id: 501 } }), updateComment: async () => ({}),
      addLabels: async () => ({}),
    },
    paginate: async () => [],
  };
}

async function verifiedActor() {
  return { actorId: 77, kind: "github-app-installation" as const, appId: 71, installationId: 81 };
}
