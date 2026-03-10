import { createHash, timingSafeEqual } from "node:crypto";

import {
  BadWebhookRequestError,
  WebhookAuthError,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
} from "#core";

const DEFAULT_GITLAB_WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;

let hasWarnedMissingSecret = false;

/**
 * Verify that the GitLab webhook body does not exceed the configured
 * maximum size. Accepts the raw body (string or Buffer) for accurate
 * byte-length measurement before any JSON parsing.
 *
 * Throws {@link BadWebhookRequestError} when the body is too large.
 */
export function verifyGitLabWebhookBodySize(
  rawBody: string | Buffer | number,
): void {
  const maxBodyBytes = Math.max(
    1,
    readNumberEnv(
      "GITLAB_WEBHOOK_MAX_BODY_BYTES",
      DEFAULT_GITLAB_WEBHOOK_MAX_BODY_BYTES,
    ),
  );
  const bodyBytes =
    typeof rawBody === "number"
      ? rawBody
      : typeof rawBody === "string"
        ? Buffer.byteLength(rawBody, "utf8")
        : rawBody.length;

  if (bodyBytes <= maxBodyBytes) {
    return;
  }

  throw new BadWebhookRequestError(
    `gitlab webhook payload too large: ${bodyBytes} bytes exceeds GITLAB_WEBHOOK_MAX_BODY_BYTES=${maxBodyBytes}`,
  );
}

/**
 * Verify that the `X-Gitlab-Token` header matches the configured
 * `GITLAB_WEBHOOK_SECRET`. GitLab uses a simple shared secret
 * (not HMAC), so we compare the raw token value using
 * timing-safe comparison.
 *
 * Behavior:
 * - When `GITLAB_WEBHOOK_SECRET` is set, the request must include
 *   a matching `X-Gitlab-Token` header; otherwise a 403 is thrown.
 * - When `GITLAB_REQUIRE_WEBHOOK_SECRET` is true but no secret is
 *   configured, a 400 is thrown.
 * - When no secret is configured and `GITLAB_REQUIRE_WEBHOOK_SECRET`
 *   is false (default), a warning is logged once and the request
 *   is accepted.
 *
 * @param headers  Normalized (lowercase-key) header record.
 * @param logger   Optional logger for the missing-secret warning.
 */
export function verifyGitLabWebhookToken(
  headers: Record<string, string | undefined>,
  logger?: { warn: (message: string) => void },
): void {
  const expected = readOptionalStringEnv("GITLAB_WEBHOOK_SECRET");

  if (!expected) {
    if (shouldRequireGitLabWebhookSecret()) {
      throw new BadWebhookRequestError(
        "GITLAB_WEBHOOK_SECRET is required when GITLAB_REQUIRE_WEBHOOK_SECRET=true",
      );
    }

    if (!hasWarnedMissingSecret) {
      hasWarnedMissingSecret = true;
      logger?.warn(
        "GITLAB_WEBHOOK_SECRET is not configured; GitLab webhook token verification is disabled.",
      );
    }
    return;
  }

  const actual = headers["x-gitlab-token"]?.trim();
  if (!actual) {
    throw new WebhookAuthError("missing x-gitlab-token header", 403);
  }

  if (!isGitLabWebhookTokenValid(expected, actual)) {
    throw new WebhookAuthError("invalid gitlab webhook token", 403);
  }
}

/**
 * Returns true when the deployment requires a GitLab webhook secret.
 * Reads `GITLAB_REQUIRE_WEBHOOK_SECRET` env var (defaults to false).
 */
export function shouldRequireGitLabWebhookSecret(
  rawValue: string | undefined = readOptionalStringEnv(
    "GITLAB_REQUIRE_WEBHOOK_SECRET",
  ),
): boolean {
  return parseBooleanEnv(rawValue);
}

/**
 * Timing-safe comparison of the expected and actual GitLab webhook
 * token. Both values are SHA-256 hashed before comparison so that
 * `timingSafeEqual` always receives equal-length buffers.
 */
export function isGitLabWebhookTokenValid(
  expected: string,
  actual: string,
): boolean {
  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}
