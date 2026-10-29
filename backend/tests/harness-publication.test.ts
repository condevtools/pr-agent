import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicationIdentity,
  PendingPublicationError,
  PublicationDefiniteFailureError,
  PublicationLookupIndeterminateError,
  PublicationPreflightError,
  PublicationService,
  PublicationSlotConflictError,
  StalePublicationError,
  type PreparedOperationInput,
  type PreparedPublication,
  type PublicationOperation,
  type PublicationStore,
} from "../src/agent-runtime/publication/publication.js";

const request = {
  scope: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    integrationId: "22222222-2222-4222-8222-222222222222",
    platform: "github" as const,
    origin: "https://github.com/",
    repository: "acme/widgets",
    target: "pull:42",
    revision: "abc123",
  },
  slot: "review-report",
  payload: { body: "review", metadata: { severity: "high" } },
};

test("publication identity is stable across object key order", () => {
  const first = buildPublicationIdentity(request);
  const second = buildPublicationIdentity({
    ...request,
    payload: { metadata: { severity: "high" }, body: "review" },
  });
  assert.equal(first.businessOperationId, second.businessOperationId);
  assert.equal(first.marker, `<!-- pr-agent-operation:${first.businessOperationId} -->`);
});

test("successful repeated publication dispatches once and reuses the operation", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let dispatches = 0;
  const adapter = {
    dispatch: async () => ({ id: ++dispatches }),
    find: async () => null,
    currentRevision: async () => request.scope.revision,
  };

  const first = await service.publish(request, adapter);
  const second = await service.publish(request, adapter);

  assert.equal(dispatches, 1);
  assert.equal(first.remoteId, "1");
  assert.equal(second.remoteId, "1");
  assert.equal(second.reused, true);
});

test("a reused success is stale when the repository head has moved", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  const adapter = {
    dispatch: async () => ({ id: "comment-1" }),
    find: async () => null,
    currentRevision: async () => request.scope.revision,
  };
  await service.publish(request, adapter);

  await assert.rejects(
    service.publish(request, { ...adapter, currentRevision: async () => "new-head" }),
    StalePublicationError,
  );
});

test("undefined payload values are rejected before an operation is claimed", () => {
  assert.throws(
    () => buildPublicationIdentity({ ...request, payload: { body: undefined } }),
    /JSON serializable/,
  );
});

test("response loss becomes unknown and retry reconciles without another dispatch", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let dispatches = 0;
  let remoteMarker: string | undefined;
  const adapter = {
    dispatch: async (marker: string) => {
      dispatches += 1;
      remoteMarker = marker;
      throw new Error("response lost after remote write");
    },
    find: async (marker: string) => (marker === remoteMarker ? { id: "remote-7" } : null),
    currentRevision: async () => request.scope.revision,
  };

  await assert.rejects(service.publish(request, adapter), PendingPublicationError);
  const reconciled = await service.publish(request, adapter);

  assert.equal(dispatches, 1);
  assert.equal(reconciled.remoteId, "remote-7");
  assert.equal(reconciled.reconciled, true);
});

test("an unknown publication reconciles stale after the head moves without redispatch", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let dispatches = 0;
  const adapter = {
    dispatch: async () => {
      dispatches += 1;
      throw new Error("response lost");
    },
    find: async () => ({ id: "remote-stale" }),
    currentRevision: async () => request.scope.revision,
  };
  await assert.rejects(service.publish(request, adapter), PendingPublicationError);
  await assert.rejects(
    service.publish(request, { ...adapter, currentRevision: async () => "moved-head" }),
    StalePublicationError,
  );
  assert.equal(dispatches, 1);
  const operation = await store.get(
    request.scope.tenantId,
    buildPublicationIdentity(request).businessOperationId,
  );
  assert.equal(operation?.status, "succeeded");
  assert.equal(operation?.outcomeCode, "stale");
});

test("a reconciliation write failure stays pending and never redispatches", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let dispatches = 0;
  const adapter = {
    dispatch: async () => {
      dispatches += 1;
      throw new Error("response lost after remote write");
    },
    find: async () => ({ id: "remote-after-db-recovery" }),
    currentRevision: async () => request.scope.revision,
  };

  await assert.rejects(service.publish(request, adapter), PendingPublicationError);
  store.failNextResolution();
  await assert.rejects(service.publish(request, adapter), PendingPublicationError);
  const result = await service.publish(request, adapter);

  assert.equal(dispatches, 1);
  assert.equal(result.remoteId, "remote-after-db-recovery");
  assert.equal(result.reconciled, true);
});

