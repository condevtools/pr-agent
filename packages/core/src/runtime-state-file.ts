import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { nowMs } from "./clock.js";
import { wait } from "./http.js";
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
  private readonly staleLockTimeoutMs: number;
  private readonly bootstrapPromise: Promise<void>;
  private bootstrapCompleted = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(params: {
    filePath: string;
    pruneIntervalMs: number;
    lockTimeoutMs: number;
    lockRetryMs: number;
    staleLockTimeoutMs?: number;
  }) {
    super(params.pruneIntervalMs, createEmptyRuntimeStateSnapshot());
    this.filePath = params.filePath;
    this.lockTimeoutMs = Math.max(1, Math.floor(params.lockTimeoutMs));
    this.lockRetryMs = Math.max(1, Math.floor(params.lockRetryMs));
    this.staleLockTimeoutMs = Math.max(1, Math.floor(params.staleLockTimeoutMs ?? 30_000));
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

  private mutationsDuringBootstrap = false;

  protected override onStateChanged(): void {
    if (!this.bootstrapCompleted) {
      this.mutationsDuringBootstrap = true;
      return;
    }
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
        try {
          await rename(tempPath, this.filePath);
        } catch (renameError) {
          await rm(tempPath, { force: true }).catch(() => {});
          throw renameError;
        }
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
    const lockInfoPath = `${lockPath}/lock-info.json`;
    const deadline = nowMs() + this.lockTimeoutMs;
    await mkdir(dirname(this.filePath), { recursive: true });

    while (true) {
      try {
        await mkdir(lockPath);
        await writeFile(
          lockInfoPath,
          JSON.stringify({ pid: process.pid, createdAt: nowMs() }),
          "utf8",
        );
        break;
      } catch (error) {
        if (!isFileLockContentionError(error)) {
          throw error;
        }
        if (await this.tryRemoveStaleLock(lockPath, lockInfoPath)) {
          continue;
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

  private async tryRemoveStaleLock(lockPath: string, lockInfoPath: string): Promise<boolean> {
    try {
      const raw = await readFile(lockInfoPath, "utf8");
      const info = JSON.parse(raw) as { pid?: number; createdAt?: number };
      const createdAt = typeof info.createdAt === "number" ? info.createdAt : 0;
      const lockAge = nowMs() - createdAt;
      if (lockAge < this.staleLockTimeoutMs) {
        return false;
      }
      logCore("warn", "runtime_state.file.stale_lock_removed", {
        lockPath,
        lockPid: info.pid,
        lockAge,
      });
      await rm(lockPath, { recursive: true, force: true });
      // Re-verify: another process may have already cleaned and re-acquired
      // the lock between our check and rm (TOCTOU). If a fresh lock now
      // exists, we did NOT successfully clear a stale lock — return false so
      // the caller retries normally instead of immediately re-acquiring.
      try {
        const recheck = await readFile(lockInfoPath, "utf8");
        const recheckInfo = JSON.parse(recheck) as { createdAt?: number };
        const recheckAge = nowMs() - (typeof recheckInfo.createdAt === "number" ? recheckInfo.createdAt : 0);
        if (recheckAge < this.staleLockTimeoutMs) {
          // A fresh lock was re-created by another process — do not treat as cleared.
          return false;
        }
      } catch {
        // Lock dir no longer exists — our rm succeeded cleanly.
      }
      return true;
    } catch {
      return false;
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
    this.bootstrapCompleted = true;
    if (this.mutationsDuringBootstrap) {
      this.onStateChanged();
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
