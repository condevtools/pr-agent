import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import type { ModelBudgetStore } from "../../src/agent-runtime/budget/model-budget-store.js";
import { RunLeaseLostError, type RunLease } from "../../src/agent-runtime/runs/contracts.js";
import type { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { currentRunExecutionContext } from "../../src/agent-runtime/execution/run-context.js";
import { retryBackoffMs, RunWorker } from "../../src/agent-runtime/execution/run-worker.js";
import { z } from "zod";

test("an old attempt finishing its heartbeat cannot remove the replacement task from drain tracking", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const firstExecution = deferred();
  const firstHeartbeat = deferred();
  const secondExecution = deferred();
  let claimed = 0;
  let ready = true;
  let started = 0;
  const lease = workerLease("same-run");
  const store = {
    claimPublicationOutcome: async () => undefined,
    claimManualResume: async () => undefined,
    claim: async () => {
      if (!ready || claimed === 2) return undefined;
      ready = false;
      return { ...lease, epoch: ++claimed };
    },
    latestCheckpoint: async () => undefined,
    withLease: async (_lease: RunLease, action: () => Promise<unknown>) => action(),
    heartbeat: async () => { await firstHeartbeat.promise; return lease; },
    transition: async (_lease: RunLease, input: { to: string }) => { if (input.to === "retry_wait") ready = true; },
  } as unknown as RunExecutionStore;
  const worker = new RunWorker({
    store, budget: { closeRunBudget: async () => "closed" } as unknown as ModelBudgetStore,
    bindings: async () => [{ reviewExecutionMode: "harness_async" } as PublicationBinding],
    runtimeHash: async () => "runtime",
    execute: async () => {
      started += 1;
      if (started === 1) { await firstExecution.promise; throw new Error("retry fixture"); }
      await secondExecution.promise;
    },
    onError: () => undefined,
  }, 2);
  await worker.tick();
  await nextTurn();
  t.mock.timers.tick(15_000);
  firstExecution.resolve();
  await nextTurn();
  await worker.tick();
  await nextTurn();
  assert.equal(started, 2);
  firstHeartbeat.resolve();
  await nextTurn();
  t.mock.timers.tick(10);
  await nextTurn();
  let drained = false;
  const drain = worker.drain().then(() => { drained = true; });
  await nextTurn();
  assert.equal(drained, false, "replacement execution must still be tracked");
  secondExecution.resolve();
  await drain;
  await worker.stop();
});

test("retry backoff is exponential, bounded, and jittered deterministically", () => {
  assert.equal(retryBackoffMs(1, () => 0), 750);
  assert.equal(retryBackoffMs(2, () => 0.5), 2_000);
  assert.equal(retryBackoffMs(20, () => 1), 60_000);
});

test("special work has a bounded lane while normal work uses the remaining global capacity", async () => {
  const release = deferred();
  const started: string[] = [];
  let normalOrdinal = 0;
  let publicationAvailable = true;
  let manualAvailable = true;
  const store = workerStore({
    claimPublicationOutcome: async () => publicationAvailable
      ? (publicationAvailable = false, workerLease("publication-special"))
      : undefined,
    claimManualResume: async () => manualAvailable && !publicationAvailable
      ? (manualAvailable = false, workerLease("manual-special"))
      : undefined,
    claim: async () => normalOrdinal < 3 ? workerLease(`normal-${++normalOrdinal}`) : undefined,
  });
  const worker = new RunWorker({
    ...workerDependencies(store, async () => {
      const runId = currentRunExecutionContext()!.lease.runId;
      started.push(runId);
      if (runId !== "manual-special") await release.promise;
    }),
    bindings: async (queueClass, limit = 4) => {
      if (queueClass === "manual_resume" && publicationAvailable) return [];
      return Array.from({ length: limit }, () => ({ reviewExecutionMode: "harness_async" } as PublicationBinding));
    },
  }, 4, 1);

  await worker.tick();
  await nextTurn();
  assert.equal(started.filter((id) => id === "publication-special").length, 1);
  assert.equal(started.filter((id) => id.startsWith("normal-")).length, 3);
  release.resolve();
  await worker.drain();
  await worker.tick();
  await worker.drain();
  assert.ok(started.includes("manual-special"), "manual work must follow publication work in the special lane");
  await worker.stop();
});

test("a reused artifact-backed step is rehydrated without another provider action", async () => {
  let claimed = false;
  let providerCalls = 0;
  let transitioned = "";
  const lease = workerLease("artifact-reuse");
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    beginStep: async () => ({
      id: "step", runId: lease.runId, stepKey: "cached", kind: "model",
      inputHash: "input", status: "succeeded", attemptId: "attempt", attemptNumber: 1,
      reused: true, outputHash: "a".repeat(64), resultRef: "b".repeat(64),
    }),
    loadStepOutput: async () => ({ cached: true }),
    transition: async (_lease, input) => { transitioned = input.to; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    const value = await currentRunExecutionContext()!.step(
      "cached", "model", "input", async () => { providerCalls += 1; return { cached: false }; },
    );
    assert.deepEqual(value, { cached: true });
  }));
  await worker.tick();
  await worker.drain();
  assert.equal(providerCalls, 0);
  assert.equal(transitioned, "succeeded");
  await worker.stop();
});

test("a Judge workflow completes without entering the publication path", async () => {
  let claimed = false;
  let transition: { to: string; outcomeCode?: string } | undefined;
  const lease = { ...workerLease("judge-run"), input: { workflow: "eval.judge.v1" } };
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    withLease: async (_lease, action) => action({
      query: async () => ({ rows: [{ allowed: true }] }),
    } as never),
    transition: async (_lease, input) => { transition = input; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => undefined));

  await worker.tick();
  await worker.drain();

  assert.deepEqual(transition, { to: "succeeded", outcomeCode: "evaluation_judge_completed" });
  await worker.stop();
});

