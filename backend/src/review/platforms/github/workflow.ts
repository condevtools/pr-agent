import { createHash } from "node:crypto";
import { assertRunActive, assertReviewRunRevision, currentRunLease, durableReviewAnalysis, durableReviewCollection } from "../../../agent-runtime/execution/run-context.js";
import { shouldQueueReview } from "../../intake/run-intake.js";
import { enqueueGitHubReview } from "../../intake/provider-intake.js";
import {
  clearDuplicateRecord,
  ensureError,
  isDuplicateRequest,
  localizeText,
  readOptionalStringEnv,
  resolveUiLocale,
} from "#core";
import { publishNotification } from "#integrations/notifications";
import { analyzePullRequest, buildReportCommentMarkdown } from "#review";
import type { ReviewTrigger } from "#review";
import { findPotentialSecrets as findSharedPotentialSecrets } from "../../../repository/content-safety/secret-scan.js";
import { getPublicErrorMessage } from "../../../commands/presentation/public-error.js";
import {
  isAutoReviewTrigger,
  resolveDedupeTtlMs,
  shouldSkipReviewForDraft,
  shouldUseIncrementalReview,
  shouldUseManagedReviewSummary,
} from "../../policy/triggers.js";
import { reviewMessage } from "../../rendering/messages.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime.js";
import { PendingPublicationError } from "../../../agent-runtime/publication/publication.js";
import { publishGitHubIssueCommentDurably } from "../../../integrations/github/publication/adapter.js";
import { type GitHubPublicationRuntime } from "../../../integrations/github/publication/contracts.js";
import type { GitHubPullSummary } from "../../../integrations/github/api/types.js";
import type { GitHubReviewRunParams } from "./contracts.js";
import { collectGitHubPullRequestContext } from "../../../integrations/github/repository/context.js";
import { getErrorMessage } from "../../../integrations/github/error.js";
import {
  publishGitHubNoDiffStatus,
  upsertGitHubManagedIssueComment,
} from "../../../integrations/github/publication/comments.js";
import {
  inferPullRequestLabels,
  maybeAppendGitHubFilesTruncatedWarning,
  appendGitHubFilesTruncatedWarning,
  assertGitHubBatchSucceeded,
  prepareGitHubPublicationBatch,
  publishGitHubLineComments,
  publishSecretWarningComment,
  tryAddPullRequestLabels,
} from "./publication.js";
import {
  getIncrementalHead,
  loadGitHubFeedbackSignals,
  rememberIncrementalHead,
} from "./state.js";

export function shouldSkipGitHubReviewForDraft(
  trigger: ReviewTrigger,
  isDraft: boolean,
): boolean {
  return shouldSkipReviewForDraft(trigger, isDraft);
}

