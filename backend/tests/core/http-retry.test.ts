import assert from "node:assert/strict";
import test from "node:test";

import {
  beginHttpShutdownWithRuntime,
  computeRetryDelayMs,
  createHttpLifecycleRuntime,
  fetchWithRetry,
} from "../../src/core/http/client.ts";
import {
  githubPublicationReconciliationGraceMs,
  gitLabPublicationReconciliationGraceMs,
} from "../../src/core/http/retry-options.ts";

test("publication reconciliation grace follows configured provider deadlines", () => {
  const previousGitHub = process.env.GITHUB_HTTP_TIMEOUT_MS;
  const previousGitLab = process.env.GITLAB_HTTP_TIMEOUT_MS;
  const previousGitHubRetries = process.env.GITHUB_HTTP_RETRIES;
  const previousGitLabRetries = process.env.GITLAB_HTTP_RETRIES;
  const previousGitHubBackoff = process.env.GITHUB_HTTP_RETRY_BACKOFF_MS;
  const previousGitLabBackoff = process.env.GITLAB_HTTP_RETRY_BACKOFF_MS;
  process.env.GITHUB_HTTP_TIMEOUT_MS = "7000";
  process.env.GITLAB_HTTP_TIMEOUT_MS = "11000";
  process.env.GITHUB_HTTP_RETRIES = "1";
  process.env.GITLAB_HTTP_RETRIES = "2";
  process.env.GITHUB_HTTP_RETRY_BACKOFF_MS = "100";
  process.env.GITLAB_HTTP_RETRY_BACKOFF_MS = "200";
  try {
    assert.equal(githubPublicationReconciliationGraceMs(), 52_360);
    assert.equal(gitLabPublicationReconciliationGraceMs(), 111_160);
  } finally {
    if (previousGitHub === undefined) delete process.env.GITHUB_HTTP_TIMEOUT_MS;
    else process.env.GITHUB_HTTP_TIMEOUT_MS = previousGitHub;
    if (previousGitLab === undefined) delete process.env.GITLAB_HTTP_TIMEOUT_MS;
    else process.env.GITLAB_HTTP_TIMEOUT_MS = previousGitLab;
    if (previousGitHubRetries === undefined) delete process.env.GITHUB_HTTP_RETRIES;
    else process.env.GITHUB_HTTP_RETRIES = previousGitHubRetries;
    if (previousGitLabRetries === undefined) delete process.env.GITLAB_HTTP_RETRIES;
    else process.env.GITLAB_HTTP_RETRIES = previousGitLabRetries;
    if (previousGitHubBackoff === undefined) delete process.env.GITHUB_HTTP_RETRY_BACKOFF_MS;
    else process.env.GITHUB_HTTP_RETRY_BACKOFF_MS = previousGitHubBackoff;
    if (previousGitLabBackoff === undefined) delete process.env.GITLAB_HTTP_RETRY_BACKOFF_MS;
    else process.env.GITLAB_HTTP_RETRY_BACKOFF_MS = previousGitLabBackoff;
  }
});

test("http retry delay grows exponentially by attempt", () => {
  assert.equal(computeRetryDelayMs(0, 400, 0), 400);
  assert.equal(computeRetryDelayMs(1, 400, 0), 800);
  assert.equal(computeRetryDelayMs(2, 400, 0), 1600);
});

test("http retry jitter stays within 0~20% of base backoff", () => {
  const base = computeRetryDelayMs(1, 500, 0);
  const middle = computeRetryDelayMs(1, 500, 0.5);
  const nearMax = computeRetryDelayMs(1, 500, 0.999999);

  assert.equal(base, 1000);
  assert.ok(middle >= 1000 && middle <= 1100);
  assert.ok(nearMax >= 1000 && nearMax <= 1100);
});

test("http retry delay applies max delay cap", () => {
  assert.equal(computeRetryDelayMs(10, 400, 0, 5_000), 5_000);
  assert.equal(computeRetryDelayMs(2, 400, 0, 5_000), 1_600);
});

test("fetchWithRetry retries retryable status and keeps success behavior", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response("temporary", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  };

  try {
    const response = await fetchWithRetry("https://example.test/retryable", {}, {
      retries: 2,
      backoffMs: 1,
      timeoutMs: 1000,
      retryOnStatuses: [500],
    });
    assert.equal(response.status, 200);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry does not retry non-retryable status", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response("bad request", { status: 400 });
  };

  try {
    const response = await fetchWithRetry("https://example.test/non-retryable", {}, {
      retries: 3,
      backoffMs: 1,
      timeoutMs: 1000,
      retryOnStatuses: [500],
    });
    assert.equal(response.status, 400);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry aborts immediately after http shutdown starts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  const runtime = createHttpLifecycleRuntime();

  try {
    beginHttpShutdownWithRuntime(runtime);
    await assert.rejects(
      () =>
        fetchWithRetry("https://example.test/shutdown", {}, {
          retries: 0,
          timeoutMs: 1000,
          runtime,
        }),
      /http client is shutting down/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