test("shutdown waits for abort cleanup before returning the settled lease", async () => {
  const cleanup = deferred();
  const started = deferred();
  let relinquished = false;
  let claimed = false;
  const lease = workerLease("shutdown-run");
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    relinquishSettledLease: async () => { relinquished = true; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    const signal = currentRunExecutionContext()!.signal!;
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise;
    signal.throwIfAborted();
  }));
  await worker.tick();
  await started.promise;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false);
  assert.equal(relinquished, false, "lease cannot move while abort cleanup may still write");
  cleanup.resolve();
  await stopping;
  assert.equal(relinquished, true);
});

test("shutdown requeues after an abort-aware action finishes normally at the barrier", async () => {
  const cleanup = deferred();
  const started = deferred();
  let relinquished = 0;
  let claimed = false;
  const lease = workerLease("shutdown-normal-return");
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    relinquishSettledLease: async () => { relinquished += 1; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    const signal = currentRunExecutionContext()!.signal!;
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise;
    // Some HTTP clients resolve a response while cancellation is racing. The
    // worker's post-action assertActive barrier must still hand the lease back.
  }));
  await worker.tick();
  await started.promise;
  const stopping = worker.stop();
  await nextTurn();
  assert.equal(relinquished, 0);
  cleanup.resolve();
  await stopping;
  assert.equal(relinquished, 1);
});

test("a transient heartbeat failure is tolerated while the lease has a safe validity window", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const finish = deferred();
  const started = deferred();
  let heartbeatCalls = 0;
  let transitioned = "";
  let claimed = false;
  const lease = workerLease("heartbeat-run", 120_000);
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    heartbeat: async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) throw new Error("temporary database timeout");
      return lease;
    },
    transition: async (_lease, input) => { transitioned = input.to; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    const signal = currentRunExecutionContext()!.signal!;
    started.resolve();
    await finish.promise;
    assert.equal(signal.aborted, false);
  }));
  await worker.tick();
  await started.promise;
  t.mock.timers.tick(15_000);
  await nextTurn();
  finish.resolve();
  await worker.drain();
  assert.equal(transitioned, "succeeded");
  await worker.stop();
});

test("an authoritative heartbeat lease loss aborts the action without a stale write", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let claimed = false;
  let transitioned = false;
  let relinquished = false;
  const started = deferred();
  const lease = workerLease("lease-lost-run");
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    heartbeat: async () => { throw new RunLeaseLostError(lease.runId); },
    transition: async () => { transitioned = true; },
    relinquishSettledLease: async () => { relinquished = true; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    const signal = currentRunExecutionContext()!.signal!;
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  }));
  await worker.tick();
  await started.promise;
  t.mock.timers.tick(15_000);
  await worker.drain();
  assert.equal(transitioned, false);
  assert.equal(relinquished, false, "a stale owner must not attempt to release a lease it lost");
  await worker.stop();
});

test("deterministic schema errors fail once instead of entering retry_wait", async () => {
  let claimed = false;
  let transitioned = "";
  const lease = workerLease("schema-run");
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    transition: async (_lease, input) => { transitioned = input.to; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    z.object({ required: z.string() }).parse({});
  }));
  await worker.tick();
  await worker.drain();
  assert.equal(transitioned, "failed");
  await worker.stop();
});

test("frozen binding contract mismatches are permanent", async () => {
  let claimed = false;
  let transitioned = "";
  const lease = workerLease("binding-contract-run");
  const store = workerStore({
    claim: async () => claimed ? undefined : (claimed = true, lease),
    transition: async (_lease, input) => { transitioned = input.to; },
  });
  const worker = new RunWorker(workerDependencies(store, async () => {
    throw new Error("Durable review binding or revision mismatch");
  }));
  await worker.tick();
  await worker.drain();
  assert.equal(transitioned, "failed");
  await worker.stop();
});

function workerLease(runId: string, validForMs = 120_000): RunLease {
  return {
    tenantId: "tenant", runId, integrationId: "integration", jobId: `job-${runId}`,
    jobKind: "start", owner: "owner", epoch: 1, jobAttempt: 1,
    authorityGeneration: 1, executionModeGeneration: 1,
    deadlineAt: new Date(Date.now() + 300_000).toISOString(), baseSha: "base", headSha: "head",
    workflowVersionHash: "workflow", promptVersionHash: "prompt", modelVersionHash: "model",
    toolVersionHash: "tool", policyVersionHash: "policy", runtimeVersionHash: "runtime",
    input: { workflow: "review.single.v1" }, limits: {},
    runtimeConfig: { maxJobAttempts: 3, maxCheckpointBytes: 4 * 1024 * 1024 },
    leaseExpiresAt: new Date(Date.now() + validForMs).toISOString(),
  };
}

function workerStore(overrides: Partial<RunExecutionStore>): RunExecutionStore {
  return {
    claimPublicationOutcome: async () => undefined,
    claimManualResume: async () => undefined,
    claim: async () => undefined,
    latestCheckpoint: async () => undefined,
    withLease: async (_lease: RunLease, action: () => Promise<unknown>) => action(),
    heartbeat: async (lease: RunLease) => lease,
    transition: async () => undefined,
    relinquishSettledLease: async () => undefined,
    ...overrides,
  } as unknown as RunExecutionStore;
}

function workerDependencies(store: RunExecutionStore, execute: () => Promise<void>) {
  return {
    store,
    budget: { closeRunBudgetInTransaction: async () => "closed" } as unknown as ModelBudgetStore,
    bindings: async () => [{ reviewExecutionMode: "harness_async" } as PublicationBinding],
    runtimeHash: async () => "runtime",
    execute,
    onError: () => undefined,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
