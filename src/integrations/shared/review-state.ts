import { loadRuntimeStateValue, nowMs, saveRuntimeStateValue } from "#core";
import { readFeedbackSignals } from "./feedback-signals.js";

export function loadIncrementalReviewHead(params: {
  scope: string;
  key: string;
}): string | undefined {
  return loadRuntimeStateValue<string>(params.scope, params.key, nowMs());
}

export function rememberIncrementalReviewHead(params: {
  scope: string;
  key: string;
  headSha: string;
  ttlMs: number;
  maxEntries: number;
}): void {
  const headSha = params.headSha.trim();
  if (!headSha) {
    return;
  }
  const now = nowMs();
  saveRuntimeStateValue({
    scope: params.scope,
    key: params.key,
    value: headSha,
    expiresAt: now + Math.max(1, params.ttlMs),
    maxEntries: params.maxEntries,
  });
}

export function readMergedFeedbackSignals(params: {
  scope: string;
  scopedKey: string;
  fallbackKey?: string;
  maxSignals: number;
}): string[] {
  const maxSignals = Math.max(1, Math.floor(params.maxSignals));
  const scopedKey = params.scopedKey.trim();
  const fallbackKey = (params.fallbackKey ?? "").trim();
  if (!scopedKey) {
    return [];
  }

  const scoped = readFeedbackSignals({
    scope: params.scope,
    key: scopedKey,
  }).slice(0, maxSignals);

  if (!fallbackKey || fallbackKey === scopedKey) {
    return scoped;
  }

  const fallback = readFeedbackSignals({
    scope: params.scope,
    key: fallbackKey,
  });
  if (fallback.length === 0) {
    return scoped;
  }
  if (scoped.length === 0) {
    return fallback.slice(0, maxSignals);
  }

  const merged = [...scoped, ...fallback.filter((item) => !scoped.includes(item))];
  return merged.slice(0, maxSignals);
}
