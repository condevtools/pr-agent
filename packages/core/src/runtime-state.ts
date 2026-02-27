import { resolve } from "node:path";
import { readNumberEnv, readOptionalStringEnv } from "./env.js";
import { nowMs } from "./clock.js";
import { FileRuntimeStateStore } from "./runtime-state-file.js";
import { InMemoryRuntimeStateStore } from "./runtime-state-in-memory.js";
import { RedisRuntimeStateStore } from "./runtime-state-redis.js";
import { SqliteRuntimeStateStore } from "./runtime-state-sqlite.js";

type RuntimeStateBackend = "memory" | "file" | "fs" | "sqlite" | "redis";

const DEFAULT_RUNTIME_STATE_FILE = ".mr-agent-runtime-state.json";
const DEFAULT_RUNTIME_STATE_SQLITE_FILE = ".mr-agent-runtime-state.sqlite3";
const DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS = 1_000;
const DEFAULT_RUNTIME_STATE_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_STATE_FILE_STALE_LOCK_TIMEOUT_MS = 30_000;
const RUNTIME_STATE_FILE_LOCK_RETRY_MS = 25;

interface RuntimeStateRegistry {
  backend?: RuntimeStateBackend;
  memoryStore?: InMemoryRuntimeStateStore;
  fileStore?: FileRuntimeStateStore;
  fileStorePath?: string;
  sqliteStore?: SqliteRuntimeStateStore;
  sqliteStorePath?: string;
  redisStore?: RedisRuntimeStateStore;
}

const registry: RuntimeStateRegistry = {};

export function resolveRuntimeStateBackend(
  rawValue: string | undefined = readOptionalStringEnv("RUNTIME_STATE_BACKEND"),
): RuntimeStateBackend {
  const backend = (rawValue ?? "memory").trim().toLowerCase();
  if (backend === "file" || backend === "fs") {
    return backend;
  }
  if (backend === "sqlite" || backend === "sqlite3") {
    return "sqlite";
  }
  if (backend === "redis") {
    return "redis";
  }
  return "memory";
}

function getRuntimeStateBackend(): RuntimeStateBackend {
  if (!registry.backend) {
    registry.backend = resolveRuntimeStateBackend();
  }
  return registry.backend;
}

export function loadRuntimeStateValue<T>(
  scope: string,
  key: string,
  now = nowMs(),
): T | undefined {
  const scopeName = normalizeScope(scope);
  const stateKey = normalizeKey(key);
  if (!scopeName || !stateKey) {
    return undefined;
  }

  return getRuntimeStateStore().loadValue<T>(scopeName, stateKey, now);
}

export function saveRuntimeStateValue<T>(params: {
  scope: string;
  key: string;
  value: T;
  expiresAt: number;
  maxEntries?: number;
}): void {
  const scopeName = normalizeScope(params.scope);
  const stateKey = normalizeKey(params.key);
  if (!scopeName || !stateKey) {
    return;
  }

  getRuntimeStateStore().saveValue({
    scope: scopeName,
    key: stateKey,
    value: params.value,
    expiresAt: params.expiresAt,
    maxEntries: params.maxEntries,
  });
}

export function deleteRuntimeStateValue(scope: string, key: string): void {
  const scopeName = normalizeScope(scope);
  const stateKey = normalizeKey(key);
  if (!scopeName || !stateKey) {
    return;
  }

  getRuntimeStateStore().deleteValue(scopeName, stateKey);
}

export function clearRuntimeStateScope(scope: string): void {
  const scopeName = normalizeScope(scope);
  if (!scopeName) {
    return;
  }

  getRuntimeStateStore().clearScope(scopeName);
}

export function assertRuntimeStateBackendReady(): void {
  getRuntimeStateStore();
}

export async function prepareRuntimeStateBackend(): Promise<void> {
  const backend = getRuntimeStateBackend();
  if (backend === "redis") {
    await getRedisStore().waitUntilReady();
    return;
  }
  if (isFileBackend(backend)) {
    await getFileStore().waitUntilReady();
    return;
  }
  getRuntimeStateStore();
}

