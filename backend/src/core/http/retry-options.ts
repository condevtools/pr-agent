import { readNumberEnv, type FetchRetryOptions } from "#core";

export function buildGitHubHttpRetryOptions(): FetchRetryOptions {
  return {
    timeoutMs: readNumberEnv("GITHUB_HTTP_TIMEOUT_MS", 30_000),
    retries: readNumberEnv("GITHUB_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("GITHUB_HTTP_RETRY_BACKOFF_MS", 400),
    maxDelayMs: readNumberEnv("HTTP_RETRY_MAX_DELAY_MS", 10_000),
  };
}

export function buildGitLabHttpRetryOptions(): FetchRetryOptions {
  return {
    timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
    retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
    maxDelayMs: readNumberEnv("HTTP_RETRY_MAX_DELAY_MS", 10_000),
  };
}

/** Covers the bounded managed-target read, write, and revision verification after claim. */
export function githubPublicationReconciliationGraceMs(): number {
  return publicationGrace(buildGitHubHttpRetryOptions(), 3);
}

/** Covers dispatch plus the post-dispatch revision read. */
export function gitLabPublicationReconciliationGraceMs(): number {
  return publicationGrace(buildGitLabHttpRetryOptions(), 3);
}

function publicationGrace(options: FetchRetryOptions, requestBudget: number): number {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  let retryDelayMs = 0;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    retryDelayMs += Math.min(backoffMs * 2 ** attempt * 1.2, maxDelayMs);
  }
  const requestDeadlineMs = timeoutMs * (retries + 1) + retryDelayMs;
  const value = Math.ceil(requestDeadlineMs * requestBudget + 10_000);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60_000) {
    throw new Error("provider HTTP timeout produces an invalid publication reconciliation grace");
  }
  return value;
}
