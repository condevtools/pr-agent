import {
  BadWebhookRequestError,
  WebhookAuthError,
  githubOnboardingRestrictionsEnabled,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
} from "#core";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  enqueueGitHubReview,
} from "../../../review/platforms/github/workflow.js";
import type {
  GitHubReviewContext,
  LoggerLike,
} from "../../../review/platforms/github/contracts.js";
import type { MinimalGitHubOctokit } from "../api/types.js";
import {
  resolveGitHubPullRequestAutoReviewPolicy,
  resolveGitHubReviewBehaviorPolicy,
} from "../../../issues/policy/github/workflow.js";
import {
  handleGitHubIssueCommentCommand,
} from "../../../commands/platforms/github/handler.js";
import { CommandAuthorizationError } from "../../../commands/authorization.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { PublicationBindingNotFoundError, PublicationBindingBlockedError } from "../../../agent-runtime/authority/publication-authority.js";
import { handleGitHubProviderFeedback } from "../../../evolution/feedback/provider-bridge.js";
import { handleGitHubOnboardingLifecycle } from "../onboarding/lifecycle.js";
import { deferGitHubPullRequest } from "../onboarding/deferred-pull-request.js";
import { getGitHubInstallationSyncStore } from "../../../agent-runtime/runtime/github-onboarding.js";
import { bindingAllowsCapability, resolveRuntimeCapabilities } from "../../../agent-runtime/runtime/capabilities.js";
import { enqueueIssueTriage, IssueTriageRateLimitError } from "../../../issues/triage/intake.js";
import { loadIssueTriagePolicy } from "../../../issues/triage/policy.js";
import { parseGitHubIssue, parseGitHubIssueSubject } from "../issues/identity.js";
import { incrementMetricCounter } from "../../../http/system/metrics-runtime.js";
export { createRestBackedOctokit } from "../api/http-client.js";
export {
  handleGitHubIssueCommentCommand,
  isGitHubBotCommentUser,
  isGitHubCommandRateLimited,
} from "../../../commands/platforms/github/handler.js";
import { createRestBackedOctokit, guardGitHubOctokit } from "../api/http-client.js";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;