export function clearRuntimeStateStore(): void {
  const backend = getRuntimeStateBackend();
  if (backend === "redis") {
    getRedisStore().clearAllAndDispose();
    registry.redisStore = undefined;
  } else if (backend === "sqlite") {
    getSqliteStore().clearAllAndDispose();
    registry.sqliteStore = undefined;
    registry.sqliteStorePath = undefined;
  } else if (backend === "file" || backend === "fs") {
    getFileStore().clearAllAndDispose();
    registry.fileStore = undefined;
    registry.fileStorePath = undefined;
  } else {
    getMemoryStore().clearAll();
  }

  registry.backend = undefined;
}

export async function flushRuntimeStatePersistence(): Promise<void> {
  if (isFileBackend(getRuntimeStateBackend())) {
    await getFileStore().waitUntilReady();
    await getFileStore().flushWritesForTests();
  }
}

export function getRuntimeStateScopeEntryCount(scope: string): number {
  const scopeName = normalizeScope(scope);
  if (!scopeName) {
    return 0;
  }
  return getRuntimeStateStore().getScopeEntryCount(scopeName);
}

function getRuntimeStateStore():
  | InMemoryRuntimeStateStore
  | FileRuntimeStateStore
  | SqliteRuntimeStateStore
  | RedisRuntimeStateStore {
  const backend = getRuntimeStateBackend();
  if (backend === "redis") {
    return getRedisStore();
  }
  if (backend === "sqlite") {
    return getSqliteStore();
  }
  if (isFileBackend(backend)) {
    return getFileStore();
  }
  return getMemoryStore();
}

function getMemoryStore(): InMemoryRuntimeStateStore {
  if (!registry.memoryStore) {
    registry.memoryStore = new InMemoryRuntimeStateStore(DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS);
  }
  return registry.memoryStore;
}

function getFileStore(): FileRuntimeStateStore {
  const nextPath = resolveRuntimeStateFile();
  if (!registry.fileStore || registry.fileStorePath !== nextPath) {
    registry.fileStore = new FileRuntimeStateStore({
      filePath: nextPath,
      pruneIntervalMs: DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS,
      lockTimeoutMs: readNumberEnv(
        "RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS",
        DEFAULT_RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS,
      ),
      lockRetryMs: RUNTIME_STATE_FILE_LOCK_RETRY_MS,
      staleLockTimeoutMs: readNumberEnv(
        "RUNTIME_STATE_FILE_STALE_LOCK_TIMEOUT_MS",
        DEFAULT_RUNTIME_STATE_FILE_STALE_LOCK_TIMEOUT_MS,
      ),
    });
    registry.fileStorePath = nextPath;
  }
  return registry.fileStore;
}

function getSqliteStore(): SqliteRuntimeStateStore {
  const nextPath = resolveRuntimeStateSqliteFile();
  if (!registry.sqliteStore || registry.sqliteStorePath !== nextPath) {
    registry.sqliteStore = new SqliteRuntimeStateStore({
      filePath: nextPath,
      busyTimeoutMs: readNumberEnv(
        "RUNTIME_STATE_SQLITE_BUSY_TIMEOUT_MS",
        DEFAULT_RUNTIME_STATE_SQLITE_BUSY_TIMEOUT_MS,
      ),
      pruneIntervalMs: DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS,
    });
    registry.sqliteStorePath = nextPath;
  }
  return registry.sqliteStore;
}

function getRedisStore(): RedisRuntimeStateStore {
  if (!registry.redisStore) {
    const redisUrl = readOptionalStringEnv("REDIS_URL");
    if (!redisUrl) {
      throw new Error(
        "REDIS_URL environment variable is required when RUNTIME_STATE_BACKEND=redis",
      );
    }
    registry.redisStore = new RedisRuntimeStateStore({ redisUrl });
  }
  return registry.redisStore;
}

function isFileBackend(backend: RuntimeStateBackend): boolean {
  return backend === "file" || backend === "fs";
}

function resolveRuntimeStateFile(): string {
  const raw = readOptionalStringEnv("RUNTIME_STATE_FILE");
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_RUNTIME_STATE_FILE);
  }
  return resolve(raw);
}

function resolveRuntimeStateSqliteFile(): string {
  const raw = readOptionalStringEnv("RUNTIME_STATE_SQLITE_FILE");
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_RUNTIME_STATE_SQLITE_FILE);
  }
  return resolve(raw);
}

function normalizeScope(scope: string): string {
  return scope.trim().slice(0, 80);
}

function normalizeKey(key: string): string {
  return key.trim().slice(0, 240);
}
