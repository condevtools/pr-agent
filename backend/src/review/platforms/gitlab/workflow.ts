import { ensureError, localizeText, readNumberEnv, readOptionalStringEnv, resolveUiLocale } from "#core";
import { assertRunActive, assertReviewRunRevision, currentRunLease, durableReviewAnalysis, durableReviewCollection } from "../../../agent-runtime/execution/run-context.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import type { PgBusinessStateStore } from "../../../agent-runtime/state/business-state.js";
import { publishGitLabNoteDurably, type GitLabPublicationRuntime } from "../../../integrations/gitlab/publication/adapter.js";
import { buildGitLabCommentTargetFromPayload, collectGitLabMergeRequestContext } from "../../../integrations/gitlab/repository/context.js";
import type { GitLabMrWebhookBody } from "../../../integrations/gitlab/webhooks/contracts.js";
import type { LoggerLike } from "../../../integrations/gitlab/webhooks/contracts.js";
import { enqueueGitLabReview } from "../../intake/provider-intake.js";
import { shouldQueueReview } from "../../intake/run-intake.js";
import { analyzePullRequest, buildReportCommentMarkdown, type ReviewMode, type ReviewTrigger } from "#review";
import { findPotentialSecrets as findSharedPotentialSecrets } from "../../../repository/content-safety/secret-scan.js";
import { buildSecretWarningComment } from "../../rendering/secret-warning.js";
import { reviewMessage, reviewPartialNoFilesMessage } from "../../rendering/messages.js";
import { shouldSkipReviewForDraft, shouldUseIncrementalReview, shouldUseManagedReviewSummary } from "../../policy/triggers.js";
import { assertGitLabBatchSucceeded, inferMergeRequestLabels, prepareGitLabPublicationBatch, publishGitLabLineComments, publishGitLabReviewNote, stableGitLabEventHash, tryAddGitLabMergeRequestLabels } from "./publication.js";

const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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
  businessState?: Pick<PgBusinessStateStore, "loadFeedbackSignals" | "loadIncrementalHead" | "rememberIncrementalHead">;
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
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    secretScanCustomPatterns = [],
    enableAutoLabel = true,
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
  const binding = resolvedPublicationRuntime.binding;
  if (!binding) throw new Error("GitLab review requires a trusted publication binding");
  let activePublicationRuntime = resolvedPublicationRuntime as GitLabPublicationRuntime;
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
      if (!lease) throw new Error("Publication batch execution requires a Run lease");
      await activePublicationRuntime.batchStore.attachExistingBatchToRun(lease, existing.id);
      await assertRunActive();
      assertGitLabBatchSucceeded(await activePublicationRuntime.batchCoordinator.execute(
        existing.scope.tenantId, existing.id, activePublicationRuntime.createAdapter, lease,
      ));
      return { ok: true, message: "existing durable publication batch resumed" };
    }
  }
  const locale = resolveUiLocale();
  if (shouldSkipGitLabReviewForDraft(trigger, isGitLabMergeRequestDraft(payload))) {
    return { ok: true, message: "draft merge request skipped" };
  }

  const gitlabToken = await activePublicationRuntime.resolveCredential!();
  const businessState = params.businessState ?? (await getAgentRuntimeServices()).businessState;
  const businessStateScope = {
    tenantId: binding.tenantId,
    integrationId: binding.id,
    platform: "gitlab" as const,
    origin: binding.origin,
    repository: binding.repository,
    target: `mr:${reviewTarget.mrId}`,
  };
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? await businessState.loadIncrementalHead(businessStateScope)
    : undefined;
  const currentHeadSha = payload.object_attributes.last_commit?.id?.trim();
  if (
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
    const feedbackSignals = await businessState.loadFeedbackSignals(businessStateScope);
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
    if (!batch.runtime) throw new Error("Durable GitLab publication batch runtime is required");
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
      const noDiffBody = collected.coverage?.status === "partial"
        ? reviewPartialNoFilesMessage(collected.coverage.reasonCodes, locale)
        : reviewMessage("reviewNoDiffSkipped", locale);
      if (shouldUseManagedReviewSummary(trigger)) {
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
        await publishGitLabReviewNote({
          publicationRuntime: activePublicationRuntime,
          gitlabToken,
          collected,
          body: noDiffBody,
          slot: "review-no-diff",
        });
      }
      await batch.finish();
      await businessState.rememberIncrementalHead({
        ...businessStateScope,
        headSha: collected.diffRefs.headSha,
        ttlMs: readNumberEnv("GITLAB_INCREMENTAL_STATE_TTL_MS", DEFAULT_INCREMENTAL_STATE_TTL_MS),
      });
      return { ok: true, message: "no textual diff to review" };
    }

    const result = { ...await durableReviewAnalysis(collected.input, () => analyzePullRequest(collected.input)), coverage: collected.coverage };
    if (mode === "comment") {
      await publishGitLabLineComments(
        gitlabToken,
        collected,
        result,
        locale,
        activePublicationRuntime,
      );
      const summaryBody = [
        reviewMessage("reviewCommentModeTitle", locale),
        "",
        reviewMessage("reviewCommentModeHint", locale),
      ].join("\n");
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
    } else {
      const markdown = buildReportCommentMarkdown(result, collected.files, {
        platform: "gitlab",
        webUrl: collected.webUrl,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
      }, {
        locale,
      });
      await publishGitLabNoteDurably({
        runtime: activePublicationRuntime,
        token: gitlabToken,
        target: collected,
        revision: collected.diffRefs.headSha,
        slot: "review-report",
        body: markdown,
        managedMarkerKey: shouldUseManagedReviewSummary(trigger) ? "review-report" : undefined,
      });
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
        publicationRuntime: activePublicationRuntime,
      });
    }

    await batch.finish();
    await businessState.rememberIncrementalHead({
      ...businessStateScope,
      headSha: collected.diffRefs.headSha,
      ttlMs: readNumberEnv("GITLAB_INCREMENTAL_STATE_TTL_MS", DEFAULT_INCREMENTAL_STATE_TTL_MS),
    });

    return { ok: true, message: "ok" };
  } catch (error) {
    const originalError = ensureError(error);
    logger.error({ error: originalError }, "GitLab AI review failed");
    throw originalError;
  }
}


export { collectGitLabMergeRequestContext } from "../../../integrations/gitlab/repository/context.js";
