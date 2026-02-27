import { Redis } from "ioredis";
import { nowMs } from "./clock.js";
import { logCore } from "./logger.js";

export class RedisRuntimeStateStore {
  private redis: Redis;
  private readonly readyPromise: Promise<void>;

  constructor(params: { redisUrl: string }) {
    this.redis = new Redis(params.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 10) return null; // Stop retrying after 10 attempts
        return Math.min(times * 200, 5000); // Exponential backoff, max 5s
      },
      reconnectOnError(err: Error) {
        // Reconnect on READONLY errors (happens during Redis failover)
        return err.message.includes("READONLY");
      },
    });

    this.redis.on("error", (error: Error) => {
      logCore("warn", "runtime_state.redis.error", {
        error: error.message,
      });
    });

    this.readyPromise = this.redis.connect().then(
      () => {
        logCore("debug", "runtime_state.redis.connected", { url: redactUrl(params.redisUrl) });
      },
      (error: unknown) => {
        throw new Error(
          `Failed to connect to Redis at ${redactUrl(params.redisUrl)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  loadValue<T>(scope: string, key: string, now: number): T | undefined {
    // Redis operations are inherently async. This synchronous stub satisfies
    // the duck-typed store interface. For the Redis backend, callers in
    // runtime-state.ts should prefer loadValueAsync when possible.
    // Returns undefined (cache-miss semantics) – the value will be fetched
    // asynchronously on the next await-capable call path.
    return undefined;
  }

  /**
   * Async load – the primary way to read values from the Redis store.
   */
  async loadValueAsync<T>(scope: string, key: string, now: number): Promise<T | undefined> {
    const redisKey = toRedisKey(scope, key);
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      return undefined;
    }

    let entry: { value?: unknown; expiresAt?: unknown };
    try {
      entry = JSON.parse(raw) as { value?: unknown; expiresAt?: unknown };
    } catch (error) {
      logCore("warn", "runtime_state.redis.load_parse_error", {
        scope,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.redis.del(redisKey);
      return undefined;
    }

    const expiresAt =
      typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt)
        ? entry.expiresAt
        : 0;

    if (expiresAt > 0 && expiresAt <= now) {
      await this.redis.del(redisKey);
      return undefined;
    }

    return entry.value as T;
  }

  saveValue<T>(params: {
    scope: string;
    key: string;
    value: T;
    expiresAt: number;
    maxEntries?: number;
  }): void {
    // Fire-and-forget the async save. Errors are logged but not propagated.
    void this.saveValueAsync(params);
  }

  async saveValueAsync<T>(params: {
    scope: string;
    key: string;
    value: T;
    expiresAt: number;
    maxEntries?: number;
  }): Promise<void> {
    const now = nowMs();
    const redisKey = toRedisKey(params.scope, params.key);

    let serializedValue: string;
    try {
      serializedValue = JSON.stringify({
        value: params.value,
        expiresAt: params.expiresAt,
        updatedAt: now,
      });
    } catch (error) {
      logCore("warn", "runtime_state.redis.save_serialize_error", {
        scope: params.scope,
        key: params.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const ttlMs =
      params.expiresAt > 0 ? Math.max(0, Math.floor(params.expiresAt - now)) : 0;

    try {
      if (ttlMs > 0) {
        await this.redis.set(redisKey, serializedValue, "PX", ttlMs);
      } else {
        await this.redis.set(redisKey, serializedValue);
      }
    } catch (error) {
      logCore("warn", "runtime_state.redis.save_error", {
        scope: params.scope,
        key: params.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  deleteValue(scope: string, key: string): void {
    void this.deleteValueAsync(scope, key);
  }

  async deleteValueAsync(scope: string, key: string): Promise<void> {
    await this.redis.del(toRedisKey(scope, key));
  }

  clearScope(scope: string): void {
    void this.clearScopeAsync(scope);
  }

  async clearScopeAsync(scope: string): Promise<void> {
    const pattern = toRedisKey(scope, "*");
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  clearAllAndDispose(): void {
    void this.closeAsync();
  }

  getScopeEntryCount(scope: string): number {
    // Synchronous count is not feasible with Redis; return 0.
    // Async callers should use getScopeEntryCountAsync.
    return 0;
  }

  async getScopeEntryCountAsync(scope: string): Promise<number> {
    const pattern = toRedisKey(scope, "*");
    let cursor = "0";
    let count = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== "0");
    return count;
  }

  /**
   * Atomic check-and-set for dedup: uses Redis SET NX to atomically check
   * if a key exists and create it if not. Returns true if the key already
   * existed (i.e., the request IS a duplicate).
   */
  async checkAndMarkDuplicateAsync(
    scope: string,
    key: string,
    ttlMs: number,
  ): Promise<boolean> {
    const redisKey = toRedisKey(scope, key);
    const now = nowMs();
    const serialized = JSON.stringify({
      value: { timestamp: now, expiresAt: now + ttlMs },
      expiresAt: now + ttlMs,
      updatedAt: now,
    });
    try {
      const result = await this.redis.set(redisKey, serialized, "PX", ttlMs, "NX");
      // result === "OK" means key was newly set → NOT a duplicate
      // result === null means key already existed → IS a duplicate
      return result !== "OK";
    } catch (error) {
      logCore("warn", "runtime_state.redis.check_and_mark_error", {
        scope,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return false; // On error, allow the request to proceed
    }
  }

  /**
   * Ping the Redis server. Returns true if connection is healthy.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  /**
   * Atomic sliding-window rate limit using a Redis sorted set pipeline.
   *
   * Each request adds a unique member scored by the current timestamp.
   * Expired members (outside the window) are pruned, and ZCARD returns the
   * count of remaining members within the window — all inside a single
   * pipeline that executes atomically on the Redis server.
   *
   * Returns the count of requests within the window (AFTER adding the new one).
   */
  async incrementRateLimitAsync(
    scope: string,
    key: string,
    windowMs: number,
  ): Promise<number> {
    const redisKey = toRedisKey(scope, key);
    const now = nowMs();
    const windowStart = now - windowMs;
    // Unique member: timestamp + random suffix to avoid collisions
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

    try {
      const pipeline = this.redis.pipeline();
      pipeline.zadd(redisKey, now, member);
      pipeline.zremrangebyscore(redisKey, "-inf", windowStart);
      pipeline.zcard(redisKey);
      pipeline.pexpire(redisKey, Math.ceil(windowMs * 1.1));

      const results = await pipeline.exec();
      // results[2] is the ZCARD result: [error, count]
      const zcardResult = results?.[2];
      if (zcardResult && !zcardResult[0]) {
        return zcardResult[1] as number;
      }
      return 0;
    } catch (error) {
      logCore("warn", "runtime_state.redis.rate_limit_error", {
        scope,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  async closeAsync(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Swallow close errors
    }
  }
}

function toRedisKey(scope: string, key: string): string {
  return `mr-agent:state:${scope}:${key}`;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}
