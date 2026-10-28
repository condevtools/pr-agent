import assert from "node:assert/strict";
import test from "node:test";

import {
  PendingPublicationError,
  PublicationPreflightError,
  PublicationService,
  PublicationSlotConflictError,
  type PreparedOperationInput,
  type PreparedPublication,
  type PublicationOperation,
  type PublicationStore,
} from "../src/harness/publication.js";
import { createRestBackedOctokit } from "../src/integrations/github/github-rest-client.js";
import { publishGitHubIssueCommentDurably } from "../src/integrations/github/github-publication.js";
import type { GitHubReviewContext } from "../src/integrations/github/github-review-types.js";
import { publishGitLabNoteDurably } from "../src/integrations/gitlab/gitlab-publication.js";
import { buildManagedCommentMarker } from "../src/integrations/shared/managed-comments.js";

const githubScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  integrationId: "22222222-2222-4222-8222-222222222222",
  platform: "github" as const,
  origin: "https://api.github.com",
  repository: "acme/widgets",
};
const githubBinding = {
  platform: "github" as const,
  origin: githubScope.origin,
  repository: githubScope.repository,
  providerRepositoryId: 9001,
  providerActorId: 77,
  credentialRef: "env:GITHUB_TOKEN",
};
const gitlabBinding = {
  platform: "gitlab" as const,
  origin: "https://gitlab.example.com",
  repository: "acme/widgets",
  providerRepositoryId: 9,
  providerActorId: 88,
  credentialRef: "env:GITLAB_TOKEN",
};

test("GitHub response loss reconciles the marker without a second HTTP write", async () => {
  const originalFetch = globalThis.fetch;
  const service = new PublicationService(new MemoryPublicationStore());
  let writes = 0;
  let remoteBody: string | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/issues/42/comments")) {
      writes += 1;
      remoteBody = JSON.parse(String(init.body)).body as string;
      throw new Error("response lost after GitHub accepted the comment");
    }
    if (url.includes("/issues/42/comments?")) {
      return Response.json(remoteBody ? [{ id: 73, body: remoteBody, user: { id: 77 } }] : []);
    }
    if (url.endsWith("/pulls/42")) {
      return Response.json({ id: 4200, number: 42, head: { sha: "head-1" } });
    }
    if (url.endsWith("/repos/acme/widgets")) {
      return Response.json({ id: 9001, full_name: "acme/widgets" });
    }
    throw new Error(`unexpected GitHub request: ${init?.method ?? "GET"} ${url}`);
  };
  const octokit = createRestBackedOctokit({
    token: "token",
    baseUrl: "https://api.github.com",
  });
  const context = {
    octokit,
  } as unknown as GitHubReviewContext;
  const request = {
    runtime: { service, scope: githubScope, binding: githubBinding, verifyCredentialIdentity: verifiedGitHubActor },
    context,
    owner: "acme",
    repo: "widgets",
    pullNumber: 42,
    revision: "head-1",
    slot: "review-report",
    body: "review body",
  };

  try {
    await assert.rejects(publishGitHubIssueCommentDurably(request), PendingPublicationError);
    const reconciled = await publishGitHubIssueCommentDurably(request);
    assert.equal(writes, 1);
    assert.equal(reconciled.remoteId, "73");
    assert.equal(reconciled.reconciled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub live credential actor mismatch performs zero writes", async () => {
  const service = new PublicationService(new MemoryPublicationStore());
  let writes = 0;
  const context = {
    octokit: {
      repos: { get: async () => ({ data: { id: 9001 } }) },
      pulls: { get: async () => ({ data: { id: 4200, number: 42, head: { sha: "head-1" } } }) },
      issues: { createComment: async () => { writes += 1; return { data: { id: 1 } }; } },
    },
  } as unknown as GitHubReviewContext;
  await assert.rejects(
    publishGitHubIssueCommentDurably({
      runtime: {
        service, scope: githubScope, binding: githubBinding,
        verifyCredentialIdentity: async () => ({ actorId: 999, kind: "user-token" as const, login: "attacker" }),
      },
      context, owner: "acme", repo: "widgets", pullNumber: 42,
      revision: "head-1", slot: "review-report", body: "review body",
    }),
    (error: unknown) => error instanceof PublicationPreflightError && error.code === "github_credential_actor_mismatch",
  );
  assert.equal(writes, 0);
});

