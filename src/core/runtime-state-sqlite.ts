import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { nowMs } from "./clock.js";

interface SqliteStatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close?(): void;
}

interface SqliteModuleLike {
  DatabaseSync: new (filename: string) => SqliteDatabaseLike;
}

interface SqliteStatements {
  load: SqliteStatementLike;
  save: SqliteStatementLike;
  delete: SqliteStatementLike;
  clearScope: SqliteStatementLike;
  clearAll: SqliteStatementLike;
  pruneExpiredScope: SqliteStatementLike;
  countScope: SqliteStatementLike;
  trimScope: SqliteStatementLike;
}

const require = createRequire(import.meta.url);

export class SqliteRuntimeStateStore {
  private db: SqliteDatabaseLike | undefined;
  private statements: SqliteStatements | undefined;
  private readonly scopeLastPruneAt = new Map<string, number>();
  private readonly pruneIntervalMs: number;
  private readonly readyPromise: Promise<void>;

  constructor(params: {
    filePath: string;
    busyTimeoutMs: number;
    pruneIntervalMs: number;
  }) {
    this.pruneIntervalMs = Math.max(1, Math.floor(params.pruneIntervalMs));
    this.initializeSync({
      filePath: params.filePath,
      busyTimeoutMs: params.busyTimeoutMs,
    });
    this.readyPromise = Promise.resolve();
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  loadValue<T>(scope: string, key: string, now: number): T | undefined {
    const statements = this.requireStatements();
    this.pruneScope(scope, now);

    const row = statements.load.get(scope, key) as
      | {
          value?: unknown;
          expiresAt?: unknown;
        }
      | undefined;
    if (!row) {
      return undefined;
    }

    const expiresAt = toSafeInteger(row.expiresAt);
    if (expiresAt <= now) {
      statements.delete.run(scope, key);
      return undefined;
    }

    if (typeof row.value !== "string") {
      statements.delete.run(scope, key);
      return undefined;
    }

    try {
      return JSON.parse(row.value) as T;
    } catch {
      statements.delete.run(scope, key);
      return undefined;
    }
  }

  saveValue<T>(params: {
    scope: string;
    key: string;
    value: T;
    expiresAt: number;
    maxEntries?: number;
  }): void {
    const statements = this.requireStatements();
    const now = nowMs();

    let serializedValue = "";
    try {
      serializedValue = JSON.stringify(params.value);
    } catch {
      return;
    }

    statements.save.run(
      params.scope,
      params.key,
      serializedValue,
      Math.max(0, Math.floor(params.expiresAt)),
      now,
    );

    this.pruneScope(params.scope, now);
    this.trimScope(params.scope, params.maxEntries);
  }

  deleteValue(scope: string, key: string): void {
    this.requireStatements().delete.run(scope, key);
  }

  clearScope(scope: string): void {
    this.requireStatements().clearScope.run(scope);
    this.scopeLastPruneAt.delete(scope);
  }

  clearAllAndDispose(): void {
    const statements = this.requireStatements();
    statements.clearAll.run();
    this.dispose();
  }

  getScopeEntryCount(scope: string): number {
    const row = this.requireStatements().countScope.get(scope) as
      | {
          count?: unknown;
        }
      | undefined;
    return toSafeInteger(row?.count);
  }

  private initializeSync(params: { filePath: string; busyTimeoutMs: number }): void {
    try {
      const sqliteModule = require("node:sqlite") as SqliteModuleLike;
      const busyTimeoutMs = resolveSqliteBusyTimeoutMs(params.busyTimeoutMs);
      mkdirSync(dirname(params.filePath), { recursive: true });

      const db = new sqliteModule.DatabaseSync(params.filePath);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`PRAGMA busy_timeout = ${toSqliteIntegerLiteral(busyTimeoutMs)};`);
      db.exec(`
CREATE TABLE IF NOT EXISTS runtime_state (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, key)
);
CREATE INDEX IF NOT EXISTS idx_runtime_state_scope_updated
  ON runtime_state(scope, updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_runtime_state_scope_expires
  ON runtime_state(scope, expires_at ASC);
`);

      this.db = db;
      this.statements = {
        load: db.prepare(
          "SELECT value, expires_at AS expiresAt, updated_at AS updatedAt FROM runtime_state WHERE scope = ? AND key = ?",
        ),
        save: db.prepare(
          "INSERT INTO runtime_state(scope, key, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
        ),
        delete: db.prepare("DELETE FROM runtime_state WHERE scope = ? AND key = ?"),
        clearScope: db.prepare("DELETE FROM runtime_state WHERE scope = ?"),
        clearAll: db.prepare("DELETE FROM runtime_state"),
        pruneExpiredScope: db.prepare(
          "DELETE FROM runtime_state WHERE scope = ? AND expires_at <= ?",
        ),
        countScope: db.prepare(
          "SELECT COUNT(*) AS count FROM runtime_state WHERE scope = ?",
        ),
        trimScope: db.prepare(
          "DELETE FROM runtime_state WHERE rowid IN (SELECT rowid FROM runtime_state WHERE scope = ? ORDER BY updated_at ASC LIMIT ?)",
        ),
      };
    } catch (error) {
      this.db = undefined;
      this.statements = undefined;
      throw new Error(
        `Failed to initialize sqlite runtime state backend: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private requireStatements(): SqliteStatements {
    if (!this.statements) {
      throw new Error("sqlite runtime state store is not initialized");
    }
    return this.statements;
  }

  private pruneScope(scope: string, now: number): void {
    const statements = this.requireStatements();
    const lastPruneAt = this.scopeLastPruneAt.get(scope) ?? 0;
    if (now - lastPruneAt < this.pruneIntervalMs) {
      return;
    }
    this.scopeLastPruneAt.set(scope, now);
    statements.pruneExpiredScope.run(scope, now);
  }

  private trimScope(scope: string, maxEntriesRaw: number | undefined): void {
    const statements = this.requireStatements();
    const maxEntries = Math.max(1, Math.floor(maxEntriesRaw ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(maxEntries)) {
      return;
    }

    const row = statements.countScope.get(scope) as
      | {
          count?: unknown;
        }
      | undefined;
    const count = toSafeInteger(row?.count);
    const overflow = Math.max(0, count - maxEntries);
    if (overflow <= 0) {
      return;
    }

    statements.trimScope.run(scope, overflow);
  }

  private dispose(): void {
    this.db?.close?.();
    this.db = undefined;
    this.statements = undefined;
    this.scopeLastPruneAt.clear();
  }
}

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number.MIN_SAFE_INTEGER;
    }
    return Number(value);
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveSqliteBusyTimeoutMs(value: number): number {
  const normalized = Math.max(1, Math.floor(value));
  if (!Number.isSafeInteger(normalized)) {
    throw new Error("invalid sqlite busy timeout");
  }
  return normalized;
}

function toSqliteIntegerLiteral(value: number): string {
  const normalized = resolveSqliteBusyTimeoutMs(value);
  const literal = String(normalized);
  if (!/^[0-9]+$/.test(literal)) {
    throw new Error("invalid sqlite integer literal");
  }
  return literal;
}
