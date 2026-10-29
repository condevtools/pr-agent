import assert from "node:assert/strict";
import test from "node:test";

import { guardGitHubOctokit } from "../src/integrations/github/github-rest-client.js";
import { guardGitHubCommandContext } from "../src/integrations/github/github-issue-comment-command.js";
import { gitLabApiRequest } from "../src/integrations/gitlab/gitlab-http.js";
import {
  buildPublicationIdentity,
  PendingPublicationError,
  PublicationService,
  type PreparedOperationInput,
  type PreparedPublication,
  type PublicationOperation,
  type PublicationStore,
} from "../src/agent-runtime/publication/publication.js";
import {
  assertPublicationWriteAllowed,
  PublicationWriteBoundaryError,
  withPublicationWriteAuthority,
} from "../src/agent-runtime/authority/write-boundary.js";
import { requireOnlinePublicationAuthority } from "../src/agent-runtime/publication/mode.js";

const previousMode = process.env.HARNESS_PUBLICATION_MODE;
process.env.HARNESS_PUBLICATION_MODE = "postgres";

const request = {
  scope: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    integrationId: "22222222-2222-4222-8222-222222222222",
    platform: "github" as const,
    origin: "https://github.example.test",
    repository: "acme/widgets",
    target: "pull:42",
    revision: "head-sha",
    authorityGeneration: 1,
  },
  slot: "review-report",
  payload: { body: "frozen" },
};

test("durable mutations require the matching claimed async context", async () => {
  assert.throws(() => assertPublicationWriteAllowed("github"), PublicationWriteBoundaryError);
  const operation = operationFrom(buildPublicationIdentity(request));
  await withPublicationWriteAuthority(operation, async () => {
    assert.doesNotThrow(() => assertPublicationWriteAllowed("github"));
    assert.throws(() => assertPublicationWriteAllowed("gitlab"), PublicationWriteBoundaryError);
  });
  assert.throws(() => assertPublicationWriteAllowed("github"), PublicationWriteBoundaryError);
});

test("PublicationService grants authority only around the claimed dispatch", async () => {
  const service = new PublicationService(new BoundaryStore());
  let dispatches = 0;
  const guarded = guardGitHubOctokit({
    issues: {
      createComment: async () => {
        assertPublicationWriteAllowed("github");
        dispatches += 1;
        return { data: { id: "remote-1" } };
      },
    },
  });
  const result = await service.publish(request, {
    dispatch: async () => {
      const created = await guarded.issues.createComment();
      return { id: created.data.id };
    },
    find: async () => null,
  });
  assert.equal(result.remoteId, "remote-1");
  assert.equal(dispatches, 1);
  assert.throws(() => assertPublicationWriteAllowed("github"), PublicationWriteBoundaryError);
});

test("response loss and detached work do not retain write authority", async () => {
  const service = new PublicationService(new BoundaryStore());
  let releaseDetached!: () => void;
  const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
  let detached!: Promise<void>;
  await assert.rejects(
    service.publish(request, {
      dispatch: async () => {
        detached = (async () => {
          await detachedGate;
          assertPublicationWriteAllowed("github");
        })();
        throw new Error("response lost");
      },
      find: async () => null,
    }),
    PendingPublicationError,
  );
  releaseDetached();
  await assert.rejects(detached, PublicationWriteBoundaryError);
});

test("concurrent async work outside the dispatch context cannot borrow its permit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const outsider = (async () => {
    await gate;
    assertPublicationWriteAllowed("github");
  })();
  await withPublicationWriteAuthority(operationFrom(buildPublicationIdentity(request)), async () => {
    release();
    await assert.rejects(outsider, PublicationWriteBoundaryError);
    assertPublicationWriteAllowed("github");
  });
});

test("transport and native-client guards block bare mutations but preserve reads", async () => {
  let writes = 0;
  let reads = 0;
  const guarded = guardGitHubOctokit({
    issues: {
      get: async () => { reads += 1; return { data: {} }; },
      createComment: async () => { writes += 1; return { data: { id: 1 } }; },
    },
  });
  await guarded.issues.get();
  assert.throws(() => guarded.issues.createComment(), PublicationWriteBoundaryError);
  assert.equal(reads, 1);
  assert.equal(writes, 0);

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return Response.json({}); };
  try {
    assert.equal(
      (await gitLabApiRequest({ url: "https://gitlab.example.test/api/v4/x", token: "test" })).ok,
      true,
    );
    await assert.rejects(
      gitLabApiRequest({ url: "https://gitlab.example.test/api/v4/x", token: "test", method: "POST" }),
      PublicationWriteBoundaryError,
    );
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct command-handler contexts cannot publish a disabled-command reply", async () => {
  let replies = 0;
  const context = guardGitHubCommandContext({
    repo: () => ({ owner: "acme", repo: "widgets" }),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    octokit: {
      issues: {
        createComment: async () => {
          replies += 1;
          return { data: { id: 1 } };
        },
      },
    },
  } as never);
  assert.throws(
    () => context.octokit.issues.createComment({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      body: "/ask is disabled for this repository",
    }),
    PublicationWriteBoundaryError,
  );
  assert.equal(replies, 0);
});

test("online authority latch rejects a mid-run legacy flip", () => {
  process.env.HARNESS_PUBLICATION_MODE = "postgres";
  requireOnlinePublicationAuthority();
  process.env.HARNESS_PUBLICATION_MODE = "legacy";
  assert.throws(
    () => assertPublicationWriteAllowed("github"),
    /rollback to a bare legacy publisher is prohibited/,
  );
  process.env.HARNESS_PUBLICATION_MODE = previousMode ?? "postgres";
});

class BoundaryStore implements PublicationStore {
  private operation: PublicationOperation | undefined;

  async prepareAndClaim(input: PreparedOperationInput): Promise<PreparedPublication> {
    if (!this.operation) {
      this.operation = operationFrom(input);
      return { action: "dispatch", operation: structuredClone(this.operation) };
    }
    if (this.operation.status === "succeeded") {
      return { action: "reuse", operation: structuredClone(this.operation) };
    }
    return { action: "reconcile", operation: structuredClone(this.operation) };
  }

  async get(): Promise<PublicationOperation | undefined> {
    return this.operation ? structuredClone(this.operation) : undefined;
  }

  async resolve(
    _tenantId: string,
    _operationId: string,
    expectedVersion: number,
    result: Parameters<PublicationStore["resolve"]>[3],
  ): Promise<PublicationOperation | undefined> {
    if (!this.operation || this.operation.version !== expectedVersion) return undefined;
    this.operation = {
      ...this.operation,
      status: result.status,
      outcomeCode: result.outcomeCode,
      remoteId: result.remoteId,
      lastErrorCode: result.errorCode,
      version: expectedVersion + 1,
    };
    return structuredClone(this.operation);
  }
}

function operationFrom(input: PreparedOperationInput): PublicationOperation {
  return {
    businessOperationId: input.businessOperationId,
    scope: input.scope,
    slot: input.slot,
    payloadHash: input.payloadHash,
    payload: input.payload,
    marker: input.marker,
    status: "in_flight",
    attemptCount: 1,
    version: 1,
  };
}
