import { nowMs, readNumberEnv, type Clock, systemClock } from "@mr-agent/core";

const DEFAULT_AI_MAX_CONCURRENCY = 4;
const DEFAULT_AI_MAX_QUEUE_SIZE = 200;
const DEFAULT_AI_SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

export interface AiConcurrencyStats {
  activeRequests: number;
  queuedRequests: number;
  shutdownRequested: boolean;
}

export interface AiConcurrencyLimiterOptions {
  clock?: Clock;
  resolveMaxConcurrency?: () => number;
  resolveMaxQueueSize?: () => number;
}

export class AiConcurrencyLimiter {
  private activeRequests = 0;
  private readonly waitQueue: Array<() => void> = [];
  private shutdownRequested = false;
  private readonly clock: Clock;
  private readonly resolveMaxConcurrency: () => number;
  private readonly resolveMaxQueueSize: () => number;

  constructor(options?: AiConcurrencyLimiterOptions) {
    this.clock = options?.clock ?? systemClock;
    this.resolveMaxConcurrency =
      options?.resolveMaxConcurrency ??
      (() =>
        Math.max(1, readNumberEnv("AI_MAX_CONCURRENCY", DEFAULT_AI_MAX_CONCURRENCY)));
    this.resolveMaxQueueSize =
      options?.resolveMaxQueueSize ??
      (() =>
        Math.max(1, readNumberEnv("AI_MAX_QUEUE_SIZE", DEFAULT_AI_MAX_QUEUE_SIZE)));
  }

  getStats(): AiConcurrencyStats {
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.waitQueue.length,
      shutdownRequested: this.shutdownRequested,
    };
  }

  beginShutdown(): void {
    this.shutdownRequested = true;
    while (this.waitQueue.length > 0) {
      this.waitQueue.shift()?.();
    }
  }

  async withLimit<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  async drain(
    timeoutMs = readNumberEnv(
      "AI_SHUTDOWN_DRAIN_TIMEOUT_MS",
      DEFAULT_AI_SHUTDOWN_DRAIN_TIMEOUT_MS,
    ),
  ): Promise<boolean> {
    this.beginShutdown();
    const deadline = nowMs(this.clock) + Math.max(1, timeoutMs);
    while (this.activeRequests > 0 && nowMs(this.clock) < deadline) {
      await sleep(50);
    }
    return this.activeRequests === 0;
  }

  private async acquire(): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error("AI reviewer is shutting down");
    }

    const limit = this.resolveMaxConcurrency();
    while (this.activeRequests >= limit) {
      if (this.waitQueue.length >= this.resolveMaxQueueSize()) {
        throw new Error(
          `AI reviewer queue is full (AI_MAX_QUEUE_SIZE=${this.resolveMaxQueueSize()})`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
      if (this.shutdownRequested) {
        throw new Error("AI reviewer is shutting down");
      }
    }

    this.activeRequests += 1;
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.waitQueue.shift()?.();
  }
}

export function createAiConcurrencyLimiter(
  options?: AiConcurrencyLimiterOptions,
): AiConcurrencyLimiter {
  return new AiConcurrencyLimiter(options);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
