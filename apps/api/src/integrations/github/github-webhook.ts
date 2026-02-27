import {
  BadWebhookRequestError,
  WebhookAuthError,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
} from "@mr-agent/core";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  recordGitHubFeedbackSignal,
  runGitHubReview,
  type GitHubReviewContext,
  type LoggerLike,
  type MinimalGitHubOctokit,
} from "./github-review.js";
import {
  runGitHubIssuePolicyWorkflow,
  runGitHubPullRequestLifecycleWorkflow,
} from "./github-lifecycle.js";
import { resolveGitHubReviewBehaviorPolicy } from "./github-policy.js";
import {
  handleGitHubIssueCommentCommand,
} from "./github-issue-comment-command.js";
export { createRestBackedOctokit } from "./github-rest-client.js";
export {
  handleGitHubIssueCommentCommand,
  isGitHubBotCommentUser,
  isGitHubCommandRateLimited,
} from "./github-issue-comment-command.js";
import { createRestBackedOctokit } from "./github-rest-client.js";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;

const repositoryInfoPayloadSchema = z.object({
  name: z.string().min(1),
  owner: z.object({
    login: z.string().optional(),
    name: z.string().optional(),
  }),
  default_branch: z.string().optional(),
});

const pullRequestWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().optional(),
    html_url: z.string().optional(),
    merged: z.boolean().optional(),
    base: z
      .object({
        ref: z.string().optional(),
      })
      .optional(),
    head: z
      .object({
        ref: z.string().optional(),
        sha: z.string().optional(),
      })
      .optional(),
  }),
});

const issuesWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().optional(),
    pull_request: z.unknown().optional(),
    user: z
      .object({
        login: z.string().optional(),
      })
      .optional(),
  }),
});

const issueCommentWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string().optional(),
    user: z
      .object({
        type: z.string().optional(),
        login: z.string().optional(),
      })
      .optional(),
  }),
});

const pullRequestReviewThreadPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  pull_request: z
    .object({
      number: z.number().int().positive(),
    })
    .optional(),
});

function resolveOwner(repository: { owner: { login?: string; name?: string } }): string {
  return repository.owner.login ?? repository.owner.name ?? "";
}

