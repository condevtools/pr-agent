import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { nowMs } from "./clock.js";
import { logCore } from "./logger.js";
import { InMemoryRuntimeStateStore } from "./runtime-state-in-memory.js";
import {
  createEmptyRuntimeStateSnapshot,
  mergeRuntimeStateSnapshots,
  normalizeRuntimeStateSnapshot,
} from "./runtime-state-snapshot.js";

export class FileRuntimeStateStore extends InMemoryRuntimeStateStore {
  private readonly filePath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly bootstrapPromise: Promise<void>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(params: {
    filePath: string;
    pruneIntervalMs: number;
    lockTimeoutMs: number;
    lockRetryMs: number;
  }) {
    super(params.pruneIntervalMs, createEmptyRuntimeStateSnapshot());
    this.filePath = params.filePath;
    this.lockTimeoutMs = Math.max(1, Math.floor(params.lockTimeoutMs));
    this.lockRetryMs = Math.max(1, Math.floor(params.lockRetryMs));
    this.bootstrapPromise = this.loadInitialSnapshot();
  }

  clearAllAndDispose(): void {
    this.clearAll();
  }

  async waitUntilReady(): Promise<void> {
    await this.bootstrapPromise;
  }

  async flushWritesForTests(): Promise<void> {
    await this.bootstrapPromise;
    await this.persistQueue;
  }

  protected override onStateChanged(): void {
    const serialized = JSON.stringify(this.getSnapshot());
    this.persistQueue = this.persistQueue
      .then(async () => {
        await this.persistSnapshotBestEffort(serialized);
      })
      .catch((err) => {
        logCore("error", "runtime_state.file.persist_queue_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async persistSnapshotBestEffort(serializedSnapshot: string): Promise<void> {
    try {
      await this.withFileLock(async () => {
        const nextSnapshot = await this.mergeWithDiskSnapshot(serializedSnapshot);
        await mkdir(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.tmp-${nowMs()}-${randomUUID().slice(0, 8)}`;
        await writeFile(tempPath, nextSnapshot, "utf8");
        await rename(tempPath, this.filePath);
      });
    } catch (error) {
      logCore("warn", "runtime_state.file.persist_failed", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      // Best-effort persistence. Runtime behavior should not fail on storage issues.
    }
  }

  private async withFileLock<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    const deadline = nowMs() + this.lockTimeoutMs;
    await mkdir(dirname(this.filePath), { recursive: true });

    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (!isFileLockContentionError(error)) {
          throw error;
        }
        if (nowMs() >= deadline) {
          throw error;
        }
        await wait(this.lockRetryMs);
      }
    }

    try {
      return await task();
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch((err) => {
        logCore("warn", "runtime_state.file.lock_cleanup_error", {
          lockPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async mergeWithDiskSnapshot(serializedSnapshot: string): Promise<string> {
    try {
      const parsedSnapshot = JSON.parse(serializedSnapshot) as unknown;
      const incomingState = normalizeRuntimeStateSnapshot(parsedSnapshot);
      const existingRaw = await readFile(this.filePath, "utf8");
      const existingState = normalizeRuntimeStateSnapshot(JSON.parse(existingRaw) as unknown);
      return JSON.stringify(mergeRuntimeStateSnapshots(existingState, incomingState));
    } catch {
      return serializedSnapshot;
    }
  }

  private async loadInitialSnapshot(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const loaded = normalizeRuntimeStateSnapshot(parsed);
      this.snapshot = mergeRuntimeStateSnapshots(loaded, this.snapshot);
      logCore("debug", "runtime_state.file.loaded", {
        filePath: this.filePath,
      });
    } catch (error) {
      this.snapshot = mergeRuntimeStateSnapshots(
        createEmptyRuntimeStateSnapshot(),
        this.snapshot,
      );
      logCore("debug", "runtime_state.file.load_fallback_empty", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function isFileLockContentionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
