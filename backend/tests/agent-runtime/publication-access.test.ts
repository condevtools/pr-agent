import assert from "node:assert/strict";
import test from "node:test";

import { guardPublicationAccess } from "../../src/agent-runtime/publication/access-guard.js";
import { PendingPublicationError, PublicationAccessCheckError, PublicationDefiniteFailureError,
  PublicationService, type PreparedOperationInput, type PreparedPublication,
  type PublicationAdapter, type PublicationOperation, type PublicationRequest,
  type PublicationStore } from "../../src/agent-runtime/publication/publication.js";

test("revocation between preflight and dispatch prevents the write but preserves reconciliation", async () => {
  let allowed = true;
  let writes = 0;
  let reads = 0;
  const adapter = guardPublicationAccess({
    dispatch: async () => { writes += 1; return { id: "remote" }; },
    find: async () => { reads += 1; return { id: "already-sent" }; },
  }, async () => { if (!allowed) throw new Error("revoked"); }, {
    isAccessDenied: (cause) => cause instanceof Error && cause.message === "revoked",
  });
  const operation = { businessOperationId: "operation" } as PublicationOperation;
  await adapter.preflight!("marker", {});
  allowed = false;
  await assert.rejects(adapter.dispatch("marker", {}, operation), (error: unknown) =>
    error instanceof PublicationDefiniteFailureError && error.noExternalEffect);
  assert.equal(writes, 0);
  assert.equal((await adapter.find("marker", {}, operation))?.id, "already-sent");
  assert.equal(reads, 1);
});

test("provider lookup failure does not enter preflight or dispatch", async () => {
  let entries = 0;
  const base: PublicationAdapter = {
    preflight: async () => { entries += 1; },
    dispatch: async () => { entries += 1; return { id: 1 }; },
    find: async () => null,
    reconciliationGraceMs: 123,
  };
  const adapter = guardPublicationAccess(base, async () => { throw new Error("provider unavailable"); });
  await assert.rejects(adapter.preflight!("marker", {}), /provider unavailable/);
  await assert.rejects(adapter.dispatch("marker", {}, { businessOperationId: "operation" } as PublicationOperation),
    PublicationAccessCheckError);
  assert.equal(entries, 0);
  assert.equal(adapter.reconciliationGraceMs, 123);
});

test("temporary access failure after claim makes no write and returns the claim to prepared", async () => {
  const store = new AccessFailureStore();
  let writes = 0;
  let accessChecks = 0;
  const adapter = guardPublicationAccess({
    dispatch: async () => { writes += 1; return { id: "remote" }; },
    find: async () => null,
  }, async () => { if (++accessChecks > 1) throw new Error("database temporarily unavailable"); });

  await assert.rejects(new PublicationService(store).publish(request(), adapter),
    PublicationAccessCheckError);
  assert.equal(writes, 0);
  assert.equal(store.operation?.status, "prepared");
  assert.equal(store.operation?.attemptCount, 0);
  assert.equal(store.operation?.version, 2);
  assert.equal(store.deferredErrorCode, "provider_access_check_unavailable");
});

test("failure to persist an undispatched defer remains unknown rather than definite", async () => {
  const store = new AccessFailureStore();
  store.failDefer = true;
  let writes = 0;
  let accessChecks = 0;
  const adapter = guardPublicationAccess({
    dispatch: async () => { writes += 1; return { id: "remote" }; },
    find: async () => null,
  }, async () => { if (++accessChecks > 1) throw new Error("database temporarily unavailable"); });

  await assert.rejects(new PublicationService(store).publish(request(), adapter), PendingPublicationError);
  assert.equal(writes, 0);
  assert.equal(store.operation?.status, "unknown");
  assert.equal(store.operation?.lastErrorCode, "access_check_defer_failed");
  assert.notEqual(store.operation?.status, "failed_definite");
});

function request(): PublicationRequest {
  return {
    scope: {
      tenantId: "93b45b11-2228-4aaa-87d3-4c0c3fcbdf61",
      integrationId: "3ce4f38e-0cab-4580-a5dd-4f993f4bee0e",
      platform: "github",
      origin: "https://api.github.com",
      repository: "condevtools/pr-agent",
      target: "pull/1",
      revision: "a".repeat(40),
      authorityGeneration: 1,
    },
    slot: "review",
    payload: { body: "review" },
  };
}

class AccessFailureStore implements PublicationStore {
  operation: PublicationOperation | undefined;
  failDefer = false;
  deferredErrorCode: string | undefined;

  async prepareAndClaim(input: PreparedOperationInput): Promise<PreparedPublication> {
    this.operation = {
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
    return { action: "dispatch", operation: structuredClone(this.operation) };
  }

  async get(): Promise<PublicationOperation | undefined> {
    return this.operation ? structuredClone(this.operation) : undefined;
  }

  async resolve(
    _tenantId: string,
    _businessOperationId: string,
    expectedVersion: number,
    result: { status: "succeeded" | "unknown" | "manual_review" | "failed_definite"; errorCode?: string },
  ): Promise<PublicationOperation | undefined> {
    if (!this.operation || this.operation.version !== expectedVersion) return undefined;
    this.operation = { ...this.operation, status: result.status,
      lastErrorCode: result.errorCode, version: this.operation.version + 1 };
    return structuredClone(this.operation);
  }

  async deferUndispatched(
    _tenantId: string,
    _businessOperationId: string,
    expectedVersion: number,
    _retryAfterMs: number,
    errorCode: string,
  ): Promise<PublicationOperation | undefined> {
    if (this.failDefer) throw new Error("defer transaction unavailable");
    if (!this.operation || this.operation.version !== expectedVersion || this.operation.status !== "in_flight") {
      return undefined;
    }
    this.deferredErrorCode = errorCode;
    this.operation = { ...this.operation, status: "prepared",
      attemptCount: this.operation.attemptCount - 1, version: this.operation.version + 1,
      lastErrorCode: errorCode };
    return structuredClone(this.operation);
  }
}
