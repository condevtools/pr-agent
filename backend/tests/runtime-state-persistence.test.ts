import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  clearAskConversationState,
  clearRateLimitState,
} from "../src/testing/runtime-state-test-api.ts";

const stateFile = join(
  "/tmp",
  `pr-agent-runtime-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);
const sqliteStateFile = join(
  "/tmp",
  `pr-agent-runtime-state-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite3`,
);
const lockStateFile = join(
  "/tmp",
  `pr-agent-runtime-state-lock-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test("dedupe state survives module reload via runtime state backend", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = stateFile;

  try {
    const runtime = await import(`../src/core/runtime-state.ts?runtime_a=${Date.now()}`);
    await runtime.prepareRuntimeStateBackend();
    runtime.clearRuntimeStateStore();
    const modA = await import(`../src/core/dedupe.ts?dedupe_a=${Date.now()}`);
    const modB = await import(`../src/core/dedupe.ts?dedupe_b=${Date.now()}`);
    const key = `dedupe-${Date.now()}`;

    assert.equal(modA.isDuplicateRequest(key, 10_000), false);
    assert.equal(modB.isDuplicateRequest(key, 10_000), true);

    modB.clearDuplicateRecord(key);
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
  }
});

test("rate-limit state survives module reload via runtime state backend", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = stateFile;

  try {
    const runtime = await import(`../src/core/runtime-state.ts?runtime_b=${Date.now()}`);
    await runtime.prepareRuntimeStateBackend();
    runtime.clearRuntimeStateStore();
    const modA = await import(`../src/core/rate-limit.ts?rate_a=${Date.now()}`);
    const modB = await import(`../src/core/rate-limit.ts?rate_b=${Date.now()}`);
    const key = `rate-${Date.now()}`;

    assert.equal(modA.isRateLimited(key, 1, 60_000), false);
    assert.equal(modB.isRateLimited(key, 1, 60_000), true);

    clearRateLimitState();
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
  }
});

test("ask conversation state survives module reload via runtime state backend", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = stateFile;

  try {
    const runtime = await import(`../src/core/runtime-state.ts?runtime_c=${Date.now()}`);
    await runtime.prepareRuntimeStateBackend();
    runtime.clearRuntimeStateStore();
    const modA = await import(`../src/core/ask-session.ts?ask_a=${Date.now()}`);
    const modB = await import(`../src/core/ask-session.ts?ask_b=${Date.now()}`);
    const sessionKey = `session-${Date.now()}`;

    modA.rememberAskConversationTurn({
      sessionKey,
      question: "What changed?",
      answer: "The error handling path was hardened.",
    });

    const turns = modB.loadAskConversationTurns(sessionKey);
    assert.equal(turns.length, 1);
    assert.match(turns[0]?.answer ?? "", /hardened/i);

    clearAskConversationState();
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
  }
});

test("runtime state backend supports sqlite persistence", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalSqliteFile = process.env.RUNTIME_STATE_SQLITE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "sqlite";
  process.env.RUNTIME_STATE_SQLITE_FILE = sqliteStateFile;

  try {
    const runtimeA = await import(`../src/core/runtime-state.ts?runtime_sqlite_a=${Date.now()}`);
    await runtimeA.prepareRuntimeStateBackend();
    runtimeA.clearRuntimeStateStore();
    runtimeA.saveRuntimeStateValue({
      scope: "sqlite-scope",
      key: "entry",
      value: { ok: true },
      expiresAt: Date.now() + 60_000,
    });

    const runtimeB = await import(`../src/core/runtime-state.ts?runtime_sqlite_b=${Date.now()}`);
    await runtimeB.prepareRuntimeStateBackend();
    const loaded = runtimeB.loadRuntimeStateValue<{ ok: boolean }>("sqlite-scope", "entry");
    assert.equal(loaded?.ok, true);
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_SQLITE_FILE = originalSqliteFile;
  }
});

test("runtime state sqlite backend fails fast on initialization errors", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalSqliteFile = process.env.RUNTIME_STATE_SQLITE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "sqlite";
  process.env.RUNTIME_STATE_SQLITE_FILE = "/dev/null/blocked.sqlite3";

  try {
    const runtime = await import(
      `../src/core/runtime-state.ts?runtime_sqlite_failfast=${Date.now()}`
    );
    await assert.rejects(
      () => runtime.prepareRuntimeStateBackend(),
      /failed to initialize sqlite runtime state backend/i,
    );
    assert.throws(
      () => runtime.loadRuntimeStateValue("scope", "key"),
      /failed to initialize sqlite runtime state backend/i,
    );
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_SQLITE_FILE = originalSqliteFile;
  }
});

test("runtime state backend readiness check fails fast for sqlite init errors", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalSqliteFile = process.env.RUNTIME_STATE_SQLITE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "sqlite";
  process.env.RUNTIME_STATE_SQLITE_FILE = "/dev/null/blocked.sqlite3";

  try {
    const runtime = await import(
      `../src/core/runtime-state.ts?runtime_sqlite_ready_failfast=${Date.now()}`
    );
    assert.throws(
      () => runtime.assertRuntimeStateBackendReady(),
      /failed to initialize sqlite runtime state backend/i,
    );
    await assert.rejects(
      () => runtime.prepareRuntimeStateBackend(),
      /failed to initialize sqlite runtime state backend/i,
    );
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_SQLITE_FILE = originalSqliteFile;
  }
});

test("runtime state file backend persists after temporary file lock contention", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  const originalLockTimeout = process.env.RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = lockStateFile;
  process.env.RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS = "2000";

  const lockPath = `${lockStateFile}.lock`;

  try {
    const runtimeA = await import(`../src/core/runtime-state.ts?runtime_file_lock_a=${Date.now()}`);
    await runtimeA.prepareRuntimeStateBackend();
    runtimeA.clearRuntimeStateStore();
    mkdirSync(lockPath, { recursive: true });
    const releaseTimer = setTimeout(() => {
      rmSync(lockPath, { recursive: true, force: true });
    }, 80);

    runtimeA.saveRuntimeStateValue({
      scope: "file-lock-scope",
      key: "entry",
      value: { ok: true },
      expiresAt: Date.now() + 60_000,
    });
    await runtimeA.flushRuntimeStatePersistence();
    clearTimeout(releaseTimer);

    const runtimeB = await import(`../src/core/runtime-state.ts?runtime_file_lock_b=${Date.now()}`);
    await runtimeB.prepareRuntimeStateBackend();
    const loaded = runtimeB.loadRuntimeStateValue<{ ok: boolean }>("file-lock-scope", "entry");
    assert.equal(loaded?.ok, true);
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
    process.env.RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS = originalLockTimeout;
    rmSync(lockPath, { recursive: true, force: true });
  }
});

test.after(() => {
  rmSync(stateFile, { force: true });
  rmSync(sqliteStateFile, { force: true });
  rmSync(`${sqliteStateFile}-wal`, { force: true });
  rmSync(`${sqliteStateFile}-shm`, { force: true });
  rmSync(lockStateFile, { force: true });
  rmSync(`${lockStateFile}.lock`, { recursive: true, force: true });
});
