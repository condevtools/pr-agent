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
