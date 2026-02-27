import { loadRuntimeStateValue, nowMs, saveRuntimeStateValue } from "@mr-agent/core";

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
