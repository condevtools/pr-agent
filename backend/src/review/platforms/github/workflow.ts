import { assertRunActive, assertReviewRunRevision, currentRunLease, durableReviewAnalysis, durableReviewCollection } from "../../../agent-runtime/execution/run-context.js";
import { shouldQueueReview } from "../../intake/run-intake.js";
import { enqueueGitHubReview } from "../../intake/provider-intake.js";
import {
  ensureError,
  localizeText,
  readNumberEnv,
  readOptionalStringEnv,
  resolveUiLocale,
} from "#core";
import { analyzePullRequest, buildReportCommentMarkdown } from "#review";
import type { ReviewTrigger } from "#review";
import { findPotentialSecrets as findSharedPotentialSecrets } from "../../../repository/content-safety/secret-scan.js";
import {
  isAutoReviewTrigger,
  shouldSkipReviewForDraft,
  shouldUseIncrementalReview,
  shouldUseManagedReviewSummary,
} from "../../policy/triggers.js";
import { reviewMessage, reviewPartialNoFilesMessage } from "../../rendering/messages.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import { publishGitHubIssueCommentDurably } from "../../../integrations/github/publication/adapter.js";
import { type GitHubPublicationRuntime } from "../../../integrations/github/publication/contracts.js";
import type { GitHubPullSummary } from "../../../integrations/github/api/types.js";
import type { GitHubReviewRunParams } from "./contracts.js";
import { collectGitHubPullRequestContext } from "../../../integrations/github/repository/context.js";
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

const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    secretScanCustomPatterns = [],
    enableAutoLabel = true,
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
  const binding = resolvedPublicationRuntime.binding;
  if (!binding) throw new Error("GitHub review requires a trusted publication binding");
  let activePublicationRuntime = resolvedPublicationRuntime as GitHubPublicationRuntime;
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
      if (!lease) throw new Error("Publication batch execution requires a Run lease");
      await activePublicationRuntime.batchStore.attachExistingBatchToRun(lease, existing.id);
      await assertRunActive();
      assertGitHubBatchSucceeded(await activePublicationRuntime.batchCoordinator.execute(
        existing.scope.tenantId, existing.id, activePublicationRuntime.createAdapter, lease,
      ));
      return;
    }
  }
  const locale = resolveUiLocale();

  context.log.info(
    { owner, repo, pullNumber, mode, trigger },
    "Starting GitHub AI review",
  );

  const businessState = (await getAgentRuntimeServices()).businessState;
  const businessStateScope = {
    tenantId: binding.tenantId,
    integrationId: binding.id,
    platform: "github" as const,
    origin: binding.origin,
    repository: binding.repository,
    target: `pr:${pullNumber}`,
  };
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? await businessState.loadIncrementalHead(businessStateScope)
    : undefined;
  const feedbackSignals = await businessState.loadFeedbackSignals(businessStateScope);
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
      sourceKey: durableSourceKey!,
      sourceHash: durableSourceHash!,
    });
    if (batch.resumed) return;
    if (!batch.runtime) throw new Error("Durable GitHub publication batch runtime is required");
    activePublicationRuntime = batch.runtime;

    if (collected.files.length === 0) {
      const noDiffBody = collected.coverage?.status === "partial"
        ? reviewPartialNoFilesMessage(collected.coverage.reasonCodes, locale)
        : collected.filesTruncated
        ? appendGitHubFilesTruncatedWarning(
            reviewMessage("reviewNoDiff", locale),
            locale,
          )
        : undefined;
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
      await batch.finish();
      await businessState.rememberIncrementalHead({
        ...businessStateScope,
        headSha: collected.headSha,
        ttlMs: readNumberEnv("GITHUB_INCREMENTAL_STATE_TTL_MS", DEFAULT_INCREMENTAL_STATE_TTL_MS),
      });
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
    await businessState.rememberIncrementalHead({
      ...businessStateScope,
      headSha: collected.headSha,
      ttlMs: readNumberEnv("GITHUB_INCREMENTAL_STATE_TTL_MS", DEFAULT_INCREMENTAL_STATE_TTL_MS),
    });
  } catch (error) {
    const originalError = ensureError(error);
    context.log.error(
      { owner, repo, pullNumber, mode, trigger, error: originalError },
      "GitHub AI review failed",
    );
    throw originalError;
  }
}
