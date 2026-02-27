import { readNumberEnv } from "./env.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BACKOFF_MS = 400;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const HTTP_SHUTDOWN_ERROR_MESSAGE = "http client is shutting down";

export class HttpLifecycleRuntime {
  private shutdownRequested = false;
  private shutdownController = new AbortController();

  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  getShutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  beginShutdown(): void {
    if (this.shutdownRequested) {
      return;
    }
    this.shutdownRequested = true;
    this.shutdownController.abort(new Error(HTTP_SHUTDOWN_ERROR_MESSAGE));
  }
}

export function createHttpLifecycleRuntime(): HttpLifecycleRuntime {
  return new HttpLifecycleRuntime();
}

const defaultHttpRuntime = createHttpLifecycleRuntime();

export interface FetchRetryOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxDelayMs?: number;
  retryOnStatuses?: number[];
  runtime?: HttpLifecycleRuntime;
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const runtime = options.runtime ?? defaultHttpRuntime;
  if (runtime.isShutdownRequested()) {
    throw new Error(HTTP_SHUTDOWN_ERROR_MESSAGE);
  }

  const timeoutMs = options.timeoutMs ?? readNumberEnv("HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const retries = options.retries ?? readNumberEnv("HTTP_RETRIES", DEFAULT_RETRY_COUNT);
  const backoffMs =
    options.backoffMs ?? readNumberEnv("HTTP_RETRY_BACKOFF_MS", DEFAULT_RETRY_BACKOFF_MS);
  const maxDelayMs =
    options.maxDelayMs ?? readNumberEnv("HTTP_RETRY_MAX_DELAY_MS", DEFAULT_RETRY_MAX_DELAY_MS);
  const retryOnStatuses =
    options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504];

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (runtime.isShutdownRequested()) {
      throw new Error(HTTP_SHUTDOWN_ERROR_MESSAGE);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
    const signal = mergeAbortSignals([
      controller.signal,
      init.signal,
      runtime.getShutdownSignal(),
    ]);

    try {
      const response = await fetch(input, {
        ...init,
        signal,
      });
      clearTimeout(timeout);

      if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
        return response;
      }

      await wait(computeRetryDelayMs(attempt, backoffMs, Math.random(), maxDelayMs));
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (runtime.isShutdownRequested()) {
        throw new Error(HTTP_SHUTDOWN_ERROR_MESSAGE);
      }

      if (attempt === retries) {
        break;
      }

      await wait(computeRetryDelayMs(attempt, backoffMs, Math.random(), maxDelayMs));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("request failed after retries");
}

export function beginHttpShutdown(): void {
  beginHttpShutdownWithRuntime(defaultHttpRuntime);
}

export function isHttpShutdownRequested(): boolean {
  return isHttpShutdownRequestedForRuntime(defaultHttpRuntime);
}

export function getHttpShutdownSignal(): AbortSignal {
  return getHttpShutdownSignalForRuntime(defaultHttpRuntime);
}

export function beginHttpShutdownWithRuntime(runtime: HttpLifecycleRuntime): void {
  runtime.beginShutdown();
}

export function isHttpShutdownRequestedForRuntime(
  runtime: HttpLifecycleRuntime,
): boolean {
  return runtime.isShutdownRequested();
}

export function getHttpShutdownSignalForRuntime(
  runtime: HttpLifecycleRuntime,
): AbortSignal {
  return runtime.getShutdownSignal();
}

export function computeRetryDelayMs(
  attempt: number,
  backoffMs: number,
  randomValue = Math.random(),
  maxDelayMs = Number.POSITIVE_INFINITY,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const safeBackoffMs = Math.max(0, Math.floor(backoffMs));
  const safeMaxDelayMs = Number.isFinite(maxDelayMs)
    ? Math.max(1, Math.floor(maxDelayMs))
    : Number.POSITIVE_INFINITY;
  const baseDelay = safeBackoffMs * 2 ** safeAttempt;
  const jitterMax = safeBackoffMs * 0.2;
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  const jitter = Math.floor(jitterMax * normalizedRandom);
  return Math.floor(Math.min(baseDelay + jitter, safeMaxDelayMs));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return new AbortController().signal;
  }

  if (active.length === 1) {
    return active[0] ?? new AbortController().signal;
  }

  return AbortSignal.any(active);
}