test("a changed payload cannot bypass an unresolved publication slot", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  const adapter = {
    dispatch: async () => {
      throw new Error("unknown");
    },
    find: async () => null,
  };
  await assert.rejects(service.publish(request, adapter), PendingPublicationError);

  await assert.rejects(
    service.publish({ ...request, payload: { body: "different" } }, adapter),
    PublicationSlotConflictError,
  );
});

test("stale revision before dispatch does not claim or occupy a slot", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let dispatches = 0;
  await assert.rejects(
    service.publish(request, {
      dispatch: async () => ({ id: ++dispatches }),
      find: async () => null,
      currentRevision: async () => "new-head",
    }),
    StalePublicationError,
  );
  assert.equal(dispatches, 0);
  const operation = await store.get(
    request.scope.tenantId,
    buildPublicationIdentity(request).businessOperationId,
  );
  assert.equal(operation, undefined);
});

test("preflight failure can retry successfully without an unknown operation", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let revisionReads = 0;
  let dispatches = 0;
  const adapter = {
    dispatch: async () => ({ id: ++dispatches }),
    find: async () => null,
    currentRevision: async () => {
      if (revisionReads++ === 0) throw new Error("temporary read failure");
      return request.scope.revision;
    },
  };

  await assert.rejects(service.publish(request, adapter), PublicationPreflightError);
  assert.equal(
    await store.get(request.scope.tenantId, buildPublicationIdentity(request).businessOperationId),
    undefined,
  );
  assert.equal((await service.publish(request, adapter)).remoteId, "1");
  assert.equal(dispatches, 1);
});

test("transient preflight failure leaves a frozen prepared operation retryable", async () => {
  const store = new TestPublicationStore();
  const identity = buildPublicationIdentity(request);
  store.prepareOnly(identity);
  const service = new PublicationService(store);
  let revisionReads = 0;
  let dispatches = 0;
  const adapter = {
    dispatch: async () => ({ id: ++dispatches }),
    find: async () => null,
    currentRevision: async () => {
      if (revisionReads++ === 0) throw new Error("temporary lookup failure");
      return request.scope.revision;
    },
  };
  await assert.rejects(service.publish(request, adapter), PublicationPreflightError);
  assert.equal((await store.get(identity.scope.tenantId, identity.businessOperationId))?.status, "prepared");
  assert.equal((await service.publish(request, adapter)).remoteId, "1");
});

test("stale frozen prepared operation becomes definite and releases its slot", async () => {
  const store = new TestPublicationStore();
  const identity = buildPublicationIdentity(request);
  store.prepareOnly(identity);
  const service = new PublicationService(store);
  await assert.rejects(
    service.publish(request, {
      dispatch: async () => ({ id: "must-not-dispatch" }),
      find: async () => null,
      currentRevision: async () => "moved-head",
    }),
    StalePublicationError,
  );
  const failed = await store.get(identity.scope.tenantId, identity.businessOperationId);
  assert.equal(failed?.status, "failed_definite");
  assert.equal(failed?.outcomeCode, "stale");
  const replacement = await service.publish(
    { ...request, payload: { body: "replacement-after-stale" } },
    {
      dispatch: async () => ({ id: "replacement-after-stale" }),
      find: async () => null,
      currentRevision: async () => request.scope.revision,
    },
  );
  assert.equal(replacement.remoteId, "replacement-after-stale");
});

test("dispatch receives the stored detached payload after caller mutation", async () => {
  const mutable = { body: "frozen", metadata: { severity: "high" } };
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let dispatchedPayload: Record<string, unknown> | undefined;
  const promise = service.publish(
    { ...request, payload: mutable },
    {
      preflight: async () => {
        mutable.body = "mutated";
        mutable.metadata.severity = "low";
      },
      dispatch: async (_marker, payload) => {
        dispatchedPayload = payload;
        return { id: "detached" };
      },
      find: async () => null,
    },
  );
  await promise;
  assert.deepEqual(dispatchedPayload, { body: "frozen", metadata: { severity: "high" } });
  assert.equal(Object.isFrozen(dispatchedPayload), true);
  assert.equal(Object.isFrozen(dispatchedPayload?.metadata), true);
});

