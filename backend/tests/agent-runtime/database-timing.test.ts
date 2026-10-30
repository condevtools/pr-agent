import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseTimings } from "../../src/agent-runtime/database-timing.js";

test("database timing retains failure identity and measures success/failure without request labels", async () => {
  let clock = 0;
  const metrics = new DatabaseTimings(() => clock);
  assert.equal(await metrics.measure("step_transaction", async () => { clock += 5; return "done"; }), "done");
  const failure = new Error("private request content");
  await assert.rejects(metrics.measure("step_transaction", async () => { clock += 1_501; throw failure; }),
    (error) => error === failure);
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot, { schemaVersion: 1, bucketUpperBoundsMs: [1,5,10,50,100,500,1000],
    operations: { step_transaction: { count: 2, errors: 1, totalMs: 1506, maxMs: 1501,
      buckets: [0,1,0,0,0,0,0,1] } } });
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  const operations = snapshot.operations as Record<string, { buckets: number[] }>;
  operations.step_transaction!.buckets[0] = 99;
  assert.equal(JSON.stringify(metrics.snapshot()).includes("99"), false);
});
