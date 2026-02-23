import {
  createEmptyRuntimeStateSnapshot,
  type RuntimeStateEntry,
  type RuntimeStateSnapshot,
} from "./runtime-state-snapshot.js";
import { nowMs } from "./clock.js";

export class InMemoryRuntimeStateStore {
  protected snapshot: RuntimeStateSnapshot;
  private readonly scopeLastPruneAt = new Map<string, number>();
  private readonly pruneIntervalMs: number;

  constructor(pruneIntervalMs: number, initialSnapshot?: RuntimeStateSnapshot) {
    this.pruneIntervalMs = Math.max(1, Math.floor(pruneIntervalMs));
    this.snapshot = initialSnapshot ?? createEmptyRuntimeStateSnapshot();
  }

  loadValue<T>(scope: string, key: string, now: number): T | undefined {
    this.pruneScope(scope, now);
    const entry = this.snapshot.scopes[scope]?.[key];
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      delete this.snapshot.scopes[scope]?.[key];
      this.onStateChanged();
      return undefined;
    }
    return entry.value as T;
  }

  saveValue<T>(params: {
    scope: string;
    key: string;
    value: T;
    expiresAt: number;
    maxEntries?: number;
  }): void {
    const now = nowMs();
    const scopeState = this.getOrCreateScope(params.scope);
    scopeState[params.key] = {
      value: params.value,
      expiresAt: params.expiresAt,
      updatedAt: now,
    };

    this.pruneScope(params.scope, now);
    this.trimScope(params.scope, params.maxEntries);
    this.onStateChanged();
  }

  deleteValue(scope: string, key: string): void {
    const scopeState = this.snapshot.scopes[scope];
    if (!scopeState || !(key in scopeState)) {
      return;
    }

    delete scopeState[key];
    if (Object.keys(scopeState).length === 0) {
      delete this.snapshot.scopes[scope];
      this.scopeLastPruneAt.delete(scope);
    }
    this.onStateChanged();
  }

  clearScope(scope: string): void {
    if (!(scope in this.snapshot.scopes)) {
      return;
    }
    delete this.snapshot.scopes[scope];
    this.scopeLastPruneAt.delete(scope);
    this.onStateChanged();
  }

  clearAll(): void {
    this.snapshot = createEmptyRuntimeStateSnapshot();
    this.scopeLastPruneAt.clear();
    this.onStateChanged();
  }

  getScopeEntryCount(scope: string): number {
    return Object.keys(this.snapshot.scopes[scope] ?? {}).length;
  }

  protected getSnapshot(): RuntimeStateSnapshot {
    return this.snapshot;
  }

  protected onStateChanged(): void {
    // no-op for memory backend
  }

  private getOrCreateScope(scope: string): Record<string, RuntimeStateEntry> {
    const existing = this.snapshot.scopes[scope];
    if (existing) {
      return existing;
    }
    const created: Record<string, RuntimeStateEntry> = {};
    this.snapshot.scopes[scope] = created;
    return created;
  }

  private pruneScope(scope: string, now: number): void {
    const scopeState = this.snapshot.scopes[scope];
    if (!scopeState) {
      return;
    }
    const lastPruneAt = this.scopeLastPruneAt.get(scope) ?? 0;
    if (now - lastPruneAt < this.pruneIntervalMs) {
      return;
    }
    this.scopeLastPruneAt.set(scope, now);

    let removed = false;
    for (const [key, entry] of Object.entries(scopeState)) {
      if (entry.expiresAt <= now) {
        delete scopeState[key];
        removed = true;
      }
    }

    if (Object.keys(scopeState).length === 0) {
      delete this.snapshot.scopes[scope];
      this.scopeLastPruneAt.delete(scope);
      removed = true;
    }

    if (removed) {
      this.onStateChanged();
    }
  }

  private trimScope(scope: string, maxEntriesRaw: number | undefined): void {
    const scopeState = this.snapshot.scopes[scope];
    if (!scopeState) {
      return;
    }
    const maxEntries = Math.max(1, Math.floor(maxEntriesRaw ?? Number.POSITIVE_INFINITY));
    const entries = Object.entries(scopeState);
    if (!Number.isFinite(maxEntries) || entries.length <= maxEntries) {
      return;
    }

    entries
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, Math.max(0, entries.length - maxEntries))
      .forEach(([key]) => {
        delete scopeState[key];
      });
  }
}
