import { createHash } from "node:crypto";
import type { UiLocale } from "#core";
import { assertRunActive, currentRunLease } from "../../../agent-runtime/execution/run-context.js";
import { PendingPublicationError, PublicationDefiniteFailureError } from "../../../agent-runtime/publication/publication.js";
import { publishGitLabDiscussionDurably, publishGitLabLabelsDurably, publishGitLabNoteDurably, type GitLabPublicationRuntime } from "../../../integrations/gitlab/publication/adapter.js";
import type { GitLabCollectedContext } from "../../../integrations/gitlab/repository/contracts.js";
import type { DiffFileContext } from "../../../repository/contracts.js";
import type { PullRequestReviewResult } from "#review";
import { buildIssueCommentMarkdown, findFileForReview, resolveReviewLineForIssue } from "#review";
import { inferReviewLabels } from "../../presentation/auto-labels.js";


export async function prepareGitLabPublicationBatch(params: {
  runtime: GitLabPublicationRuntime;
  mrId: number;
  revision: string;
  sourceKey: string;
  sourceHash: string;
}): Promise<{ runtime: GitLabPublicationRuntime; resumed: boolean; finish(): Promise<void> }> {
  const { runtime } = params;
  if (!runtime.batchStore || !runtime.batchCoordinator || !runtime.createAdapter) {
    throw new Error("Durable GitLab publication batch services are required");
  }
  const scope = { ...runtime.scope, target: String(params.mrId), revision: params.revision };
  const existing = await runtime.batchStore.findBySource(scope, params.sourceKey, params.sourceHash);
  if (existing) {
    const lease = currentRunLease();
    if (!lease) throw new Error("Publication batch execution requires a Run lease");
    await runtime.batchStore.attachExistingBatchToRun(lease, existing.id);
    await assertRunActive();
    assertGitLabBatchSucceeded(await runtime.batchCoordinator.execute(
      scope.tenantId, existing.id, runtime.createAdapter, lease,
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
      if (!lease) throw new Error("Publication batch execution requires a Run lease");
      const frozen = await runtime.batchStore!.freeze({ scope, sourceKey: params.sourceKey, sourceHash: params.sourceHash, operations,
        runLease: lease });
      await assertRunActive();
      assertGitLabBatchSucceeded(await runtime.batchCoordinator!.execute(
        scope.tenantId, frozen.id, runtime.createAdapter!, lease,
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
  locale: UiLocale,
  publicationRuntime: GitLabPublicationRuntime,
): Promise<void> {
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

    await publishGitLabDiscussionDurably({
      runtime: publicationRuntime,
      token: gitlabToken,
      target: collected,
      revision: collected.diffRefs.headSha,
      slot: `review-inline:${file.newPath}:${line}:${review.type}`,
      body,
      position,
    });
  }
}

export async function publishGitLabReviewNote(params: {
  publicationRuntime: GitLabPublicationRuntime;
  gitlabToken: string;
  collected: GitLabCollectedContext;
  body: string;
  slot: string;
}): Promise<void> {
  await publishGitLabNoteDurably({
    runtime: params.publicationRuntime,
    token: params.gitlabToken,
    target: params.collected,
    revision: params.collected.diffRefs.headSha,
    slot: params.slot,
    body: params.body,
  });
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
  publicationRuntime: GitLabPublicationRuntime;
}): Promise<void> {
  if (params.labels.length === 0) {
    return;
  }

  await publishGitLabLabelsDurably({
    runtime: params.publicationRuntime,
    token: params.gitlabToken,
    target: params.collected,
    revision: params.collected.diffRefs.headSha,
    slot: "review-labels",
    labels: params.labels,
  });
}
