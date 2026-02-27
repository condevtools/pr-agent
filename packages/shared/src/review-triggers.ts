import { readNumberEnv } from "@mr-agent/core";
import type { ReviewMode, ReviewTrigger } from "@mr-agent/review";

export const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;

export function isAutoReviewTrigger(trigger: ReviewTrigger): boolean {
  return (
    trigger === "pr-opened" ||
    trigger === "pr-edited" ||
    trigger === "pr-synchronize"
  );
}

export function shouldUseManagedReviewSummary(trigger: ReviewTrigger): boolean {
  return isAutoReviewTrigger(trigger) || trigger === "merged";
}

export function shouldSkipReviewForDraft(
  trigger: ReviewTrigger,
  isDraft: boolean,
): boolean {
  return isDraft && isAutoReviewTrigger(trigger);
}

export function resolveDedupeTtlMs(
  trigger: ReviewTrigger,
  mode: ReviewMode,
  platformEnvPrefix = "",
): number {
  if (trigger === "merged" && mode === "report") {
    const envKey = platformEnvPrefix
      ? `${platformEnvPrefix}_MERGED_DEDUPE_TTL_MS`
      : "MERGED_DEDUPE_TTL_MS";
    return readNumberEnv(envKey, DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS);
  }

  return DEFAULT_DEDUPE_TTL_MS;
}

export function shouldUseIncrementalReview(trigger: ReviewTrigger): boolean {
  return trigger === "pr-synchronize" || trigger === "pr-edited";
}