export async function handlePlainGitHubWebhook(params: {
  payload: unknown;
  rawBody: string;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  skipSignatureVerification?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  verifyGitHubWebhookBodySize(params.rawBody);
  const eventName = params.headers["x-github-event"]?.toLowerCase();
  if (!eventName) {
    throw new BadWebhookRequestError("missing x-github-event header");
  }

  if (!params.skipSignatureVerification) {
    verifyWebhookSignature(params.rawBody, params.headers);
  }

  const token =
    readOptionalStringEnv("GITHUB_WEBHOOK_TOKEN") ??
    readOptionalStringEnv("GITHUB_TOKEN");
  if (!token) {
    throw new BadWebhookRequestError(
      "Missing GITHUB_WEBHOOK_TOKEN (or GITHUB_TOKEN) for plain webhook mode",
    );
  }

  const apiBaseUrl = (
    readOptionalStringEnv("GITHUB_API_URL") ??
    DEFAULT_GITHUB_API_URL
  ).replace(
    /\/$/,
    "",
  );
  const octokit = createRestBackedOctokit({ token, baseUrl: apiBaseUrl });
  return handleGitHubWebhookEvent({
    eventName,
    payload: params.payload,
    octokit,
    logger: params.logger,
    runtimeMode: "github-webhook",
  });
}

type PlainGitHubWebhookEventHandlerParams = {
  payload: unknown;
  octokit: MinimalGitHubOctokit;
  logger: LoggerLike;
  runtimeMode: GitHubWebhookRuntimeMode;
};

export type GitHubWebhookRuntimeMode = "github-app" | "github-webhook";

const plainGitHubWebhookEventHandlers: Record<
  string,
  (params: PlainGitHubWebhookEventHandlerParams) => Promise<{ ok: boolean; message: string }>
> = {
  pull_request: handlePullRequestEvent,
  issues: handleIssuesEvent,
  pull_request_review_thread: handlePullRequestReviewThreadEvent,
  issue_comment: handleIssueCommentEvent,
};

export async function handleGitHubWebhookEvent(params: {
  eventName: string;
  payload: unknown;
  octokit: MinimalGitHubOctokit;
  logger: LoggerLike;
  runtimeMode: GitHubWebhookRuntimeMode;
}): Promise<{ ok: boolean; message: string }> {
  const handler = plainGitHubWebhookEventHandlers[params.eventName];
  if (!handler) {
    return { ok: true, message: `ignored event ${params.eventName}` };
  }

  return handler({
    payload: params.payload,
    octokit: params.octokit,
    logger: params.logger,
    runtimeMode: params.runtimeMode,
  });
}

async function handlePullRequestEvent(
  params: PlainGitHubWebhookEventHandlerParams,
): Promise<{ ok: boolean; message: string }> {
  const payload = parsePayload(
    pullRequestWebhookPayloadSchema,
    params.payload,
    "pull_request",
  );
  const owner = resolveOwner(payload.repository);
  const repo = payload.repository.name;
  if (!owner || !repo || !payload.pull_request.number) {
    throw new BadWebhookRequestError("invalid pull_request payload");
  }

  const context = createReviewContext(owner, repo, params.octokit, params.logger);
  const action = payload.action?.toLowerCase();
  if (action === "closed" && payload.pull_request?.merged) {
    const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
      context,
      baseRef:
        payload.pull_request.base?.ref ?? payload.repository.default_branch,
    });
    await runGitHubReview({
      context,
      pullNumber: payload.pull_request.number,
      mode: "report",
      trigger: "merged",
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
      enableSecretScan: reviewBehavior.secretScanEnabled,
      secretScanCustomPatterns: reviewBehavior.secretScanCustomPatterns,
      enableAutoLabel: reviewBehavior.autoLabelEnabled,
      throwOnError: params.runtimeMode === "github-webhook",
    });
    return { ok: true, message: "pull_request review triggered" };
  }

  if (action === "opened" || action === "edited" || action === "synchronize") {
    await runGitHubPullRequestLifecycleWorkflow({
      context,
      pullNumber: payload.pull_request.number,
      title: payload.pull_request.title ?? "",
      body: payload.pull_request.body ?? "",
      headSha: payload.pull_request.head?.sha,
      baseRef: payload.pull_request.base?.ref,
      defaultBranch: payload.repository.default_branch,
      detailsUrl: payload.pull_request.html_url,
      action,
      trigger:
        action === "opened"
          ? "pr-opened"
          : action === "edited"
            ? "pr-edited"
            : "pr-synchronize",
    });
    return { ok: true, message: "pull_request policy check triggered" };
  }

  return { ok: true, message: "ignored pull_request action" };
}

async function handleIssuesEvent(
  params: PlainGitHubWebhookEventHandlerParams,
): Promise<{ ok: boolean; message: string }> {
  const payload = parsePayload(issuesWebhookPayloadSchema, params.payload, "issues");
  const action = payload.action?.toLowerCase();
  if (action !== "opened" && action !== "edited") {
    return { ok: true, message: "ignored issues action" };
  }
  if (payload.issue.pull_request) {
    return { ok: true, message: "ignored issue converted from pull request" };
  }

  const owner = resolveOwner(payload.repository);
  const repo = payload.repository.name;
  if (!owner || !repo || !payload.issue.number) {
    throw new BadWebhookRequestError("invalid issues payload");
  }

  const context = createReviewContext(owner, repo, params.octokit, params.logger);
  await runGitHubIssuePolicyWorkflow({
    context,
    issueNumber: payload.issue.number,
    title: payload.issue.title ?? "",
    body: payload.issue.body ?? "",
    defaultBranch: payload.repository.default_branch,
    author: payload.issue.user?.login ?? undefined,
  });
  return { ok: true, message: "issue policy check triggered" };
}

