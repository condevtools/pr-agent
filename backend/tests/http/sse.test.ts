import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { RunApiAuthenticator } from "../../src/http/common/run-auth.js";
import test from "node:test";

import type { ServerResponse } from "node:http";

import { RunControlError, type RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import type { RunEventPage } from "../../src/agent-runtime/runs/query-store.js";
import { RunEventStreamHub } from "../../src/http/runs/event-stream.js";

const runId = randomUUID();
const principal: RunPrincipal = {
  subjectId: "stream-user", actorType: "user", tenantId: randomUUID(), integrationId: randomUUID(),
  permissions: ["runs:read"],
};

test("stream hands off durable history, advances across hidden events, and reconnects from the emitted cursor", async () => {
  const cursors: Array<string | undefined> = [];
  const queries = { events: async (_principal: RunPrincipal, _runId: string, after?: string) => {
    cursors.push(after);
    return page(after ? 2 : 0, after ? [] : [{ sequence: 1, type: "run.queued" }], "running");
  } };
  const first = new FakeResponse();
  const firstHub = new RunEventStreamHub(queries as never, options());
  await firstHub.open(principal, runId, undefined, first.asResponse());
  await settle();
  assert.match(first.body, /event: run\.queued/);
  assert.match(first.body, new RegExp(`id: ${runId}:2\nevent: cursor`));
  await firstHub.stop();

  const second = new FakeResponse();
  const secondHub = new RunEventStreamHub(queries as never, options());
  await secondHub.open(principal, runId, `${runId}:2`, second.asResponse());
  await settle();
  assert.ok(cursors.includes(`${runId}:2`));
  assert.doesNotMatch(second.body, /run\.queued/);
  await secondHub.stop();
});

test("blocked response is closed after the drain timeout instead of buffering indefinitely", async () => {
  const response = new FakeResponse({ writeReady: false });
  const hub = new RunEventStreamHub({ events: async () => page(0, [{ sequence: 1, type: "run.queued" }], "running") } as never,
    options({ drainTimeoutMs: 5 }));
  await hub.open(principal, runId, undefined, response.asResponse());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(response.ended, true);
  await hub.stop();
});

test("response close owns subscriber cleanup and later polls do not write to the closed stream", async () => {
  let calls = 0;
  const response = new FakeResponse();
  const hub = new RunEventStreamHub({ events: async () => {
    calls += 1;
    return page(0, [], "running");
  } } as never, options());
  await hub.open(principal, runId, undefined, response.asResponse());
  await settle();
  response.emit("close");
  const writes = response.writes.length;
  await hub.poll();
  assert.equal(response.writes.length, writes);
  assert.ok(calls >= 1);
  await hub.stop();
});

test("concurrent opens recheck global capacity after durable authorization", async () => {
  let release!: () => void;
  const authorized = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const hub = new RunEventStreamHub({ events: async () => {
    reads += 1;
    if (reads <= 2) await authorized;
    return page(0, [], "running");
  } } as never, options({ maxConnections: 1 }));
  const first = hub.open(principal, runId, undefined, new FakeResponse().asResponse());
  const second = hub.open(principal, runId, undefined, new FakeResponse().asResponse());
  await settle();
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected?.reason instanceof RunControlError);
  assert.equal(rejected.reason.code, "STREAM_CAPACITY");
  await hub.stop();
});

test("response errors remove the subscriber before later polling", async () => {
  let calls = 0;
  const response = new FakeResponse();
  const hub = new RunEventStreamHub({ events: async () => {
    calls += 1;
    return page(0, [], "running");
  } } as never, options());
  await hub.open(principal, runId, undefined, response.asResponse());
  await settle();
  response.emit("error", new Error("socket failed"));
  const callsAtError = calls;
  await hub.poll();
  assert.equal(calls, callsAtError);
  assert.equal(response.ended, true);
  await hub.stop();
});

test("binding revocation emits a stable stream error and closes the response", async () => {
  let calls = 0;
  const response = new FakeResponse();
  const hub = new RunEventStreamHub({ events: async () => {
    calls += 1;
    if (calls === 1) return page(0, [], "running");
    throw new RunControlError("RUN_NOT_FOUND", 404, "revoked");
  } } as never, options());
  await hub.open(principal, runId, undefined, response.asResponse());
  await settle();
  assert.match(response.body, /event: stream_error/);
  assert.match(response.body, /"code":"RUN_NOT_FOUND"/);
  assert.equal(response.ended, true);
  await hub.stop();
});

