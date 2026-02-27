import {
  AiConcurrencyLimiter,
  type AiConcurrencyLimiterOptions,
} from "./ai-concurrency.js";

const MAX_TENANT_LIMITERS = 10_000;
const tenantLimiters = new Map<string, AiConcurrencyLimiter>();

/**
 * Returns a per-tenant concurrency limiter, creating one on first access.
 *
 * Each tenant gets its own AiConcurrencyLimiter instance so that one tenant
 * cannot exhaust the concurrency budget of another.
 *
 * The cache is bounded to {@link MAX_TENANT_LIMITERS} entries. When the limit
 * is exceeded, the oldest entry (first inserted) is evicted — Map preserves
 * insertion order, so this acts as a simple FIFO cache.
 */
export function getTenantConcurrencyLimiter(
  tenantId: string,
  maxConcurrency: number,
): AiConcurrencyLimiter {
  let limiter = tenantLimiters.get(tenantId);
  if (limiter) {
    // Move to end (most recently used) by re-inserting
    tenantLimiters.delete(tenantId);
    tenantLimiters.set(tenantId, limiter);
    return limiter;
  }

  // Evict oldest entries if we've hit the cap
  while (tenantLimiters.size >= MAX_TENANT_LIMITERS) {
    const oldestKey = tenantLimiters.keys().next().value;
    if (oldestKey !== undefined) {
      tenantLimiters.delete(oldestKey);
    } else {
      break;
    }
  }

  const options: AiConcurrencyLimiterOptions = {
    resolveMaxConcurrency: () => maxConcurrency,
  };
  limiter = new AiConcurrencyLimiter(options);
  tenantLimiters.set(tenantId, limiter);
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
