import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseMaintenanceOnceArguments } from "../../src/agent-runtime/maintenance-process.js";
import { PeriodicMaintenanceLoop } from "../../src/agent-runtime/retention/periodic-loop.js";
import type { MaintenanceCycleResult } from "../../src/agent-runtime/retention/periodic-store.js";

const result: MaintenanceCycleResult = {
  schemaVersion: 1,
  action: "preview",
  candidates: {},
  applied: {},
};

test("periodic maintenance runs one cycle at a time and stops without starting another", async () => {
  const abort = new AbortController();
  let calls = 0;
  const loop = new PeriodicMaintenanceLoop({
    async run() {
      calls += 1;
      return result;
    },
  }, { action: "preview", contentDays: 30, replayDays: 90, traceDays: 400, batchLimit: 100 },
  5_000, () => abort.abort());

  await loop.run(abort.signal);
  await loop.stop();
  assert.equal(calls, 1);
});

test("stop waits for an in-flight maintenance transaction", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  const loop = new PeriodicMaintenanceLoop({
    async run() {
      started();
      await blocked;
      return result;
    },
  }, { action: "preview", contentDays: 30, replayDays: 90, traceDays: 400, batchLimit: 100 },
  5_000, () => abort.abort());
  const running = loop.run(abort.signal);
  await active;
  let stopped = false;
  const stopping = loop.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
});

test("one-shot maintenance defaults to preview and strictly validates its bounded arguments", () => {
  const generated = parseMaintenanceOnceArguments(["--once"]);
  assert.equal(generated.action, "preview");
  assert.match(generated.cycleId, /^[0-9a-f-]{36}$/);
  const exact = parseMaintenanceOnceArguments([
    "--once", "--action", "apply", "--cycle-id", "11111111-1111-4111-8111-111111111111",
  ]);
  assert.deepEqual(exact, { action: "apply", cycleId: "11111111-1111-4111-8111-111111111111" });
  assert.throws(() => parseMaintenanceOnceArguments(["--once", "--action", "delete"]),
    /preview or apply/);
  assert.throws(() => parseMaintenanceOnceArguments(["--once", "--tenant", "tenant-id"]), /Usage/);
  assert.throws(() => parseMaintenanceOnceArguments(["--once", "--cycle-id", "not-a-uuid"]), /UUID/);
});

test("admin CLI has no alternate retention apply path", async () => {
  const source = await readFile(new URL("../../src/agent-runtime/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RuntimeMaintenanceStore/);
  assert.doesNotMatch(source, /command === ["']retention["']/);
});