test("a definite provider rejection is terminal for the same intent and unlocks a new intent", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  const operationId = buildPublicationIdentity(request).businessOperationId;
  await assert.rejects(
    service.publish(request, {
      dispatch: async () => {
        throw new PublicationDefiniteFailureError(operationId, "validation_failed", 422);
      },
      find: async () => null,
    }),
    PublicationDefiniteFailureError,
  );
  assert.equal((await store.get(request.scope.tenantId, operationId))?.status, "failed_definite");
  await assert.rejects(
    service.publish(request, { dispatch: async () => ({ id: "unexpected" }), find: async () => null }),
    PublicationDefiniteFailureError,
  );
  const next = await service.publish(
    { ...request, payload: { body: "replacement" } },
    { dispatch: async () => ({ id: "replacement" }), find: async () => null },
  );
  assert.equal(next.remoteId, "replacement");
});

test("reconcile by ID never dispatches and old payload-less records fail closed", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  const identity = buildPublicationIdentity(request);
  await store.prepareAndClaim(identity);
  store.removePayload(identity.scope.tenantId, identity.businessOperationId);
  let dispatches = 0;
  await assert.rejects(
    service.reconcileOperation(identity.scope.tenantId, identity.businessOperationId, {
      dispatch: async () => ({ id: ++dispatches }),
      find: async () => ({ id: "should-not-be-read" }),
    }),
    PendingPublicationError,
  );
  assert.equal(dispatches, 0);
  assert.equal(
    (await store.get(identity.scope.tenantId, identity.businessOperationId))?.status,
    "manual_review",
  );
});

test("bounded lookup exhaustion moves an unresolved operation to manual review", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  const identity = buildPublicationIdentity(request);
  await store.prepareAndClaim(identity);
  await assert.rejects(
    service.reconcileOperation(identity.scope.tenantId, identity.businessOperationId, {
      dispatch: async () => ({ id: "must-not-dispatch" }),
      find: async () => {
        throw new PublicationLookupIndeterminateError("query_cap_reached");
      },
    }),
    PendingPublicationError,
  );
  const operation = await store.get(identity.scope.tenantId, identity.businessOperationId);
  assert.equal(operation?.status, "manual_review");
  assert.equal(operation?.lastErrorCode, "query_cap_reached");
});

test("automatic publish does not query or reset a manual-review operation", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  const identity = buildPublicationIdentity(request);
  await store.prepareAndClaim(identity);
  await assert.rejects(
    service.reconcileOperation(identity.scope.tenantId, identity.businessOperationId, {
      dispatch: async () => ({ id: "never" }),
      find: async () => { throw new PublicationLookupIndeterminateError("query_cap_reached"); },
    }),
    PendingPublicationError,
  );
  let adapterCalls = 0;
  await assert.rejects(
    service.publish(request, {
      preflight: async () => { adapterCalls += 1; },
      dispatch: async () => { adapterCalls += 1; return { id: "never" }; },
      find: async () => { adapterCalls += 1; return null; },
      currentRevision: async () => { adapterCalls += 1; return request.scope.revision; },
    }),
    PendingPublicationError,
  );
  assert.equal(adapterCalls, 0);
  assert.equal(
    (await store.get(identity.scope.tenantId, identity.businessOperationId))?.status,
    "manual_review",
  );
});

test("a head change after dispatch records a stale remote outcome", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  let revisionReads = 0;
  await assert.rejects(
    service.publish(request, {
      dispatch: async () => ({ id: "comment-stale" }),
      find: async () => null,
      currentRevision: async () =>
        revisionReads++ === 0 ? request.scope.revision : "new-head",
    }),
    StalePublicationError,
  );
  const operation = await store.get(
    request.scope.tenantId,
    buildPublicationIdentity(request).businessOperationId,
  );
  assert.equal(operation?.status, "succeeded");
  assert.equal(operation?.outcomeCode, "stale");
  assert.equal(operation?.remoteId, "comment-stale");
});