test("GitHub managed lookup fails before claim and later retry writes once", async () => {
  const service = new PublicationService(new MemoryPublicationStore());
  let writes = 0;
  let failLookup = true;
  const context = {
    octokit: {
      pulls: {
        get: async () => ({ data: { id: 4200, number: 42, head: { sha: "head-1" } } }),
      },
      repos: { get: async () => ({ data: { id: 9001 } }) },
      issues: {
        listComments: async () => {
          if (failLookup) throw new Error("GitHub list comments unavailable");
          return { data: [] };
        },
        createComment: async () => {
          writes += 1;
          return { data: { id: 1 } };
        },
      },
    },
  } as unknown as GitHubReviewContext;

  const request = {
      runtime: { service, scope: githubScope, binding: githubBinding, verifyCredentialIdentity: verifiedGitHubActor },
      context,
      owner: "acme",
      repo: "widgets",
      pullNumber: 42,
      revision: "head-1",
      slot: "review-report",
      body: "review body",
      managedMarkerKey: "review-report",
    };
  await assert.rejects(publishGitHubIssueCommentDurably(request), PublicationPreflightError);
  failLookup = false;
  await publishGitHubIssueCommentDurably(request);
  assert.equal(writes, 1);
});

test("GitHub managed update rejection never falls back to create", async () => {
  const service = new PublicationService(new MemoryPublicationStore());
  let creates = 0;
  const marker = buildManagedCommentMarker("review-report");
  const context = {
    octokit: {
      pulls: { get: async () => ({ data: { id: 4200, number: 42, head: { sha: "head-1" } } }) },
      repos: { get: async () => ({ data: { id: 9001 } }) },
      issues: {
        listComments: async () => ({ data: [{ id: 55, body: marker, user: { id: 77 } }] }),
        getComment: async () => ({ data: { id: 55, body: marker, user: { id: 77 } } }),
        updateComment: async () => { throw Object.assign(new Error("unprocessable"), { status: 422 }); },
        createComment: async () => { creates += 1; return { data: { id: 1 } }; },
      },
    },
  } as unknown as GitHubReviewContext;
  await assert.rejects(
    publishGitHubIssueCommentDurably({
      runtime: { service, scope: githubScope, binding: githubBinding, verifyCredentialIdentity: verifiedGitHubActor }, context,
      owner: "acme", repo: "widgets", pullNumber: 42, revision: "head-1",
      slot: "review-report", body: "next", managedMarkerKey: "review-report",
    }),
    /definitely rejected/i,
  );
  assert.equal(creates, 0);
});

test("GitHub managed target concurrent edit is rejected before overwrite", async () => {
  const service = new PublicationService(new MemoryPublicationStore());
  const marker = buildManagedCommentMarker("review-report");
  let exactReads = 0;
  let updates = 0;
  const context = {
    octokit: {
      pulls: { get: async () => ({ data: { id: 4200, number: 42, head: { sha: "head-1" } } }) },
      repos: { get: async () => ({ data: { id: 9001 } }) },
      issues: {
        listComments: async () => ({ data: [{ id: 55, body: marker, user: { id: 77 } }] }),
        getComment: async () => {
          exactReads += 1;
          return { data: { id: 55, body: exactReads === 1 ? marker : `${marker}\nconcurrent edit`, user: { id: 77 } } };
        },
        updateComment: async () => { updates += 1; return {}; },
        createComment: async () => ({ data: { id: 1 } }),
      },
    },
  } as unknown as GitHubReviewContext;
  await assert.rejects(
    publishGitHubIssueCommentDurably({
      runtime: { service, scope: githubScope, binding: githubBinding, verifyCredentialIdentity: verifiedGitHubActor }, context,
      owner: "acme", repo: "widgets", pullNumber: 42, revision: "head-1",
      slot: "review-report", body: "next", managedMarkerKey: "review-report",
    }),
    /definitely rejected/i,
  );
  assert.equal(updates, 0);
});