async function handlePullRequestReviewThreadEvent(
  params: PlainGitHubWebhookEventHandlerParams,
): Promise<{ ok: boolean; message: string }> {
  const payload = parsePayload(
    pullRequestReviewThreadPayloadSchema,
    params.payload,
    "pull_request_review_thread",
  );
  const owner = resolveOwner(payload.repository);
  const repo = payload.repository.name;
  if (!owner || !repo) {
    throw new BadWebhookRequestError("invalid pull_request_review_thread payload");
  }

  const action = payload.action?.toLowerCase();
  if (action !== "resolved" && action !== "unresolved") {
    return { ok: true, message: "ignored pull_request_review_thread action" };
  }

  const pullNumber = payload.pull_request?.number;
  const signal =
    action === "resolved"
      ? `PR #${pullNumber ?? "?"} review thread resolved: developer indicates suggestion fixed/high-value`
      : `PR #${pullNumber ?? "?"} review thread unresolved: developer indicates suggestion still not satisfied`;
  recordGitHubFeedbackSignal({
    owner,
    repo,
    pullNumber,
    signal,
  });
  return { ok: true, message: "pull_request_review_thread feedback recorded" };
}

async function handleIssueCommentEvent(
  params: PlainGitHubWebhookEventHandlerParams,
): Promise<{ ok: boolean; message: string }> {
  const payload = parsePayload(
    issueCommentWebhookPayloadSchema,
    params.payload,
    "issue_comment",
  );
  if (payload.action !== "created") {
    return { ok: true, message: "ignored issue_comment action" };
  }

  const isPullRequest = Boolean(payload.issue?.pull_request);
  const owner = resolveOwner(payload.repository);
  const repo = payload.repository.name;
  if (!owner || !repo || !payload.issue.number) {
    throw new BadWebhookRequestError("invalid issue_comment payload");
  }

  const context = createReviewContext(owner, repo, params.octokit, params.logger);
  return handleGitHubIssueCommentCommand({
    context,
    owner,
    repo,
    issueNumber: payload.issue.number,
    body: payload.comment?.body?.trim() ?? "",
    commentUser: payload.comment?.user,
    isPullRequest,
    issueTitle: payload.issue.title ?? "",
    issueBody: payload.issue.body ?? "",
    rateLimitPlatform: params.runtimeMode,
    throwOnError: params.runtimeMode === "github-webhook",
  });
}

function verifyGitHubWebhookBodySize(rawBody: string): void {
  const maxBodyBytes = Math.max(
    1,
    readNumberEnv(
      "GITHUB_WEBHOOK_MAX_BODY_BYTES",
      DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES,
    ),
  );
  const bodyBytes = Buffer.byteLength(rawBody, "utf8");
  if (bodyBytes <= maxBodyBytes) {
    return;
  }

  throw new BadWebhookRequestError(
    `webhook payload too large: ${bodyBytes} bytes exceeds GITHUB_WEBHOOK_MAX_BODY_BYTES=${maxBodyBytes}`,
  );
}

function parsePayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  eventName: string,
): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join(".") || "payload";
  throw new BadWebhookRequestError(
    `invalid ${eventName} payload: ${issuePath} ${firstIssue?.message ?? "schema validation failed"}`,
  );
}

function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
): void {
  const skipSignature = parseBooleanEnv(
    readOptionalStringEnv("GITHUB_WEBHOOK_SKIP_SIGNATURE"),
  );
  if (skipSignature) {
    if ((readOptionalStringEnv("NODE_ENV") ?? "").toLowerCase() === "production") {
      throw new WebhookAuthError(
        "GITHUB_WEBHOOK_SKIP_SIGNATURE is forbidden in production",
        403,
      );
    }
    return;
  }

  const secret =
    readOptionalStringEnv("GITHUB_WEBHOOK_SECRET") ??
    readOptionalStringEnv("WEBHOOK_SECRET");
  if (!secret) {
    throw new WebhookAuthError(
      "Missing GITHUB_WEBHOOK_SECRET (or WEBHOOK_SECRET) for plain webhook mode",
    );
  }

  const signatureHeader = headers["x-hub-signature-256"] ?? "";
  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  if (!isWebhookSignatureValid(expected, signatureHeader)) {
    throw new WebhookAuthError("invalid webhook signature", 403);
  }
}

export function isWebhookSignatureValid(expected: string, received: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

function createReviewContext(
  owner: string,
  repo: string,
  octokit: MinimalGitHubOctokit,
  logger: LoggerLike,
): GitHubReviewContext {
  return {
    repo: () => ({ owner, repo }),
    octokit,
    log: logger,
  };
}