export async function runGitHubReview(
  params: GitHubReviewRunParams,
): Promise<void> {
  const {
    context,
    pullNumber,
    mode,
    trigger,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    secretScanCustomPatterns = [],
    enableAutoLabel = true,
    throwOnError = false,
    publicationRuntime,
    sourceKey,
    sourceHash,
  } = params;
  const { owner, repo } = context.repo();
  const resolvedPublicationRuntime = publicationRuntime ??
    (await resolvePublicationRuntime({
      platform: "github",
      origin: readOptionalStringEnv("GITHUB_API_URL") ?? "https://api.github.com",
      repository: `${owner}/${repo}`,
    }));
  if (resolvedPublicationRuntime?.binding && resolvedPublicationRuntime.binding.platform !== "github") {
    throw new Error("GitHub review resolved a non-GitHub publication binding");
  }
  let activePublicationRuntime = resolvedPublicationRuntime as GitHubPublicationRuntime | undefined;
  const resolvedExecutionModeGeneration = activePublicationRuntime?.binding?.executionModeGeneration ?? 0;
  const durableSourceKey = sourceKey;
  const durableSourceHash = sourceHash;
  if (shouldQueueReview(activePublicationRuntime?.binding)) {
    const runId = await enqueueGitHubReview(params, activePublicationRuntime.binding!);
    params.onQueued?.(runId);
    context.log.info({ runId }, "Durable GitHub review queued");
    return;
  }
  if (activePublicationRuntime?.batchStore && activePublicationRuntime.batchCoordinator && activePublicationRuntime.createAdapter) {
    if (!durableSourceKey || !durableSourceHash) throw new Error("durable GitHub review requires an authenticated source key and hash");
    const existing = await activePublicationRuntime.batchStore.findBySource(
      { ...activePublicationRuntime.scope, target: String(pullNumber), revision: "source-lookup" },
      durableSourceKey,
      durableSourceHash,
    );
    if (existing) {
      const lease = currentRunLease();
      if (lease) await activePublicationRuntime.batchStore.attachExistingBatchToRun(lease, existing.id);
      else await activePublicationRuntime.batchStore.assertLegacyBatchExecution(
        existing,
        resolvedExecutionModeGeneration,
      );
      await assertRunActive();
      assertGitHubBatchSucceeded(await activePublicationRuntime.batchCoordinator.execute(
        existing.scope.tenantId, existing.id, activePublicationRuntime.createAdapter, lease,
        lease ? undefined : resolvedExecutionModeGeneration,
      ));
      return;
    }
  }
  const locale = resolveUiLocale();
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  const dedupeTtlMs = resolveDedupeTtlMs(trigger, mode, "GITHUB");

  if (!activePublicationRuntime && isDuplicateRequest(requestKey, dedupeTtlMs)) {
    if (trigger === "comment-command") {
      if (activePublicationRuntime) return;
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "`AI Review` 最近 5 分钟内已经执行过，本次请求已跳过。",
            en: "`AI Review` already ran in the last 5 minutes, skipped this request.",
          },
          locale,
        ),
      });
    }
    return;
  }

  context.log.info(
    { owner, repo, pullNumber, mode, trigger },
    "Starting GitHub AI review",
  );

  const reviewPrKey = `${owner}/${repo}#${pullNumber}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? getIncrementalHead(reviewPrKey)
    : undefined;
  const feedbackSignals = loadGitHubFeedbackSignals(owner, repo, pullNumber);
  let preloadedPullSummary: GitHubPullSummary | undefined;

  if (isAutoReviewTrigger(trigger)) {
    const prMeta = await context.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    preloadedPullSummary = prMeta.data;
    if (shouldSkipGitHubReviewForDraft(trigger, Boolean(prMeta.data.draft))) {
      context.log.info(
        { owner, repo, pullNumber, trigger },
        "Skipping GitHub AI review for draft pull request",
      );
      return;
    }
    if (
      !activePublicationRuntime &&
      trigger === "pr-edited" &&
      incrementalBaseSha &&
      incrementalBaseSha === prMeta.data.head.sha
    ) {
      context.log.info(
        { owner, repo, pullNumber, trigger, headSha: prMeta.data.head.sha },
        "Skipping GitHub AI review for pull_request.edited without code changes",
      );
      return;
    }
  }

  let progressCommentId: number | undefined;
  if (trigger === "comment-command" && !activePublicationRuntime) {
    const progress = await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: reviewMessage("reviewRunning", locale),
    });
    progressCommentId = progress.data.id;
  }

  try {
    const collected = await durableReviewCollection("github.collect_context.v1", () => collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      incrementalBaseSha: currentRunLease() ? undefined : incrementalBaseSha,
      customRules,
      includeCiChecks,
      feedbackSignals,
      pullSummary: preloadedPullSummary,
    }));
    assertReviewRunRevision(collected.baseSha, collected.headSha);
    const batch = await prepareGitHubPublicationBatch({
      runtime: activePublicationRuntime,
      pullNumber,
      revision: collected.headSha,
      sourceKey: durableSourceKey ?? "legacy",
      sourceHash: durableSourceHash ?? stableEventHash({ owner, repo, pullNumber, mode, trigger, dedupeSuffix }),
    });
    if (batch.resumed) return;
    activePublicationRuntime = batch.runtime;

    if (collected.files.length === 0) {
      const noDiffBody = collected.filesTruncated
        ? appendGitHubFilesTruncatedWarning(
            reviewMessage("reviewNoDiff", locale),
            locale,
          )
        : undefined;
      if (activePublicationRuntime) {
        await publishGitHubIssueCommentDurably({
          runtime: activePublicationRuntime,
          context,
          owner,
          repo,
          pullNumber,
          revision: collected.headSha,
          slot: "review-no-diff",
          body: noDiffBody ?? reviewMessage("reviewNoDiffSkipped", locale),
          managedMarkerKey: "review-no-diff",
        });
      } else {
        await publishGitHubNoDiffStatus({
          context,
          owner,
          repo,
          pullNumber,
          progressCommentId,
          markerKey: "review-no-diff",
          body: noDiffBody,
        });
      }
      await batch.finish();
      rememberIncrementalHead(reviewPrKey, collected.headSha);
      return;
    }

    const reviewResult = { ...await durableReviewAnalysis(collected.input, () => analyzePullRequest(collected.input)), coverage: collected.coverage };

    if (mode === "comment") {
      const posted = await publishGitHubLineComments(
        context,
        collected,
        reviewResult,
        locale,
        activePublicationRuntime,
      );
      const summaryBody = [
        reviewMessage("reviewCommentModeTitle", locale),
        "",
        localizeText(
          {
            zh: `已发布行级评论: **${posted.posted}**，跳过: **${posted.skipped}**`,
            en: `Line comments posted: **${posted.posted}**, skipped: **${posted.skipped}**`,
          },
          locale,
        ),
        "",
        reviewMessage("reviewCommentModeHint", locale),
      ].join("\n");
      const summaryBodyWithWarning = maybeAppendGitHubFilesTruncatedWarning(
        summaryBody,
        collected.filesTruncated,
        locale,
      );
      if (activePublicationRuntime) {
        await publishGitHubIssueCommentDurably({
          runtime: activePublicationRuntime,
          context,
          owner,
          repo,
          pullNumber,
          revision: collected.headSha,
          slot: "review-comment-summary",
          body: summaryBodyWithWarning,
          managedMarkerKey: shouldUseManagedReviewSummary(trigger)
            ? "review-comment-summary"
            : undefined,
        });
      } else if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitHubManagedIssueComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: summaryBodyWithWarning,
          markerKey: "review-comment-summary",
        });
      } else {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: summaryBodyWithWarning,
        });
      }
    } else {
      const body = buildReportCommentMarkdown(reviewResult, collected.files, {
        platform: "github",
        owner: collected.owner,
        repo: collected.repo,
        baseSha: collected.baseSha,
        headSha: collected.headSha,
      }, {
        locale,
      });
      const bodyWithWarning = maybeAppendGitHubFilesTruncatedWarning(
        body,
        collected.filesTruncated,
        locale,
      );
      if (activePublicationRuntime) {
        await publishGitHubIssueCommentDurably({
          runtime: activePublicationRuntime,
          context,
          owner,
          repo,
          pullNumber,
          revision: collected.headSha,
          slot: "review-report",
          body: bodyWithWarning,
          managedMarkerKey: shouldUseManagedReviewSummary(trigger)
            ? "review-report"
            : undefined,
        });
      } else if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitHubManagedIssueComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: bodyWithWarning,
          markerKey: "review-report",
        });
      } else {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: bodyWithWarning,
        });
      }
    }

    if (enableSecretScan) {
      const findings = findSharedPotentialSecrets({
        files: collected.files,
        customPatterns: secretScanCustomPatterns,
        maxFindings: 10,
      });
      if (findings.length > 0) {
        await publishSecretWarningComment({
          context,
          owner,
          repo,
          pullNumber,
          headSha: collected.headSha,
          findings,
          publicationRuntime: activePublicationRuntime,
        });
      }

      if (enableAutoLabel) {
        const labels = inferPullRequestLabels({
          title: collected.input.title,
          files: collected.files,
          reviewResult,
          hasSecretFinding: findings.length > 0,
        });
        await tryAddPullRequestLabels({
          context,
          owner,
          repo,
          pullNumber,
          labels,
          revision: collected.headSha,
          publicationRuntime: activePublicationRuntime,
        });
      }
    } else if (enableAutoLabel) {
      const labels = inferPullRequestLabels({
        title: collected.input.title,
        files: collected.files,
        reviewResult,
        hasSecretFinding: false,
      });
      await tryAddPullRequestLabels({
        context,
        owner,
        repo,
        pullNumber,
        labels,
        revision: collected.headSha,
        publicationRuntime: activePublicationRuntime,
      });
    }

    await batch.finish();
    rememberIncrementalHead(reviewPrKey, collected.headSha);

    if (progressCommentId) {
      await context.octokit.issues.updateComment({
        owner,
        repo,
        comment_id: progressCommentId,
        body: reviewMessage("reviewCompleted", locale),
      });
    }

    if (!activePublicationRuntime) try {
      await publishNotification({
        pushUrl:
          readOptionalStringEnv("GITHUB_PUSH_URL") ??
          readOptionalStringEnv("NOTIFY_WEBHOOK_URL"),
        author: collected.author,
        repository: `${owner}/${repo}`,
        sourceBranch: collected.headBranch,
        targetBranch: collected.baseBranch,
        content: localizeText(
          {
            zh: `代码评审完毕 https://github.com/${owner}/${repo}/pull/${pullNumber}`,
            en: `Code review completed https://github.com/${owner}/${repo}/pull/${pullNumber}`,
          },
          locale,
        ),
      });
    } catch (notifyError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(notifyError),
        },
        "Failed to publish GitHub success notification",
      );
    }
  } catch (error) {
    clearDuplicateRecord(requestKey);

    if (error instanceof PendingPublicationError) {
      throw error;
    }

    const reason = getErrorMessage(error);
    const publicReason = getPublicErrorMessage(error);
    context.log.error(
      { owner, repo, pullNumber, mode, trigger, error: reason },
      "GitHub AI review failed",
    );

    if (activePublicationRuntime) {
      throw ensureError(error);
    }

    try {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          reviewMessage("reviewFailureTitle", locale),
          "",
          localizeText(
            {
              zh: `错误：\`${publicReason}\``,
              en: `Error: \`${publicReason}\``,
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: "请检查 AI_PROVIDER/模型 API Key/GitHub App 权限配置。",
              en: "Please check AI_PROVIDER/model API key/GitHub App permission settings.",
            },
            locale,
          ),
        ].join("\n"),
      });
    } catch (commentError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(commentError),
        },
        "Failed to publish GitHub failure comment",
      );
    }

    if (progressCommentId) {
      try {
        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: progressCommentId,
          body: reviewMessage("reviewFailureProgressHint", locale),
        });
      } catch (updateError) {
        context.log.error(
          {
            owner,
            repo,
            pullNumber,
            mode,
            trigger,
            progressCommentId,
            error: getErrorMessage(updateError),
          },
          "Failed to update GitHub progress comment after failure",
        );
      }
    }

    try {
      await publishNotification({
        pushUrl:
          readOptionalStringEnv("GITHUB_PUSH_URL") ??
          readOptionalStringEnv("NOTIFY_WEBHOOK_URL"),
        author: "system",
        repository: `${owner}/${repo}`,
        sourceBranch: "-",
        targetBranch: "-",
        content: localizeText(
          {
            zh: `代码评审失败: ${publicReason}`,
            en: `Code review failed: ${publicReason}`,
          },
          locale,
        ),
      });
    } catch (notifyError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(notifyError),
        },
        "Failed to publish GitHub failure notification",
      );
    }

    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

function stableEventHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
