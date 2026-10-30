import { performance } from "node:perf_hooks";

const OPERATIONS = ["tenant_budget_lock", "step_transaction", "lease_heartbeat"] as const;
export type DatabaseTimingOperation = typeof OPERATIONS[number];
export const DATABASE_TIMING_BUCKETS_MS = [1, 5, 10, 50, 100, 500, 1_000] as const;

interface TimingSample {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  /** Non-cumulative buckets followed by an overflow bucket. */
  buckets: number[];
}

/** Process-local, fixed-cardinality measurements; durations include SQL and network time. */
export class DatabaseTimings {
  private readonly samples = new Map<DatabaseTimingOperation, TimingSample>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  async measure<T>(operation: DatabaseTimingOperation, action: () => Promise<T>): Promise<T> {
    const start = this.now();
    let failed = false;
    try { return await action(); }
    catch (error) { failed = true; throw error; }
    finally {
      const elapsed = Math.max(0, this.now() - start);
      const sample = this.samples.get(operation) ?? {
        count: 0, errors: 0, totalMs: 0, maxMs: 0,
        buckets: Array.from({ length: DATABASE_TIMING_BUCKETS_MS.length + 1 }, () => 0),
      };
      sample.count += 1;
      sample.errors += Number(failed);
      sample.totalMs += elapsed;
      sample.maxMs = Math.max(sample.maxMs, elapsed);
      const bucket = DATABASE_TIMING_BUCKETS_MS.findIndex((upper) => elapsed <= upper);
      sample.buckets[bucket < 0 ? DATABASE_TIMING_BUCKETS_MS.length : bucket]! += 1;
      this.samples.set(operation, sample);
    }
  }

  snapshot(): Record<string, unknown> {
    return { schemaVersion: 1, bucketUpperBoundsMs: [...DATABASE_TIMING_BUCKETS_MS],
      operations: Object.fromEntries(OPERATIONS.flatMap((operation) => {
        const sample = this.samples.get(operation);
        return sample ? [[operation, { ...sample, buckets: [...sample.buckets] }]] : [];
      })) };
  }
}

const processTimings = new DatabaseTimings();
export function measureDatabaseOperation<T>(operation: DatabaseTimingOperation, action: () => Promise<T>): Promise<T> {
  return processTimings.measure(operation, action);
}
export function databaseTimingSnapshot(): Record<string, unknown> { return processTimings.snapshot(); }
