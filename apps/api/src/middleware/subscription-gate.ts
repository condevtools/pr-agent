/**
 * Subscription gate — pure function that enforces plan-based limits.
 *
 * This module has **no side effects** and does not import any external
 * dependencies, making it trivially testable.
 */

const FREE_TIER_REVIEW_LIMIT = 50;
const FREE_TIER_REPO_LIMIT = 3;

export interface UsageCounts {
  reviewsThisMonth: number;
  activeRepos: number;
}

export interface SubscriptionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether the current usage is within the limits of the given plan.
 *
 * - Paid plans (`"pro"` and `"enterprise"`) have no enforced limits and
 *   always return `{ allowed: true }`.
 * - The `"free"` plan is capped at {@link FREE_TIER_REVIEW_LIMIT} reviews
 *   per month and {@link FREE_TIER_REPO_LIMIT} active repositories.
 *
 * @param plan  - The tenant's current plan identifier.
 * @param usage - Current usage counters for the tenant.
 * @returns An object indicating whether the operation is allowed, and an
 *          optional human-readable reason when it is not.
 */
export function checkSubscriptionLimits(
  plan: string,
  usage: UsageCounts,
): SubscriptionCheckResult {
  if (plan !== "free") return { allowed: true };

  if (usage.reviewsThisMonth >= FREE_TIER_REVIEW_LIMIT) {
    return {
      allowed: false,
      reason: `Free plan limited to ${FREE_TIER_REVIEW_LIMIT} reviews/month`,
    };
  }

  if (usage.activeRepos >= FREE_TIER_REPO_LIMIT) {
    return {
      allowed: false,
      reason: `Free plan limited to ${FREE_TIER_REPO_LIMIT} repositories`,
    };
  }

  return { allowed: true };
}