test("GitLab response loss performs one POST and reconciles through the remote marker", async () => {
  const originalFetch = globalThis.fetch;
  const service = new PublicationService(new MemoryPublicationStore());
  let posts = 0;
  let remoteBody: string | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/notes")) {
      posts += 1;
      remoteBody = JSON.parse(String(init.body)).body as string;
      throw new Error("response lost after GitLab accepted the note");
    }
    if (url.includes("/notes?")) {
      return Response.json(remoteBody ? [{ id: 91, body: remoteBody, author: { id: 88 } }] : []);
    }
    if (url.endsWith("/merge_requests/7")) {
      return Response.json({ id: 7000, iid: 7, sha: "head-7" });
    }
    if (url.endsWith("/api/v4/user")) {
      return Response.json({ id: 88 });
    }
    if (url.endsWith("/api/v4/projects/9")) {
      return Response.json({ id: 9, path_with_namespace: "acme/widgets" });
    }
    throw new Error(`unexpected GitLab request: ${init?.method ?? "GET"} ${url}`);
  };

  const request = {
    runtime: {
      service,
      scope: {
        tenantId: githubScope.tenantId,
        integrationId: "33333333-3333-4333-8333-333333333333",
        platform: "gitlab" as const,
        origin: "https://gitlab.example.com",
        repository: "acme/widgets",
      },
      binding: gitlabBinding,
    },
    token: "token",
    target: { baseUrl: "https://gitlab.example.com", projectId: 9, mrId: 7 },
    revision: "head-7",
    slot: "review-report",
    body: "review body",
  };

  try {
    await assert.rejects(publishGitLabNoteDurably(request), PendingPublicationError);
    const reconciled = await publishGitLabNoteDurably(request);
    assert.equal(posts, 1);
    assert.equal(reconciled.remoteId, "91");
    assert.equal(reconciled.reconciled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitLab managed lookup fails before claim and later retry writes once", async () => {
  const originalFetch = globalThis.fetch;
  const service = new PublicationService(new MemoryPublicationStore());
  let posts = 0;
  let failLookup = true;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts += 1;
      return Response.json({ id: 1 });
    }
    if (url.includes("/notes?")) {
      return failLookup ? new Response("unavailable", { status: 503 }) : Response.json([]);
    }
    if (url.endsWith("/merge_requests/7")) {
      return Response.json({ id: 7000, iid: 7, sha: "head-7" });
    }
    if (url.endsWith("/api/v4/user")) {
      return Response.json({ id: 88 });
    }
    if (url.endsWith("/api/v4/projects/9")) {
      return Response.json({ id: 9, path_with_namespace: "acme/widgets" });
    }
    throw new Error(`unexpected GitLab request: ${init?.method ?? "GET"} ${url}`);
  };

  try {
    const request = {
        runtime: {
          service,
          scope: {
            tenantId: githubScope.tenantId,
            integrationId: "33333333-3333-4333-8333-333333333333",
            platform: "gitlab",
            origin: "https://gitlab.example.com",
            repository: "acme/widgets",
          },
          binding: gitlabBinding,
        },
        token: "token",
        target: { baseUrl: "https://gitlab.example.com", projectId: 9, mrId: 7 },
        revision: "head-7",
        slot: "review-report",
        body: "review body",
        managedMarkerKey: "review-report",
      };
    await assert.rejects(publishGitLabNoteDurably(request), PublicationPreflightError);
    failLookup = false;
    await publishGitLabNoteDurably(request);
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitLab managed target concurrent edit is rejected before overwrite", async () => {
  const originalFetch = globalThis.fetch;
  const service = new PublicationService(new MemoryPublicationStore());
  const marker = buildManagedCommentMarker("review-report");
  let exactReads = 0;
  let updates = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/notes?")) return Response.json([{ id: 55, body: marker, author: { id: 88 } }]);
    if (url.endsWith("/notes/55") && (init?.method ?? "GET") === "GET") {
      exactReads += 1;
      return Response.json({ id: 55, body: exactReads === 1 ? marker : `${marker}\nconcurrent edit`, author: { id: 88 } });
    }
    if (url.endsWith("/notes/55") && init?.method === "PUT") {
      updates += 1;
      return Response.json({ id: 55 });
    }
    if (url.endsWith("/merge_requests/7")) return Response.json({ id: 7000, iid: 7, sha: "head-7" });
    if (url.endsWith("/api/v4/user")) return Response.json({ id: 88 });
    if (url.endsWith("/api/v4/projects/9")) return Response.json({ id: 9, path_with_namespace: "acme/widgets" });
    throw new Error(`unexpected GitLab request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await assert.rejects(
      publishGitLabNoteDurably({
        runtime: {
          service,
          scope: { tenantId: githubScope.tenantId, integrationId: "33333333-3333-4333-8333-333333333333", platform: "gitlab", origin: "https://gitlab.example.com", repository: "acme/widgets" },
          binding: gitlabBinding,
        },
        token: "token", target: { baseUrl: "https://gitlab.example.com", projectId: 9, mrId: 7 },
        revision: "head-7", slot: "review-report", body: "next", managedMarkerKey: "review-report",
      }),
      /definitely rejected/i,
    );
    assert.equal(updates, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy REST inline comments still accept an empty response", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(null, { status: 204 });
  };
  const octokit = createRestBackedOctokit({
    token: "token",
    baseUrl: "https://api.github.com",
  });
  const params = {
    owner: "acme",
    repo: "widgets",
    pull_number: 42,
    body: "inline",
    commit_id: "head-1",
    path: "src/index.ts",
    line: 3,
    side: "RIGHT" as const,
  };

  try {
    assert.deepEqual(await octokit.pulls.createReviewComment(params), {});
    await assert.rejects(
      octokit.pulls.createReviewComment({ ...params, request: { retries: 0 } }),
      /expected JSON body/i,
    );
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class MemoryPublicationStore implements PublicationStore {
  private readonly operations = new Map<string, PublicationOperation>();
  private readonly slots = new Map<string, string>();

  async prepareAndClaim(input: PreparedOperationInput): Promise<PreparedPublication> {
    const key = `${input.scope.tenantId}:${input.businessOperationId}`;
    let operation = this.operations.get(key);
    if (!operation) {
      operation = {
        businessOperationId: input.businessOperationId,
        scope: input.scope,
        slot: input.slot,
        payloadHash: input.payloadHash,
        payload: input.payload,
        marker: input.marker,
        status: "prepared",
        attemptCount: 0,
        version: 0,
      };
      this.operations.set(key, operation);
    }
    const slotKey = `${input.scope.tenantId}:${input.scope.integrationId}:${input.scope.target}:${input.slot}`;
    const activeId = this.slots.get(slotKey);
    if (activeId && activeId !== input.businessOperationId) {
      const active = this.operations.get(`${input.scope.tenantId}:${activeId}`);
      throw new PublicationSlotConflictError(activeId, active?.status ?? "unknown");
    }
    this.slots.set(slotKey, input.businessOperationId);
    if (operation.status === "prepared") {
      const claimed = { ...operation, status: "in_flight" as const, attemptCount: 1, version: 1 };
      this.operations.set(key, claimed);
      return { action: "dispatch", operation: structuredClone(claimed) };
    }
    if (operation.status === "succeeded") {
      return { action: "reuse", operation: structuredClone(operation) };
    }
    return { action: "reconcile", operation: structuredClone(operation) };
  }

  async get(tenantId: string, businessOperationId: string): Promise<PublicationOperation | undefined> {
    const operation = this.operations.get(`${tenantId}:${businessOperationId}`);
    return operation ? structuredClone(operation) : undefined;
  }

  async resolve(
    tenantId: string,
    businessOperationId: string,
    expectedVersion: number,
    result: {
      status: "succeeded" | "unknown" | "failed_definite";
      outcomeCode?: "current" | "stale";
      remoteId?: string;
      errorCode?: string;
    },
  ): Promise<PublicationOperation | undefined> {
    const key = `${tenantId}:${businessOperationId}`;
    const current = this.operations.get(key);
    if (!current || current.version !== expectedVersion) return undefined;
    const updated = {
      ...current,
      status: result.status,
      outcomeCode: result.outcomeCode,
      remoteId: result.remoteId,
      lastErrorCode: result.errorCode,
      version: current.version + 1,
    };
    this.operations.set(key, updated);
    return structuredClone(updated);
  }
}

async function verifiedGitHubActor() {
  return { actorId: 77, kind: "user-token" as const, login: "pr-agent-bot" };
}
