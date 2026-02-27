import {
  deleteRuntimeStateValue,
  loadRuntimeStateValueAsync,
  loadRuntimeStateValue,
  saveRuntimeStateValueAsync,
  saveRuntimeStateValue,
  checkAndMarkDuplicateAsync,
} from "./runtime-state.js";
import { nowMs } from "./clock.js";

interface DedupeStateRecord {
  timestamp: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEDUPE_STATE_SCOPE = "dedupe-requests";
const MAX_DEDUPE_STATE_ENTRIES = 20_000;

export function isDuplicateRequest(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): boolean {
  const stateKey = normalizeDedupeKey(key);
  if (!stateKey) {
    return false;
  }

  const safeTtlMs = Math.max(1, Math.floor(ttlMs));
  const now = nowMs();
  const expiresAt = now + safeTtlMs;

  const persisted = loadRuntimeStateValue<DedupeStateRecord>(
    DEDUPE_STATE_SCOPE,
    stateKey,
    now,
  );
  if (persisted && persisted.expiresAt > now && now - persisted.timestamp < safeTtlMs) {
    return true;
  }

  saveRuntimeStateValue({
    scope: DEDUPE_STATE_SCOPE,
    key: stateKey,
    value: {
      timestamp: now,
      expiresAt,
    },
    expiresAt,
    maxEntries: MAX_DEDUPE_STATE_ENTRIES,
  });

  return false;
}

export async function isDuplicateRequestAsync(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<boolean> {
  const stateKey = normalizeDedupeKey(key);
  if (!stateKey) {
    return false;
  }

  const safeTtlMs = Math.max(1, Math.floor(ttlMs));

  // Use atomic check-and-set which leverages SET NX on Redis
  return checkAndMarkDuplicateAsync(DEDUPE_STATE_SCOPE, stateKey, safeTtlMs);
}

export function clearDuplicateRecord(key: string): void {
  const stateKey = normalizeDedupeKey(key);
  if (!stateKey) {
    return;
  }
  deleteRuntimeStateValue(DEDUPE_STATE_SCOPE, stateKey);
}

function normalizeDedupeKey(key: string): string {
  return key.trim().slice(0, 240);
}
