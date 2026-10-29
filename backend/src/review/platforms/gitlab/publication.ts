import { createHash } from "node:crypto";
import type { UiLocale } from "#core";
import { assertRunActive, currentRunLease } from "../../../agent-runtime/execution/run-context.js";
import { PendingPublicationError, PublicationDefiniteFailureError } from "../../../agent-runtime/publication/publication.js";
import { gitLabApiRequest } from "../../../integrations/gitlab/api/http-client.js";
import { publishGitLabDiscussionDurably, publishGitLabLabelsDurably, publishGitLabNoteDurably, type GitLabPublicationRuntime } from "../../../integrations/gitlab/publication/adapter.js";
import type { GitLabCollectedContext, GitLabCommentTarget } from "../../../integrations/gitlab/repository/contracts.js";
import type { LoggerLike } from "../../../integrations/gitlab/webhooks/contracts.js";
import type { DiffFileContext } from "../../../repository/contracts.js";
import type { PullRequestReviewResult } from "#review";
import { buildIssueCommentMarkdown, findFileForReview, resolveReviewLineForIssue } from "#review";
import { inferReviewLabels } from "../../presentation/auto-labels.js";
import { buildManagedCommentBody, buildManagedCommentMarker, type ManagedCommentKey, MANAGED_COMMENT_SCAN_PER_PAGE, MAX_MANAGED_COMMENT_SCAN_PAGES } from "../../rendering/managed-comments.js";