test("shutdown closes active responses and rejects new streams", async () => {
  const response = new FakeResponse();
  const hub = new RunEventStreamHub({ events: async () => page(0, [], "running") } as never, options());
  await hub.open(principal, runId, undefined, response.asResponse());
  await hub.stop();
  assert.equal(response.ended, true);
  await assert.rejects(hub.open(principal, runId, undefined, new FakeResponse().asResponse()), (error: unknown) =>
    error instanceof RunControlError && error.code === "SHUTTING_DOWN" && error.status === 503);
});

for (const firstExpires of [false, true]) {
  test(`same-subject streams retain individual credential expiry (first expires=${firstExpires})`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const records = ["first", "second"].map((token, index) => ({ ...principal,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(now + ((index === 0) === firstExpires ? 1000 : 60_000)).toISOString() }));
    const auth = new RunApiAuthenticator(JSON.stringify(records));
    const first = auth.authenticate("Bearer first"), second = auth.authenticate("Bearer second");
    let emit = false;
    const hub = new RunEventStreamHub({ events: async () => emit
      ? { ...page(3, [{ sequence: 3, type: "run.changed" }], "running"), highWater: `${runId}:3` }
      : page(0, [], "running") } as never, options(), (candidate) => auth.assertCurrent(candidate));
    const responses = [new FakeResponse(), new FakeResponse()];
    try {
      await hub.open(first, runId, undefined, responses[0]!.asResponse());
      await hub.open(second, runId, undefined, responses[1]!.asResponse());
      await settle();
      now += 1500; emit = true;
      await hub.poll();
      const expired = responses[firstExpires ? 0 : 1]!;
      const current = responses[firstExpires ? 1 : 0]!;
      assert.equal(expired.ended, true);
      assert.doesNotMatch(expired.body, /event: run.changed/);
      assert.equal(current.ended, false);
      assert.match(current.body, /event: run.changed/);
    } finally { await hub.stop(); }
  });
}

function page(after: number, events: Array<{ sequence: number; type: string }>, status: string): RunEventPage {
  return {
    events: events.map((event) => ({ id: `${runId}:${event.sequence}`, sequence: event.sequence, type: event.type,
      schemaVersion: 1, payload: { status: "queued" }, createdAt: new Date(0).toISOString() })),
    cursor: `${runId}:${Math.max(after, 2)}`, highWater: `${runId}:2`,
    snapshot: { id: runId, status, version: 1, runType: "review", baseSha: "base", headSha: "head",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), finishedAt: null,
      deadlineAt: new Date(60_000).toISOString(), outcomeCode: null, errorCode: null,
      parentRunId: null, cancelRequested: false, publicationStatus: null },
  };
}

function options(overrides: Partial<{ pollMs: number; keepaliveMs: number; drainTimeoutMs: number;
  maxBufferBytes: number; maxConnections: number; maxConnectionsPerPrincipal: number }> = {}) {
  return { pollMs: 60_000, keepaliveMs: 60_000, drainTimeoutMs: 20, maxBufferBytes: 1024,
    maxConnections: 10, maxConnectionsPerPrincipal: 10, ...overrides };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  ended = false;
  readonly writes: string[] = [];
  status?: number;
  headers?: Record<string, string>;
  private readonly writeReady: boolean;

  constructor(input: { writeReady?: boolean } = {}) {
    super();
    this.writeReady = input.writeReady ?? true;
  }

  get body(): string { return this.writes.join(""); }
  writeHead(status: number, headers: Record<string, string>): this { this.status = status; this.headers = headers; return this; }
  flushHeaders(): void {}
  write(chunk: string): boolean { this.writes.push(chunk); this.writableLength += Buffer.byteLength(chunk); return this.writeReady; }
  end(): this { this.ended = true; this.writableEnded = true; return this; }
  asResponse(): ServerResponse { return this as unknown as ServerResponse; }
}
