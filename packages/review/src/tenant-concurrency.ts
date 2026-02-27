import {
  AiConcurrencyLimiter,
  type AiConcurrencyLimiterOptions,
} from "./ai-concurrency.js";

const tenantLimiters = new Map<string, AiConcurrencyLimiter>();

/**
 * Returns a per-tenant concurrency limiter, creating one on first access.
 *
 * Each tenant gets its own AiConcurrencyLimiter instance so that one tenant
 * cannot exhaust the concurrency budget of another.
 */
export function getTenantConcurrencyLimiter(
  tenantId: string,
  maxConcurrency: number,
): AiConcurrencyLimiter {
  let limiter = tenantLimiters.get(tenantId);
  if (!limiter) {
    const options: AiConcurrencyLimiterOptions = {
      resolveMaxConcurrency: () => maxConcurrency,
    };
    limiter = new AiConcurrencyLimiter(options);
    tenantLimiters.set(tenantId, limiter);
  }
  return limiter;
}

/**
 * Removes a tenant's limiter from the cache (useful for cleanup / testing).
 */
export function removeTenantConcurrencyLimiter(tenantId: string): boolean {
  return tenantLimiters.delete(tenantId);
}

/**
 * Returns the number of cached tenant limiters (useful for monitoring).
 */
export function getTenantConcurrencyLimiterCount(): number {
  return tenantLimiters.size;
}
