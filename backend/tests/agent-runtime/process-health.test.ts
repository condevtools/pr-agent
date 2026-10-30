import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ProcessHeartbeatLoop, type ProcessHeartbeatStore } from "../../src/agent-runtime/runtime/heartbeat.js";
import { localProcessIsHealthy, ProcessHealthMarker } from "../../src/agent-runtime/runtime/process-health.js";

test("local process health requires a fresh own-process marker and rejects malformed, stale or dead records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-health-"));
  const marker = new ProcessHealthMarker("worker", randomUUID(), directory, () => 10_000);
  const check = (now: number, isAlive = () => true) => localProcessIsHealthy({
    directory, role: "worker", staleAfterMs: 20_000, now, isAlive,
  });
  try {
    assert.equal(await check(10_000), false);
    await marker.record();
    assert.equal((await stat(join(directory, "worker.json"))).mode & 0o777, 0o600);
    assert.equal(await check(10_000), true);
    assert.equal(await check(9_999), false);
    assert.equal(await check(30_000), false);
    assert.equal(await check(10_001, () => false), false);
    await new ProcessHealthMarker("worker", randomUUID(), directory).clear();
    assert.equal(await check(10_001), true, "an unrelated instance cannot clear the marker");
    await marker.clear();
    assert.equal(await check(10_001), false);
    await writeFile(join(directory, "worker.json"), "private invalid payload");
    assert.equal(await check(10_001), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("own health follows this instance's successful PG beats and clears on failure and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-health-loop-"));
  const previous = process.env.PR_AGENT_HEALTH_DIRECTORY;
  process.env.PR_AGENT_HEALTH_DIRECTORY = directory;
  let fail = false;
  let removed = false;
  const store = { beat: async () => { if (fail) throw new Error("private database failure"); },
    remove: async () => { removed = true; } } as unknown as ProcessHeartbeatStore;
  const loop = new ProcessHeartbeatLoop(store, "recovery", {}, { intervalMs: 5000, staleAfterMs: 20000 },
    () => undefined, false);
  const healthy = () => localProcessIsHealthy({ directory, role: "recovery", staleAfterMs: 20000 });
  try {
    assert.equal(await healthy(), false);
    await loop.start();
    assert.equal(await healthy(), true);
    fail = true;
    await assert.rejects(loop.recordActivity(), /private database failure/u);
    assert.equal(await healthy(), false);
    fail = false;
    await loop.recordActivity();
    assert.equal(await healthy(), true);
    await loop.stop();
    assert.equal(removed, true);
    assert.equal(await healthy(), false);
  } finally {
    if (previous === undefined) delete process.env.PR_AGENT_HEALTH_DIRECTORY;
    else process.env.PR_AGENT_HEALTH_DIRECTORY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("web container health probes only local liveness and redacts failure output", async () => {
  let ok = true;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok, private: "do not log this" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const run = () => promisify(execFile)(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("../../src/agent-runtime/health-cli.ts", import.meta.url)), "--role", "web"], {
    env: { ...process.env, PORT: String(address.port) }, timeout: 5_000,
  });
  try {
    await run();
    ok = false;
    await assert.rejects(run(), (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      assert.match(stderr, /LOCAL_PROCESS_UNHEALTHY/u);
      assert.doesNotMatch(stderr, /do not log this/u);
      return true;
    });
    assert.deepEqual(paths, ["/health", "/health"]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("shutdown drains an in-flight beat and removes its marker even if PG deregistration fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-health-stop-"));
  const previous = process.env.PR_AGENT_HEALTH_DIRECTORY;
  process.env.PR_AGENT_HEALTH_DIRECTORY = directory;
  let finishBeat!: () => void;
  const pendingBeat = new Promise<void>((resolve) => { finishBeat = resolve; });
  const store = { beat: () => pendingBeat,
    remove: async () => { throw new Error("database unavailable during shutdown"); } } as unknown as ProcessHeartbeatStore;
  const loop = new ProcessHeartbeatLoop(store, "verifier", {}, { intervalMs: 5000, staleAfterMs: 20000 },
    () => undefined, false);
  try {
    const starting = loop.start();
    const stopping = assert.rejects(loop.stop(), /database unavailable during shutdown/u);
    finishBeat();
    await starting;
    await stopping;
    assert.equal(await localProcessIsHealthy({ directory, role: "verifier", staleAfterMs: 20000 }), false);
  } finally {
    if (previous === undefined) delete process.env.PR_AGENT_HEALTH_DIRECTORY;
    else process.env.PR_AGENT_HEALTH_DIRECTORY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