test("invalid remote IDs remain unknown instead of becoming a fabricated string", async () => {
  const store = new TestPublicationStore();
  const service = new PublicationService(store);
  await assert.rejects(
    service.publish(request, {
      dispatch: async () => ({ id: undefined as never }),
      find: async () => null,
    }),
    PendingPublicationError,
  );
  const operation = await store.get(
    request.scope.tenantId,
    buildPublicationIdentity(request).businessOperationId,
  );
  assert.equal(operation?.status, "unknown");
  assert.equal(operation?.remoteId, undefined);
});

class TestPublicationStore implements PublicationStore {
  private readonly operations = new Map<string, PublicationOperation>();
  private readonly slots = new Map<string, string>();
  private rejectNextResolve = false;

  failNextResolution(): void {
    this.rejectNextResolve = true;
  }

  removePayload(tenantId: string, businessOperationId: string): void {
    const key = `${tenantId}:${businessOperationId}`;
    const operation = this.operations.get(key);
    if (operation) this.operations.set(key, { ...operation, payload: undefined });
  }

  prepareOnly(input: PreparedOperationInput): void {
    const key = `${input.scope.tenantId}:${input.businessOperationId}`;
    this.operations.set(key, {
      businessOperationId: input.businessOperationId,
      scope: input.scope,
      slot: input.slot,
      payloadHash: input.payloadHash,
      payload: input.payload,
      marker: input.marker,
      status: "prepared",
      attemptCount: 0,
      version: 0,
    });
    this.slots.set(
      `${input.scope.tenantId}:${input.scope.integrationId}:${input.scope.target}:${input.slot}`,
      input.businessOperationId,
    );
  }

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
      if (!active || ["prepared", "in_flight", "unknown", "manual_review"].includes(active.status)) {
        throw new PublicationSlotConflictError(activeId, active?.status ?? "unknown");
      }
    }
    this.slots.set(slotKey, input.businessOperationId);
    if (operation.status === "prepared") {
      operation = { ...operation, status: "in_flight", attemptCount: 1, version: 1 };
      this.operations.set(key, operation);
      return { action: "dispatch", operation: cloneOperation(operation) };
    }
    if (operation.status === "succeeded") {
      return { action: "reuse", operation: cloneOperation(operation) };
    }
    if (["in_flight", "unknown", "manual_review"].includes(operation.status)) {
      return { action: "reconcile", operation: cloneOperation(operation) };
    }
    if (operation.status === "failed_definite") {
      throw new PublicationDefiniteFailureError(
        operation.businessOperationId,
        operation.lastErrorCode ?? "failed_definite",
      );
    }
    throw new PublicationSlotConflictError(operation.businessOperationId, operation.status);
  }

  async get(tenantId: string, businessOperationId: string): Promise<PublicationOperation | undefined> {
    const found = this.operations.get(`${tenantId}:${businessOperationId}`);
    return found ? cloneOperation(found) : undefined;
  }

  async resolve(
    tenantId: string,
    businessOperationId: string,
    expectedVersion: number,
    result: {
      status: "succeeded" | "unknown" | "manual_review" | "failed_definite";
      outcomeCode?: PublicationOperation["outcomeCode"];
      remoteId?: string;
      errorCode?: string;
    },
  ): Promise<PublicationOperation | undefined> {
    if (this.rejectNextResolve) {
      this.rejectNextResolve = false;
      throw new Error("simulated completion transaction failure");
    }
    const key = `${tenantId}:${businessOperationId}`;
    const current = this.operations.get(key);
    if (!current || current.version !== expectedVersion) return undefined;
    const updated: PublicationOperation = {
      ...current,
      status: result.status,
      outcomeCode: result.outcomeCode,
      remoteId: result.remoteId,
      lastErrorCode: result.errorCode,
      version: current.version + 1,
    };
    this.operations.set(key, updated);
    return cloneOperation(updated);
  }
}

function cloneOperation(operation: PublicationOperation): PublicationOperation {
  const cloned = structuredClone(operation);
  if (cloned.payload) {
    Object.freeze(cloned.payload);
    for (const value of Object.values(cloned.payload)) {
      if (value && typeof value === "object") Object.freeze(value);
    }
  }
  return cloned;
}
