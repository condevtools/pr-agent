import { readNumberEnv, type FetchRetryOptions } from "@mr-agent/core";

export function buildGitHubHttpRetryOptions(): FetchRetryOptions {
  return {
    timeoutMs: readNumberEnv("GITHUB_HTTP_TIMEOUT_MS", 30_000),
    retries: readNumberEnv("GITHUB_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("GITHUB_HTTP_RETRY_BACKOFF_MS", 400),
  };
}

export function buildGitLabHttpRetryOptions(): FetchRetryOptions {
  return {
    timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
    retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
  };
}
