import assert from "node:assert/strict";
import test from "node:test";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import type { FrozenPublicationBatch } from "../../src/agent-runtime/publication/batches.js";
import {
  PublicationRecoveryLoop,
  type PublicationRecoveryClaim,
  type PublicationRecoveryDependencies,
} from "../../src/agent-runtime/publication/recovery.js";

const binding: PublicationBinding = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: "11111111-1111-4111-8111-111111111111",
  platform: "github",
  origin: "https://github.example.test",
  repository: "acme/widgets",
  providerRepositoryId: 10,
  providerActorId: 20,
  credentialRef: "env:GITHUB_TOKEN",
  generation: 1,
  version: 1,
  state: "active",
};

const pendingBatch = batch("pending-batch", "pending");
const waitingBatch = batch("waiting-batch", "waiting_reconciliation");
const claim: PublicationRecoveryClaim = {
  tenantId: binding.tenantId,
  integrationId: binding.id,
  businessOperationId: "a".repeat(64),
  claimOwner: "test-worker",
  claimVersion: 1,
  operationVersion: 2,
};

test("tick executes only pending batches, reconciles claims, then wakes newly pending work", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  let batchRead = 0;
  const dependencies = fakeDependencies({
    listBatches: async () => {
      batchRead += 1;
      return batchRead === 1 ? [pendingBatch, waitingBatch] : [waitingBatch];
    },
    executeBatch: async (_binding, item) => { calls.push(`execute:${item.id}`); },
    claimOperations: async () => [claim],
    reconcileOperation: async () => {
      calls.push("reconcile");
      throw new Error("lookup remains indeterminate");
    },
    finishOperation: async () => { calls.push("finish"); return "scheduled"; },
    refreshBatch: async () => {
      calls.push("refresh:waiting-batch");
      return { ...waitingBatch, status: "pending" };
    },
    onError: (error) => { errors.push((error as Error).message); },
  });

  const result = await new PublicationRecoveryLoop(dependencies, {
    owner: "test-worker",
  }).tick();

  assert.deepEqual(calls, [
    "execute:pending-batch",
    "reconcile",
    "finish",
    "refresh:waiting-batch",
    "execute:waiting-batch",
  ]);
  assert.deepEqual(errors, ["lookup remains indeterminate"]);
  assert.equal(result.batchesExecuted, 2);
  assert.equal(result.operationsClaimed, 1);
  assert.equal(result.errors, 1);
});

test("waiting batch is refreshed even when there are no due operation claims", async () => {
  let reads = 0;
  const executed: string[] = [];
  const dependencies = fakeDependencies({
    listBatches: async () => (++reads === 1 ? [waitingBatch] : [waitingBatch]),
    refreshBatch: async () => ({ ...waitingBatch, status: "pending" }),
    executeBatch: async (_binding, item) => { executed.push(item.id); },
  });

  await new PublicationRecoveryLoop(dependencies).tick();
  assert.deepEqual(executed, [waitingBatch.id]);
});

test("overlapping ticks are skipped instead of duplicating work", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const loop = new PublicationRecoveryLoop(fakeDependencies({
    listBindings: async () => {
      await blocked;
      return [binding];
    },
  }));

  const first = loop.tick();
  assert.equal((await loop.tick()).skipped, true);
  release();
  assert.equal((await first).skipped, false);
});

test("manual review exits are counted and a lost claim is not replayed", async () => {
  let reconciliations = 0;
  const loop = new PublicationRecoveryLoop(fakeDependencies({
    claimOperations: async () => [claim],
    reconcileOperation: async () => { reconciliations += 1; },
    finishOperation: async () => "manual_review",
  }));
  const result = await loop.tick();
  assert.equal(reconciliations, 1);
  assert.equal(result.operationsManualReview, 1);
  assert.equal(result.operationsClaimed, 1);
});

test("start polls immediately and stop waits for the active tick", async () => {
  let started = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const loop = new PublicationRecoveryLoop(fakeDependencies({
    listBindings: async () => {
      started += 1;
      await blocked;
      return [];
    },
  }), { intervalMs: 60_000 });
  loop.start();
  await Promise.resolve();
  assert.equal(started, 1);
  let stopped = false;
  const stopping = loop.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
});

test("stop fences new recovery claims and executions and cannot restart polling", async () => {
  let releaseScan!: () => void;
  let scanStarted!: () => void;
  const scanBarrier = new Promise<void>((resolve) => { releaseScan = resolve; });
  const scanEntered = new Promise<void>((resolve) => { scanStarted = resolve; });
  let bindingReads = 0;
  let claims = 0;
  let executions = 0;
  const loop = new PublicationRecoveryLoop(fakeDependencies({
    listBindings: async () => { bindingReads += 1; return [binding]; },
    listBatches: async () => {
      scanStarted();
      await scanBarrier;
      return [pendingBatch];
    },
    executeBatch: async () => { executions += 1; },
    claimOperations: async () => { claims += 1; return []; },
  }), { intervalMs: 60_000 });

  loop.start();
  await scanEntered;
  const stopping = loop.stop();
  releaseScan();
  await stopping;

  assert.equal(executions, 0);
  assert.equal(claims, 0);
  loop.start();
  await Promise.resolve();
  assert.equal(bindingReads, 1);
  assert.equal((await loop.tick()).skipped, true);
});

test("stop waits for an acquired recovery claim to reconcile and finish", async () => {
  let releaseClaim!: () => void;
  let claimStarted!: () => void;
  const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const claimEntered = new Promise<void>((resolve) => { claimStarted = resolve; });
  const calls: string[] = [];
  const loop = new PublicationRecoveryLoop(fakeDependencies({
    claimOperations: async () => {
      claimStarted();
      await claimBarrier;
      return [claim];
    },
    reconcileOperation: async () => { calls.push("reconcile"); },
    finishOperation: async () => { calls.push("finish"); return "resolved"; },
  }));

  const ticking = loop.tick();
  await claimEntered;
  const stopping = loop.stop();
  releaseClaim();
  await Promise.all([ticking, stopping]);
  assert.deepEqual(calls, ["reconcile", "finish"]);
});

function fakeDependencies(
  overrides: Partial<PublicationRecoveryDependencies> = {},
): PublicationRecoveryDependencies {
  return {
    listBindings: async () => [binding],
    listBatches: async () => [],
    executeBatch: async () => {},
    refreshBatch: async () => undefined,
    claimOperations: async () => [],
    reconcileOperation: async () => {},
    finishOperation: async () => "resolved",
    onError: () => {},
    ...overrides,
  };
}

function batch(id: string, status: FrozenPublicationBatch["status"]): FrozenPublicationBatch {
  return {
    id,
    scope: {
      tenantId: binding.tenantId,
      integrationId: binding.id,
      platform: binding.platform,
      origin: binding.origin,
      repository: binding.repository,
      target: "pull:42",
      revision: "head-sha",
      authorityGeneration: binding.generation,
    },
    sourceKey: `source:${id}`,
    sourceHash: "b".repeat(64),
    status,
    operations: [],
  };
}
