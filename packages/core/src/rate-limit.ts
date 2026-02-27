import {
  getRuntimeStateScopeEntryCount,
  loadRuntimeStateValue,
  loadRuntimeStateValueAsync,
  saveRuntimeStateValue,
  saveRuntimeStateValueAsync,
} from "./runtime-state.js";
import { nowMs } from "./clock.js";

const MAX_RATE_LIMIT_KEYS = 5_000;
const MAX_RATE_LIMIT_KEY_IDLE_MS = 24 * 60 * 60 * 1_000;
const RATE_LIMIT_STATE_SCOPE = "rate-limit-records";

export function normalizeRateLimitPart(
  raw: string | undefined,
  fallback: string,
): string {
  const normalized = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return normalized || fallback;
}

export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const safeKey = key.trim().slice(0, 240);
  if (!safeKey) {
    return false;
  }

  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindowMs = Math.max(1, Math.floor(windowMs));
  const now = nowMs();
  const windowStart = now - safeWindowMs;

  const existing =
    loadRuntimeStateValue<number[]>(RATE_LIMIT_STATE_SCOPE, safeKey, now) ?? [];
  const recent = existing
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > windowStart)
    .map((timestamp) => Math.floor(timestamp));

  if (recent.length >= safeLimit) {
    touchRateLimitRecord(safeKey, recent);
    return true;
  }

  recent.push(now);
  touchRateLimitRecord(safeKey, recent);
  return false;
}

export async function isRateLimitedAsync(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const safeKey = key.trim().slice(0, 240);
  if (!safeKey) {
    return false;
  }

  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindowMs = Math.max(1, Math.floor(windowMs));
  const now = nowMs();
  const windowStart = now - safeWindowMs;

  const existing =
    (await loadRuntimeStateValueAsync<number[]>(RATE_LIMIT_STATE_SCOPE, safeKey, now)) ?? [];
  const recent = existing
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > windowStart)
    .map((timestamp) => Math.floor(timestamp));

  if (recent.length >= safeLimit) {
    await touchRateLimitRecordAsync(safeKey, recent);
    return true;
  }

  recent.push(now);
  await touchRateLimitRecordAsync(safeKey, recent);
  return false;
}

function touchRateLimitRecord(key: string, timestamps: number[]): void {
  const latest = timestamps[timestamps.length - 1] ?? nowMs();
  saveRuntimeStateValue({
    scope: RATE_LIMIT_STATE_SCOPE,
    key,
    value: timestamps,
    expiresAt: latest + MAX_RATE_LIMIT_KEY_IDLE_MS,
    maxEntries: MAX_RATE_LIMIT_KEYS,
  });
}

async function touchRateLimitRecordAsync(
  key: string,
  timestamps: number[],
): Promise<void> {
  const latest = timestamps[timestamps.length - 1] ?? nowMs();
  await saveRuntimeStateValueAsync({
    scope: RATE_LIMIT_STATE_SCOPE,
    key,
    value: timestamps,
    expiresAt: latest + MAX_RATE_LIMIT_KEY_IDLE_MS,
    maxEntries: MAX_RATE_LIMIT_KEYS,
  });
}

export function getRateLimitRecordCount(): number {
  return getRuntimeStateScopeEntryCount(RATE_LIMIT_STATE_SCOPE);
}