const repositoryInfoPayloadSchema = z.object({
  id: z.number().int().positive().optional(),
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
  changes: z.record(z.unknown()).optional(),
  sender: z.object({ type: z.string().optional(), login: z.string().optional() }).optional(),
  repository: repositoryInfoPayloadSchema,
  issue: z.object({
    id: z.number().int().positive().safe().optional(),
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    state: z.string().optional(),
    pull_request: z.unknown().optional(),
    user: z
      .object({
        login: z.string().optional(),
        type: z.string().optional(),
      })
      .nullish(),
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
    id: z.number().int().positive().optional(),
    body: z.string().optional(),
    user: z
      .object({
        id: z.number().int().positive().optional(),
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
  allowLifecycleMutation?: boolean;
  sourceHash?: string;
}): Promise<{ ok: boolean; message: string }> {
  verifyGitHubWebhookBodySize(params.rawBody);
  const eventName = params.headers["x-github-event"]?.toLowerCase();
  if (!eventName) {
    throw new BadWebhookRequestError("missing x-github-event header");
  }

  const isLifecycleEvent = eventName === "installation" || eventName === "installation_repositories";
  if (!params.skipSignatureVerification) {
    verifyWebhookSignature(params.rawBody, params.headers);
  }

  if (isLifecycleEvent && params.skipSignatureVerification && params.allowLifecycleMutation !== true) {
    return { ok: true, message: "ignored GitHub App lifecycle event during replay" };
  }
  if (isLifecycleEvent) verifyGitHubAppWebhookSignature(params.rawBody, params.headers);
  const lifecycleResult = await handleGitHubOnboardingLifecycle({
    eventName,
    payload: params.payload,
    deliveryId: params.headers["x-github-delivery"],
  });
  if (lifecycleResult) return lifecycleResult;

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
    deliveryId: params.headers["x-github-delivery"],
    sourceHash: params.sourceHash ?? createHash("sha256").update(params.rawBody).digest("hex"),
  });
}

type PlainGitHubWebhookEventHandlerParams = {
  payload: unknown;
  octokit: MinimalGitHubOctokit;
  logger: LoggerLike;
  runtimeMode: GitHubWebhookRuntimeMode;
  deliveryId?: string;
  sourceHash?: string;
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
  deliveryId?: string;
  sourceHash?: string;
}): Promise<{ ok: boolean; message: string }> {
  const lifecycleResult = await handleGitHubOnboardingLifecycle({
    eventName: params.eventName,
    payload: params.payload,
    deliveryId: params.deliveryId,
  });
  if (lifecycleResult) return lifecycleResult;
  const handler = plainGitHubWebhookEventHandlers[params.eventName];
  if (!handler) {
    return { ok: true, message: `ignored event ${params.eventName}` };
  }

  const sourceHash = params.sourceHash ?? createHash("sha256").update(JSON.stringify(params.payload)).digest("hex");
  try {
    return await handler({
      payload: params.payload,
      octokit: guardGitHubOctokit(params.octokit),
      logger: params.logger,
      runtimeMode: params.runtimeMode,
      deliveryId: params.deliveryId,
      sourceHash,
    });
  } catch (error) {
    if (error instanceof PublicationBindingNotFoundError || error instanceof PublicationBindingBlockedError) {
      if (params.eventName === "issues") {
        incrementMetricCounter("pr_agent_issue_triage_intake_total", { outcome: "unmanaged" });
        return { ok: true, message: "ignored issue: repository not active or not yet enrolled" };
      }
      const deferred = await deferGitHubPullRequest({ ...params, sourceHash }, getGitHubInstallationSyncStore);
      if (deferred) return deferred;
    }
    if (error instanceof PublicationBindingNotFoundError) {
      params.logger.info({ reason: "publication_binding_not_found" }, "ignored unmanaged GitHub repository");
      return { ok: true, message: "ignored unmanaged repository" };
    }
    if (error instanceof CommandAuthorizationError) {
      params.logger.info({ reason: "command_actor_not_authorized" }, "ignored unauthorized GitHub command");
      return { ok: true, message: "ignored unauthorized command" };
    }
    throw error;
  }
}

async function handlePullRequestEvent(
  params: PlainGitHubWebhookEventHandlerParams,
): Promise<{ ok: boolean; message: string; runId?: string }> {
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
  const isMerged = action === "closed" && Boolean(payload.pull_request?.merged);
  if (action !== "opened" && action !== "edited" && action !== "synchronize" && !isMerged) {
    return { ok: true, message: "ignored pull_request action" };
  }
  const publicationTarget = {
    platform: "github",
    origin: readOptionalStringEnv("GITHUB_API_URL") ?? DEFAULT_GITHUB_API_URL,
    repository: `${owner}/${repo}`,
  } as const;
  const admissionBinding = await (await getAgentRuntimeServices()).authority.resolve(
    publicationTarget.platform, publicationTarget.origin, publicationTarget.repository,
  );
  if (admissionBinding.state !== "active" || admissionBinding.reviewExecutionState !== "active") {
    throw new PublicationBindingBlockedError("github", `${owner}/${repo}`);
  }
  const durableRuntime = await resolvePublicationRuntime(publicationTarget);
  if (durableRuntime.binding.state !== "active"
      || durableRuntime.binding.reviewExecutionState !== "active") {
    throw new PublicationBindingBlockedError("github", `${owner}/${repo}`);
  }
  const baseRef = payload.pull_request.base?.ref ?? payload.repository.default_branch;
  const reviewBehavior = isMerged
    ? await resolveGitHubReviewBehaviorPolicy({ context, baseRef })
    : await resolveGitHubPullRequestAutoReviewPolicy({
      context,
      baseRef,
      action: action as "opened" | "edited" | "synchronize",
    });
  if (!isMerged && "enabled" in reviewBehavior && !reviewBehavior.enabled) {
    return { ok: true, message: "pull_request action ignored by review policy" };
  }
  const queuedRunId = await enqueueGitHubReview({
    context,
    pullNumber: payload.pull_request.number,
    mode: isMerged ? "report" : (reviewBehavior as Awaited<ReturnType<typeof resolveGitHubPullRequestAutoReviewPolicy>>).mode,
    trigger: isMerged ? "merged" : action === "opened" ? "pr-opened" : action === "edited" ? "pr-edited" : "pr-synchronize",
    publicationRuntime: durableRuntime as never,
    sourceKey: params.deliveryId ? `github:delivery:${params.deliveryId}` : undefined,
    sourceHash: params.sourceHash,
    customRules: reviewBehavior.customRules,
    includeCiChecks: reviewBehavior.includeCiChecks,
    enableSecretScan: reviewBehavior.secretScanEnabled,
    secretScanCustomPatterns: reviewBehavior.secretScanCustomPatterns,
    enableAutoLabel: reviewBehavior.autoLabelEnabled,
    throwOnError: true,
  });
  return { ok: true, message: "durable pull_request review queued", runId: queuedRunId };
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
  if (action === "edited" && !Object.hasOwn(payload.changes ?? {}, "title")
      && !Object.hasOwn(payload.changes ?? {}, "body")) {
    return { ok: true, message: "ignored issue edit without title or body changes" };
  }
  const isBot = (user?: { type?: string; login?: string }) => user?.type?.toLowerCase() === "bot"
    || user?.login?.toLowerCase().endsWith("[bot]") === true;
  if (payload.issue.user === null) return { ok: true, message: "ignored issue without a stable author identity" };
  if (isBot(payload.sender) || isBot(payload.issue.user) || payload.issue.state === "closed") {
    return { ok: true, message: "ignored bot or closed issue" };
  }
  if (!resolveRuntimeCapabilities().issueTriage) return ignoredIssueTriage("disabled");

  const owner = resolveOwner(payload.repository);
  const repo = payload.repository.name;
  if (!owner || !repo || !payload.issue.number || !payload.issue.id || !payload.repository.id) {
    throw new BadWebhookRequestError("invalid issues payload");
  }

  const runtime = await resolvePublicationRuntime({ platform: "github",
    origin: readOptionalStringEnv("GITHUB_API_URL") ?? DEFAULT_GITHUB_API_URL, repository: `${owner}/${repo}` });
  if (runtime.binding.providerRepositoryId !== payload.repository.id) {
    throw new BadWebhookRequestError("Issue repository identity does not match its binding");
  }
  if (!bindingAllowsCapability(runtime.binding, "issue.triage")
      || runtime.binding.reviewExecutionState !== "active") return ignoredIssueTriage("disabled");
  const context = createReviewContext(owner, repo, params.octokit, params.logger);
  const policy = await loadIssueTriagePolicy(context);
  if (!policy.enabled) return ignoredIssueTriage("disabled");
  if (!params.octokit.issues.get) throw new Error("GitHub Issue read API is unavailable");
  const current = (await params.octokit.issues.get({ owner, repo, issue_number: payload.issue.number })).data;
  const subject = parseGitHubIssueSubject(current);
  if (subject.id !== payload.issue.id || subject.number !== payload.issue.number) {
    throw new BadWebhookRequestError("Issue immutable identity changed before intake");
  }
  if (current.user == null) return { ok: true, message: "ignored issue without a stable author identity" };
  const issue = parseGitHubIssue(current);
  if (issue.state !== "open" || isBot(issue.user)) return { ok: true, message: "ignored bot or closed issue" };
  try {
    const run = await enqueueIssueTriage(runtime.binding, issue, policy.autoLabels);
    incrementMetricCounter("pr_agent_issue_triage_intake_total", { outcome: run.created ? "admitted" : "duplicate" });
    return { ok: true, message: run.created ? "durable Issue triage queued" : "Issue content already queued or analyzed" };
  } catch (error) {
    if (error instanceof IssueTriageRateLimitError) return ignoredIssueTriage("rate_limited");
    throw error;
  }
}

function ignoredIssueTriage(outcome: "disabled" | "rate_limited") {
  incrementMetricCounter("pr_agent_issue_triage_intake_total", { outcome });
  return { ok: true, message: `ignored Issue triage: ${outcome}` };
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
  return { ok: true,
    message: `ignored pull_request_review_thread ${action}: no authoritative Deep Review artifact correlation` };
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
  const providerFeedback = isPullRequest ? await handleGitHubProviderFeedback({
    context,
    origin: readOptionalStringEnv("GITHUB_API_URL") ?? DEFAULT_GITHUB_API_URL,
    owner,
    repo,
    repositoryId: payload.repository.id,
    pullNumber: payload.issue.number,
    body: payload.comment?.body?.trim() ?? "",
    commentId: payload.comment?.id,
    actor: payload.comment?.user,
  }) : undefined;
  if (providerFeedback) return providerFeedback;
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
    sourceKey: params.deliveryId
      ? `github:delivery:${params.deliveryId}`
      : payload.comment?.id
        ? `github:comment:${payload.comment.id}`
        : undefined,
    sourceHash: params.sourceHash,
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

export type GitHubWebhookSignatureKind = "app" | "plain";

export function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
): GitHubWebhookSignatureKind {
  const eventName = headers["x-github-event"]?.toLowerCase();
  if (eventName === "installation" || eventName === "installation_repositories") {
    verifyGitHubAppWebhookSignature(rawBody, headers);
    return "app";
  }
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
    return "plain";
  }
  const received = headers["x-hub-signature-256"] ?? "";
  const appSecret = readOptionalStringEnv("WEBHOOK_SECRET");
  const plainSecret = readOptionalStringEnv("GITHUB_WEBHOOK_SECRET");
  const appMode = githubOnboardingRestrictionsEnabled();
  if (appMode && appSecret
      && signatureMatches(rawBody, appSecret, received)) return "app";
  if (plainSecret && signatureMatches(rawBody, plainSecret, received)) return "plain";
  // Preserve the legacy single-secret plain webhook deployment when App mode is incomplete.
  if (!appMode && appSecret
      && signatureMatches(rawBody, appSecret, received)) return "plain";
  if (!plainSecret && !appSecret) {
    throw new WebhookAuthError(
      "Missing GITHUB_WEBHOOK_SECRET (or WEBHOOK_SECRET) for plain webhook mode",
    );
  }
  throw new WebhookAuthError("invalid webhook signature", 403);
}

/** Plain repository credentials never authorize App installation control-plane events. */
export function verifyGitHubAppWebhookSignature(rawBody: string, headers: Record<string, string | undefined>): void {
  const secret = readOptionalStringEnv("WEBHOOK_SECRET");
  if (!secret) throw new WebhookAuthError("GitHub App lifecycle events require WEBHOOK_SECRET", 403);
  if (!signatureMatches(rawBody, secret, headers["x-hub-signature-256"] ?? "")) {
    throw new WebhookAuthError("invalid GitHub App lifecycle signature", 403);
  }
}

function signatureMatches(rawBody: string, secret: string, received: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return isWebhookSignatureValid(expected, received);
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
