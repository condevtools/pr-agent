/**
 * Per-plan concurrency limits for AI review operations.
 */

const PLAN_CONCURRENCY: Record<string, number> = {
  free: 1,
  pro: 4,
  enterprise: 10,
};

const DEFAULT_CONCURRENCY = 1;

export function getPlanConcurrencyLimit(plan: string | undefined): number {
  return PLAN_CONCURRENCY[plan ?? "free"] ?? DEFAULT_CONCURRENCY;
}
