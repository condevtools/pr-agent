import type { ReviewTrigger } from "#review";

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

export function shouldUseIncrementalReview(trigger: ReviewTrigger): boolean {
  return trigger === "pr-synchronize" || trigger === "pr-edited";
}
