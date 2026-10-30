import { clearDuplicateRecord, ensureError, isDuplicateRequest, localizeText, readOptionalStringEnv, resolveUiLocale } from "#core";
import { assertRunActive, assertReviewRunRevision, currentRunLease, durableReviewAnalysis, durableReviewCollection } from "../../../agent-runtime/execution/run-context.js";
import { PendingPublicationError } from "../../../agent-runtime/publication/publication.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime.js";
import { publishGitLabNoteDurably, type GitLabPublicationRuntime } from "../../../integrations/gitlab/publication/adapter.js";
import { buildGitLabCommentTargetFromPayload, collectGitLabMergeRequestContext, requireGitLabToken } from "../../../integrations/gitlab/repository/context.js";
import type { GitLabMrWebhookBody } from "../../../integrations/gitlab/webhooks/contracts.js";
import type { LoggerLike } from "../../../integrations/gitlab/webhooks/contracts.js";
import { publishNotification } from "#integrations/notifications";
import { enqueueGitLabReview } from "../../intake/provider-intake.js";
import { shouldQueueReview } from "../../intake/run-intake.js";
import { analyzePullRequest, buildReportCommentMarkdown, type ReviewMode, type ReviewTrigger } from "#review";
import { findPotentialSecrets as findSharedPotentialSecrets } from "../../../repository/content-safety/secret-scan.js";
import { buildSecretWarningComment } from "../../rendering/secret-warning.js";
import { reviewMessage } from "../../rendering/messages.js";
import { resolveDedupeTtlMs, shouldSkipReviewForDraft, shouldUseIncrementalReview, shouldUseManagedReviewSummary } from "../../policy/triggers.js";
import { getIncrementalHead, loadGitLabFeedbackSignals, rememberIncrementalHead } from "./state.js";
import { assertGitLabBatchSucceeded, inferMergeRequestLabels, prepareGitLabPublicationBatch, publishGitLabGeneralComment, publishGitLabLineComments, publishGitLabReviewNote, stableGitLabEventHash, tryAddGitLabMergeRequestLabels, upsertGitLabManagedComment } from "./publication.js";
import { getPublicErrorMessage } from "../../../commands/presentation/public-error.js";

export interface GitLabReviewRunParams {
  sourceKey?: string;
  sourceHash?: string;
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  mode?: ReviewMode;
  trigger?: ReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  enableSecretScan?: boolean;
  secretScanCustomPatterns?: string[];
  enableAutoLabel?: boolean;
  throwOnError?: boolean;
  publicationRuntime?: GitLabPublicationRuntime;
  runActor?: { actorType: "user" | "service"; actorId: string };
}


function isGitLabTitleDraftLike(titleRaw: string | undefined): boolean {
  const title = (titleRaw ?? "").trim().toLowerCase();
  if (!title) {
    return false;
  }
  return (
    title.startsWith("draft:") ||
    title.startsWith("wip:") ||
    title.startsWith("[draft]") ||
    title.startsWith("(draft)")
  );
}

function isGitLabMergeRequestDraft(payload: GitLabMrWebhookBody): boolean {
  return Boolean(
    payload.object_attributes.draft ||
      payload.object_attributes.work_in_progress ||
      payload.merge_request?.draft ||
      payload.merge_request?.work_in_progress ||
      isGitLabTitleDraftLike(payload.object_attributes.title) ||
      isGitLabTitleDraftLike(payload.merge_request?.title),
  );
}

export function shouldSkipGitLabReviewForDraft(
  trigger: ReviewTrigger,
  isDraft: boolean,
): boolean {
  return shouldSkipReviewForDraft(trigger, isDraft);
}

