import { nowMs } from "../time/clock.js";
import { InMemoryRefetchableCacheStore } from "./memory-store.js";

// Process-local refetchable cache only. Business state lives in PostgreSQL.
const store = new InMemoryRefetchableCacheStore(1_000);

export function resolveRefetchableCacheBackend(): "memory_cache" { return "memory_cache"; }
export function loadRefetchableCacheValue<T>(scope: string, key: string, now = nowMs()): T | undefined {
  const value = normalize(scope, key);
  return value ? store.loadValue<T>(value.scope, value.key, now) : undefined;
}
export function saveRefetchableCacheValue<T>(params: {
  scope: string; key: string; value: T; expiresAt: number; maxEntries?: number;
}): void {
  const normalized = normalize(params.scope, params.key);
  if (normalized) store.saveValue({ ...normalized, value: params.value,
    expiresAt: params.expiresAt, maxEntries: params.maxEntries });
}
export function deleteRefetchableCacheValue(scope: string, key: string): void {
  const value = normalize(scope, key); if (value) store.deleteValue(value.scope, value.key);
}
export function clearRefetchableCacheScope(scope: string): void { store.clearScope(scope.trim().slice(0,80)); }
export function clearRefetchableCache(): void { store.clearAll(); }
export function getRefetchableCacheScopeEntryCount(scope: string): number {
  return store.getScopeEntryCount(scope.trim().slice(0,80));
}
function normalize(scope: string, key: string): { scope: string; key: string } | undefined {
  const value = { scope: scope.trim().slice(0,80), key: key.trim().slice(0,240) };
  return value.scope && value.key ? value : undefined;
}
