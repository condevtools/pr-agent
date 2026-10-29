import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import type { PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import type { ModelBudgetStore } from "../src/agent-runtime/budget/model-budget-store.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import type { RunExecutionStore } from "../src/agent-runtime/execution/store.js";
import { RunWorker } from "../src/agent-runtime/execution/run-worker.js";

test("an old attempt finishing its heartbeat cannot remove the replacement task from drain tracking", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const firstExecution = deferred();
  const firstHeartbeat = deferred();
  const secondExecution = deferred();
  let claimed = 0;
  let ready = true;
  let started = 0;
  const lease = { runId: "same-run", runtimeVersionHash: "runtime", jobAttempt: 1 } as RunLease;
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