export async function upsertGitLabManagedComment(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  body: string;
  markerKey: ManagedCommentKey;
  logger?: LoggerLike;
}): Promise<void> {
  const marker = buildManagedCommentMarker(params.markerKey);
  const nextBody = buildManagedCommentBody(params.body, params.markerKey);
  try {
    for (let page = 1; page <= MAX_MANAGED_COMMENT_SCAN_PAGES; page += 1) {
      const listed = await gitLabApiRequest({
        url: `${params.target.baseUrl}/api/v4/projects/${encodeURIComponent(params.target.projectId)}/merge_requests/${params.target.mrId}/notes?per_page=${MANAGED_COMMENT_SCAN_PER_PAGE}&page=${page}`,
        token: params.gitlabToken,
      });
      if (!listed.ok) {
        break;
      }

      const data = (await listed.json()) as Array<{ id?: number; body?: string }>;
      const existing = data.find(
        (item) =>
          typeof item.id === "number" &&
          typeof item.body === "string" &&
          item.body.includes(marker),
      );
      if (existing?.id) {
        const updateResp = await gitLabApiRequest({
          url: `${params.target.baseUrl}/api/v4/projects/${encodeURIComponent(params.target.projectId)}/merge_requests/${params.target.mrId}/notes/${existing.id}`,
          token: params.gitlabToken,
          method: "PUT",
          body: { body: nextBody },
        });
        if (updateResp.ok) {
          return;
        }
      }

      if (data.length < MANAGED_COMMENT_SCAN_PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    params.logger?.error(
      {
        projectId: params.target.projectId,
        mrId: params.target.mrId,
        markerKey: params.markerKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to upsert GitLab managed comment; falling back to create",
    );
  }

  await publishGitLabGeneralComment(params.gitlabToken, params.target, nextBody);
}

export async function postGitLabCommandComment(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  body: string;
  managedCommentKey?: string;
  logger?: LoggerLike;
}): Promise<void> {
  if (params.managedCommentKey) {
    await upsertGitLabManagedComment({
      gitlabToken: params.gitlabToken,
      target: params.target,
      body: params.body,
      markerKey: params.managedCommentKey,
      logger: params.logger,
    });
    return;
  }

  await publishGitLabGeneralComment(params.gitlabToken, params.target, params.body);
}


export async function prepareGitLabPublicationBatch(params: {
  runtime?: GitLabPublicationRuntime;
  mrId: number;
  revision: string;
  sourceKey: string;
  sourceHash: string;
}): Promise<{ runtime?: GitLabPublicationRuntime; resumed: boolean; finish(): Promise<void> }> {
  const { runtime } = params;
  if (!runtime?.batchStore || !runtime.batchCoordinator || !runtime.createAdapter) {
    return { runtime, resumed: false, finish: async () => undefined };
  }
  const scope = { ...runtime.scope, target: String(params.mrId), revision: params.revision };
  const existing = await runtime.batchStore.findBySource(scope, params.sourceKey, params.sourceHash);
  if (existing) {
    const lease = currentRunLease();
    if (lease) await runtime.batchStore.attachExistingBatchToRun(lease, existing.id);
    else await runtime.batchStore.assertLegacyBatchExecution(
      existing,
      runtime.binding?.executionModeGeneration ?? 0,
    );
    await assertRunActive();
    assertGitLabBatchSucceeded(await runtime.batchCoordinator.execute(
      scope.tenantId, existing.id, runtime.createAdapter, lease,
      lease ? undefined : runtime.binding?.executionModeGeneration ?? 0,
    ));
    return { runtime, resumed: true, finish: async () => undefined };
  }
  const operations: Array<{ slot: string; payload: Record<string, unknown> }> = [];
  const collectingRuntime = { ...runtime, planOperation: (operation: { slot: string; payload: Record<string, unknown> }) => operations.push(operation) };
  return {
    runtime: collectingRuntime,
    resumed: false,
    finish: async () => {
      if (operations.length === 0) throw new Error("durable GitLab review produced no frozen publication operations");
      const lease = currentRunLease();
      const executionModeGeneration = runtime.binding?.executionModeGeneration ?? 0;
      const frozen = await runtime.batchStore!.freeze({ scope, sourceKey: params.sourceKey, sourceHash: params.sourceHash, operations,
        runLease: lease, executionModeGeneration });
      await assertRunActive();
      assertGitLabBatchSucceeded(await runtime.batchCoordinator!.execute(
        scope.tenantId, frozen.id, runtime.createAdapter!, lease,
        lease ? undefined : executionModeGeneration,
      ));
    },
  };
}

export function stableGitLabEventHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertGitLabBatchSucceeded(batch: { id: string; status: string }): void {
  if (batch.status === "succeeded") return;
  if (batch.status === "failed_definite") throw new PublicationDefiniteFailureError(batch.id, "publication_batch_failed_definite");
  throw new PendingPublicationError(batch.id);
}


export async function publishGitLabLineComments(
  gitlabToken: string,
  collected: GitLabCollectedContext,
  result: PullRequestReviewResult,
  logger: LoggerLike,
  locale: UiLocale,
  publicationRuntime?: GitLabPublicationRuntime,
): Promise<void> {
  let failed = 0;
  for (const review of result.reviews) {
    const file = findFileForReview(collected.files, review);
    if (!file) {
      continue;
    }

    const line = resolveReviewLineForIssue(file, review);
    if (!line) {
      continue;
    }

    const body = buildIssueCommentMarkdown(review, {
      platform: "gitlab",
      locale,
    });
    const position = {
      position_type: "text",
      base_sha: collected.diffRefs.baseSha,
      head_sha: collected.diffRefs.headSha,
      start_sha: collected.diffRefs.startSha,
      new_path: file.newPath,
      old_path: file.oldPath,
      new_line: review.type === "new" ? line : undefined,
      old_line: review.type === "old" ? line : undefined,
    };

    let response: Response;
    try {
      if (publicationRuntime) {
        await publishGitLabDiscussionDurably({
          runtime: publicationRuntime,
          token: gitlabToken,
          target: collected,
          revision: collected.diffRefs.headSha,
          slot: `review-inline:${file.newPath}:${line}:${review.type}`,
          body,
          position,
        });
        continue;
      }
      response = await gitLabApiRequest({
        url: `${collected.baseUrl}/api/v4/projects/${encodeURIComponent(collected.projectId)}/merge_requests/${collected.mrId}/discussions`,
        token: gitlabToken,
        method: "POST",
        body: {
          body,
          position,
        },
      });
    } catch (error) {
      if (publicationRuntime) throw error;
      failed += 1;
      logger.error(
        {
          path: file.newPath,
          line,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to publish GitLab line comment",
      );
      continue;
    }

    if (!response.ok) {
      failed += 1;
      logger.error(
        {
          status: response.status,
          path: file.newPath,
          line,
        },
        "Failed to publish GitLab line comment",
      );
      continue;
    }
  }

  if (failed > 0) {
    logger.error({ failed }, "GitLab line comments published with failures");
  }
}

export async function publishGitLabReviewNote(params: {
  publicationRuntime?: GitLabPublicationRuntime;
  gitlabToken: string;
  collected: GitLabCollectedContext;
  body: string;
  slot: string;
}): Promise<void> {
  if (params.publicationRuntime) {
    await publishGitLabNoteDurably({
      runtime: params.publicationRuntime,
      token: params.gitlabToken,
      target: params.collected,
      revision: params.collected.diffRefs.headSha,
      slot: params.slot,
      body: params.body,
    });
    return;
  }
  await publishGitLabGeneralComment(params.gitlabToken, params.collected, params.body);
}

export async function publishGitLabGeneralComment(
  gitlabToken: string,
  target: GitLabCommentTarget,
  body: string,
): Promise<void> {
  const response = await gitLabApiRequest({
    url: `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.mrId}/notes`,
    token: gitlabToken,
    method: "POST",
    body: { body },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to publish GitLab report comment (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}


export function inferMergeRequestLabels(params: {
  title: string;
  files: DiffFileContext[];
  reviewResult: PullRequestReviewResult;
  hasSecretFinding: boolean;
}): string[] {
  return inferReviewLabels({
    title: params.title,
    files: params.files,
    reviewResult: params.reviewResult,
    hasSecretFinding: params.hasSecretFinding,
    docsFromTitle: true,
    docsFromFiles: "any-markdown",
    includeTestLabelFromFiles: true,
    includeCiLabelFromFiles: true,
    highRiskLabel: "high-risk",
    maxLabels: 10,
  });
}

export async function tryAddGitLabMergeRequestLabels(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  labels: string[];
  logger: LoggerLike;
  publicationRuntime?: GitLabPublicationRuntime;
}): Promise<void> {
  if (params.labels.length === 0) {
    return;
  }

  if (params.publicationRuntime) {
    await publishGitLabLabelsDurably({
      runtime: params.publicationRuntime,
      token: params.gitlabToken,
      target: params.collected,
      revision: params.collected.diffRefs.headSha,
      slot: "review-labels",
      labels: params.labels,
    });
    return;
  }
  try {
    const response = await gitLabApiRequest({
      url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/merge_requests/${params.collected.mrId}`,
      token: params.gitlabToken,
      method: "PUT",
      body: {
        add_labels: params.labels.join(","),
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitLab labels API failed (${response.status}): ${errorText.slice(0, 300)}`,
      );
    }
  } catch (error) {
    params.logger.error(
      {
        projectId: params.collected.projectId,
        mrId: params.collected.mrId,
        labels: params.labels,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to add GitLab merge request labels",
    );
  }
}
