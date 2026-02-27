import {
  loadRuntimeStateValue,
  loadRuntimeStateValueAsync,
  nowMs,
  saveRuntimeStateValue,
  saveRuntimeStateValueAsync,
} from "@mr-agent/core";

export interface FeedbackSignalStoreOptions {
  scope: string;
  key: string;
  signal: string;
  ttlMs: number;
  maxSignals: number;
  maxEntries: number;
}

export function recordFeedbackSignal(
  options: FeedbackSignalStoreOptions,
): string[] {
  const normalizedSignal = options.signal.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!normalizedSignal) {
    return [];
  }

  const now = nowMs();
  const current =
    loadRuntimeStateValue<string[]>(options.scope, options.key, now) ?? [];
  const nextSignals = [
    normalizedSignal,
    ...current.filter((item) => item !== normalizedSignal),
  ].slice(0, options.maxSignals);

  saveRuntimeStateValue({
    scope: options.scope,
    key: options.key,
    value: nextSignals,
    expiresAt: now + Math.max(1, options.ttlMs),
    maxEntries: options.maxEntries,
  });

  return nextSignals;
}

export async function recordFeedbackSignalAsync(
  options: FeedbackSignalStoreOptions,
): Promise<string[]> {
  const normalizedSignal = options.signal.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!normalizedSignal) {
    return [];
  }

  const now = nowMs();
  const current =
    (await loadRuntimeStateValueAsync<string[]>(options.scope, options.key, now)) ?? [];
  const nextSignals = [
    normalizedSignal,
    ...current.filter((item) => item !== normalizedSignal),
  ].slice(0, options.maxSignals);

  await saveRuntimeStateValueAsync({
    scope: options.scope,
    key: options.key,
    value: nextSignals,
    expiresAt: now + Math.max(1, options.ttlMs),
    maxEntries: options.maxEntries,
  });

  return nextSignals;
}

export function readFeedbackSignals(options: {
  scope: string;
  key: string;
}): string[] {
  return loadRuntimeStateValue<string[]>(
    options.scope,
    options.key,
    nowMs(),
  ) ?? [];
}

export async function readFeedbackSignalsAsync(options: {
  scope: string;
  key: string;
}): Promise<string[]> {
  return (
    (await loadRuntimeStateValueAsync<string[]>(
      options.scope,
      options.key,
      nowMs(),
    )) ?? []
  );
}