export async function runGitLabReview(
  params: GitLabReviewRunParams,
): Promise<{ ok: boolean; message: string; runId?: string }> {
  const {
    payload,
    headers,
    logger,
    mode: modeOverride,
    trigger = "gitlab-webhook",
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    secretScanCustomPatterns = [],
    enableAutoLabel = true,
    throwOnError = false,
    publicationRuntime,
  } = params;
  if (payload.object_kind && payload.object_kind !== "merge_request") {
    return { ok: true, message: `ignored object_kind=${payload.object_kind}` };
  }

  const actionRaw = payload.object_attributes.action;
  const action = typeof actionRaw === "string" ? actionRaw.toLowerCase() : undefined;
  if (action === "close" || action === "closed") {
    return { ok: true, message: "ignored closed merge request event" };
  }

  const mode = modeOverride ?? "report";
  const reviewTarget = buildGitLabCommentTargetFromPayload({
    payload,
    baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
  });
  const resolvedPublicationRuntime = publicationRuntime ??
    (await resolvePublicationRuntime({
      platform: "gitlab",
      origin: reviewTarget.baseUrl,
      repository:
        payload.project.path_with_namespace ?? String(payload.project.id),
    }));
  if (resolvedPublicationRuntime?.binding && resolvedPublicationRuntime.binding.platform !== "gitlab") {
    throw new Error("GitLab review resolved a non-GitLab publication binding");
  }
  let activePublicationRuntime = resolvedPublicationRuntime as GitLabPublicationRuntime | undefined;
  const resolvedExecutionModeGeneration = activePublicationRuntime?.binding?.executionModeGeneration ?? 0;
  const durableSourceKey = params.sourceKey ?? headers["x-gitlab-event-uuid"] ?? `gitlab:canonical:${stableGitLabEventHash(payload)}`;
  const durableSourceHash = params.sourceHash ?? stableGitLabEventHash({ payload, mode, trigger });
  if (shouldQueueReview(activePublicationRuntime?.binding)) {
    if (!activePublicationRuntime?.resolveCredential) throw new Error("Server publication credential resolver is required");
    const runId = await enqueueGitLabReview(params, activePublicationRuntime.binding!,
      { key: durableSourceKey, hash: durableSourceHash }, mode, await activePublicationRuntime.resolveCredential());
    return { ok: true, message: "durable GitLab review queued", runId };
  }
  if (activePublicationRuntime?.batchStore && activePublicationRuntime.batchCoordinator && activePublicationRuntime.createAdapter) {
    const existing = await activePublicationRuntime.batchStore.findBySource(
      { ...activePublicationRuntime.scope, target: String(reviewTarget.mrId), revision: "source-lookup" },
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
      assertGitLabBatchSucceeded(await activePublicationRuntime.batchCoordinator.execute(
        existing.scope.tenantId, existing.id, activePublicationRuntime.createAdapter, lease,
        lease ? undefined : resolvedExecutionModeGeneration,
      ));
      return { ok: true, message: "existing durable publication batch resumed" };
    }
  }
  const locale = resolveUiLocale();
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (!activePublicationRuntime && isDuplicateRequest(requestKey, resolveDedupeTtlMs(trigger, mode, "GITLAB"))) {
    return { ok: true, message: "duplicate request ignored" };
  }

  if (shouldSkipGitLabReviewForDraft(trigger, isGitLabMergeRequestDraft(payload))) {
    return { ok: true, message: "draft merge request skipped" };
  }

  const gitlabToken = activePublicationRuntime?.resolveCredential
    ? await activePublicationRuntime.resolveCredential()
    : requireGitLabToken(headers);
  const reviewMrKey = `${payload.project.id}#${payload.object_attributes.iid}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? getIncrementalHead(reviewMrKey)
    : undefined;
  const currentHeadSha = payload.object_attributes.last_commit?.id?.trim();
  if (
    !activePublicationRuntime &&
    trigger === "pr-edited" &&
    incrementalBaseSha &&
    currentHeadSha &&
    incrementalBaseSha === currentHeadSha
  ) {
    logger.info(
      {
        projectId: payload.project.id,
        mrId: payload.object_attributes.iid,
        trigger,
        headSha: currentHeadSha,
      },
      "Skipping GitLab AI review for merge_request.edited without code changes",
    );
    return { ok: true, message: "merge_request.edited without code changes skipped" };
  }

  try {
    const feedbackSignals = loadGitLabFeedbackSignals(payload.project.id);
    const collected = await durableReviewCollection("gitlab.collect_context.v1", () => collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
      incrementalBaseSha: currentRunLease() ? undefined : incrementalBaseSha,
      customRules,
      includeCiChecks,
      feedbackSignals,
    }));
    assertReviewRunRevision(collected.diffRefs.baseSha, collected.diffRefs.headSha);
    const batch = await prepareGitLabPublicationBatch({
      runtime: activePublicationRuntime,
      mrId: collected.mrId,
      revision: collected.diffRefs.headSha,
      sourceKey: durableSourceKey,
      sourceHash: durableSourceHash,
    });
    if (batch.resumed) return { ok: true, message: "existing durable publication batch resumed" };
    activePublicationRuntime = batch.runtime;

    logger.info(
      {
        projectId: collected.projectId,
        mrId: collected.mrId,
        mode,
        trigger,
      },
      "Starting GitLab AI review",
    );

    if (collected.files.length === 0) {
      const noDiffBody = reviewMessage("reviewNoDiffSkipped", locale);
      if (shouldUseManagedReviewSummary(trigger)) {
        if (activePublicationRuntime) {
          await publishGitLabNoteDurably({
            runtime: activePublicationRuntime,
            token: gitlabToken,
            target: collected,
            revision: collected.diffRefs.headSha,
            slot: "review-no-diff",
            body: noDiffBody,
            managedMarkerKey: "review-no-diff",
          });
        } else {
          await upsertGitLabManagedComment({
            gitlabToken,
            target: collected,
            body: noDiffBody,
            markerKey: "review-no-diff",
            logger,
          });
        }
      } else {
        await publishGitLabReviewNote({
          publicationRuntime: activePublicationRuntime,
          gitlabToken,
          collected,
          body: noDiffBody,
          slot: "review-no-diff",
        });
      }
      await batch.finish();
      rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);
      return { ok: true, message: "no textual diff to review" };
    }

    const result = { ...await durableReviewAnalysis(collected.input, () => analyzePullRequest(collected.input)), coverage: collected.coverage };
    if (mode === "comment") {
      await publishGitLabLineComments(
        gitlabToken,
        collected,
        result,
        logger,
        locale,
        activePublicationRuntime,
      );
      const summaryBody = [
        reviewMessage("reviewCommentModeTitle", locale),
        "",
        reviewMessage("reviewCommentModeHint", locale),
      ].join("\n");
      if (activePublicationRuntime) {
        await publishGitLabNoteDurably({
          runtime: activePublicationRuntime,
          token: gitlabToken,
          target: collected,
          revision: collected.diffRefs.headSha,
          slot: "review-comment-summary",
          body: summaryBody,
          managedMarkerKey: shouldUseManagedReviewSummary(trigger)
            ? "review-comment-summary"
            : undefined,
        });
      } else if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: summaryBody,
          markerKey: "review-comment-summary",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, summaryBody);
      }
    } else {
      const markdown = buildReportCommentMarkdown(result, collected.files, {
        platform: "gitlab",
        webUrl: collected.webUrl,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
      }, {
        locale,
      });
      if (activePublicationRuntime) {
        await publishGitLabNoteDurably({
          runtime: activePublicationRuntime,
          token: gitlabToken,
          target: collected,
          revision: collected.diffRefs.headSha,
          slot: "review-report",
          body: markdown,
          managedMarkerKey: shouldUseManagedReviewSummary(trigger) ? "review-report" : undefined,
        });
      } else if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: markdown,
          markerKey: "review-report",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, markdown);
      }
    }

    if (enableSecretScan) {
      const findings = findSharedPotentialSecrets({
        files: collected.files,
        customPatterns: secretScanCustomPatterns,
        maxFindings: 20,
      });
      if (findings.length > 0) {
        const warning = buildSecretWarningComment({
          platform: "gitlab",
          findings,
          locale,
        });
        await publishGitLabReviewNote({
          publicationRuntime: activePublicationRuntime,
          gitlabToken,
          collected,
          body: warning,
          slot: `secret-warning:${collected.diffRefs.headSha}`,
        });
      }

      if (enableAutoLabel) {
        const labels = inferMergeRequestLabels({
          title: collected.input.title,
          files: collected.files,
          reviewResult: result,
          hasSecretFinding: findings.length > 0,
        });
        await tryAddGitLabMergeRequestLabels({
          gitlabToken,
          collected,
          labels,
          logger,
          publicationRuntime: activePublicationRuntime,
        });
      }
    } else if (enableAutoLabel) {
      const labels = inferMergeRequestLabels({
        title: collected.input.title,
        files: collected.files,
        reviewResult: result,
        hasSecretFinding: false,
      });
      await tryAddGitLabMergeRequestLabels({
        gitlabToken,
        collected,
        labels,
        logger,
        publicationRuntime: activePublicationRuntime,
      });
    }

    await batch.finish();
    rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);

    const pushUrl =
      headers["x-push-url"] ??
      headers["x-qwx-robot-url"] ??
      readOptionalStringEnv("GITLAB_PUSH_URL") ??
      readOptionalStringEnv("NOTIFY_WEBHOOK_URL");
    if (!activePublicationRuntime) try {
      await publishNotification({
        pushUrl,
        author: collected.author,
        repository: collected.repository,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
        content: localizeText(
          {
            zh: `代码评审完毕 ${collected.mrUrl}`,
            en: `Code review completed ${collected.mrUrl}`,
          },
          locale,
        ),
        logger,
      });
    } catch (notifyError) {
      logger.error(
        { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        "GitLab review succeeded but notification publish failed",
      );
    }

    return { ok: true, message: "ok" };
  } catch (error) {
    clearDuplicateRecord(requestKey);
    const originalError = ensureError(error);
    const reason = originalError.message;
    const publicReason = getPublicErrorMessage(originalError);

    logger.error({ error: reason }, "GitLab AI review failed");

    if (error instanceof PendingPublicationError || activePublicationRuntime) {
      throw originalError;
    }

    try {
      const failureTarget = buildGitLabCommentTargetFromPayload({
        payload,
        baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        failureTarget,
        [
          reviewMessage("reviewFailureTitle", locale),
          "",
          "<details>",
          localizeText(
            {
              zh: `<summary>错误详情</summary>`,
              en: `<summary>Error details</summary>`,
            },
            locale,
          ),
          "",
          `\`${publicReason}\``,
          "",
          "</details>",
          "",
          localizeText(
            {
              zh: "请重试或联系仓库管理员。",
              en: "Please retry or contact the repository administrator.",
            },
            locale,
          ),
        ].join("\n"),
      );
    } catch (commentError) {
      logger.error(
        { error: commentError instanceof Error ? commentError.message : String(commentError) },
        "Failed to publish GitLab failure comment to MR",
      );
    }

    const pushUrl =
      headers["x-push-url"] ??
      headers["x-qwx-robot-url"] ??
      readOptionalStringEnv("GITLAB_PUSH_URL") ??
      readOptionalStringEnv("NOTIFY_WEBHOOK_URL");
    try {
      await publishNotification({
        pushUrl,
        author: payload.user?.username ?? "unknown",
        repository:
          payload.project.path_with_namespace ?? payload.project.name ?? "unknown",
        sourceBranch: payload.object_attributes.source_branch ?? "-",
        targetBranch: payload.object_attributes.target_branch ?? "-",
        content: localizeText(
          {
            zh: `代码评审失败: ${publicReason}`,
            en: `Code review failed: ${publicReason}`,
          },
          locale,
        ),
        logger,
      });
    } catch (notifyError) {
      logger.error(
        { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        "Failed to publish GitLab failure notification",
      );
    }

    if (throwOnError) {
      throw originalError;
    }
    return { ok: false, message: reason };
  }
}


export { collectGitLabMergeRequestContext } from "../../../integrations/gitlab/repository/context.js";
