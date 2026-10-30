import { assertRunActive, currentRunLease } from "../../../agent-runtime/execution/run-context.js";
import { canonicalJson } from "../../../agent-runtime/versions.js";
import { PendingPublicationError, PublicationDefiniteFailureError } from "../../../agent-runtime/publication/publication.js";
import { isDuplicateRequest, localizeText, resolveUiLocale, type UiLocale } from "#core";
import {
  buildIssueCommentMarkdown,
  findFileForReview,
  resolveReviewLineForIssue,
} from "#review";
import type { PullRequestReviewResult } from "#review";
import type { DiffFileContext } from "../../../repository/contracts.js";
import { DEFAULT_DEDUPE_TTL_MS } from "../../policy/triggers.js";
import { inferReviewLabels } from "../../presentation/auto-labels.js";
import { buildSecretWarningComment } from "../../rendering/secret-warning.js";
import type { SecretFinding } from "../../../repository/content-safety/secret-scan.js";
import { publishGitHubInlineCommentDurably, publishGitHubIssueCommentDurably, publishGitHubLabelsDurably } from "../../../integrations/github/publication/adapter.js";
import { type GitHubPublicationRuntime } from "../../../integrations/github/publication/contracts.js";
import type {
  GitHubCollectedContext,
  GitHubReviewContext,
} from "./contracts.js";
import { getErrorMessage } from "../../../integrations/github/error.js";

const GITHUB_PULL_FILES_TRUNCATED_WARNING = {
  zh: "⚠️ 文件列表达到 API 的读取上限，当前评审结果可能未覆盖全部变更。",
  en: "⚠️ File listing reached the API retrieval limit; this review may not cover all changed files.",
} as const;

export async function prepareGitHubPublicationBatch(params: {
  runtime?: GitHubPublicationRuntime;
  pullNumber: number;
  revision: string;
  sourceKey: string;
  sourceHash: string;
}): Promise<{ runtime?: GitHubPublicationRuntime; resumed: boolean; finish(): Promise<void> }> {
  const { runtime } = params;
  if (!runtime?.batchStore || !runtime.batchCoordinator || !runtime.createAdapter) {
    return { runtime, resumed: false, finish: async () => undefined };
  }
  const scope = { ...runtime.scope, target: String(params.pullNumber), revision: params.revision };
  const existing = await runtime.batchStore.findBySource(scope, params.sourceKey, params.sourceHash);
  if (existing) {
    const lease = currentRunLease();
    if (lease) await runtime.batchStore.attachExistingBatchToRun(lease, existing.id);
    else await runtime.batchStore.assertLegacyBatchExecution(
      existing,
      runtime.binding?.executionModeGeneration ?? 0,
    );
    await assertRunActive();
    assertGitHubBatchSucceeded(await runtime.batchCoordinator.execute(
      scope.tenantId, existing.id, runtime.createAdapter, lease,
      lease ? undefined : runtime.binding?.executionModeGeneration ?? 0,
    ));
    return { runtime, resumed: true, finish: async () => undefined };
  }
  const operations = new Map<string, { slot: string; payload: Record<string, unknown> }>();
  const collectingRuntime = {
    ...runtime,
    planOperation: (operation: { slot: string; payload: Record<string, unknown> }) => {
      const existing = operations.get(operation.slot);
      if (existing) {
        if (canonicalJson(existing.payload) !== canonicalJson(operation.payload)) {
          throw new Error(`publication slot was planned with different payload: ${operation.slot}`);
        }
        return;
      }
      operations.set(operation.slot, operation);
    },
  };
  return {
    runtime: collectingRuntime,
    resumed: false,
    finish: async () => {
      if (operations.size === 0) throw new Error("durable GitHub review produced no frozen publication operations");
      const lease = currentRunLease();
      const executionModeGeneration = runtime.binding?.executionModeGeneration ?? 0;
      const frozen = await runtime.batchStore!.freeze({ scope, sourceKey: params.sourceKey, sourceHash: params.sourceHash, operations: [...operations.values()],
        runLease: lease, executionModeGeneration });
      await assertRunActive();
      assertGitHubBatchSucceeded(await runtime.batchCoordinator!.execute(
        scope.tenantId, frozen.id, runtime.createAdapter!, lease,
        lease ? undefined : executionModeGeneration,
      ));
    },
  };
}

export function assertGitHubBatchSucceeded(batch: { id: string; status: string }): void {
  if (batch.status === "succeeded") return;
  if (batch.status === "failed_definite") throw new PublicationDefiniteFailureError(batch.id, "publication_batch_failed_definite");
  throw new PendingPublicationError(batch.id);
}

export function maybeAppendGitHubFilesTruncatedWarning(
  body: string,
  filesTruncated: boolean,
  locale: UiLocale = resolveUiLocale(),
): string {
  if (!filesTruncated) {
    return body;
  }

  return appendGitHubFilesTruncatedWarning(body, locale);
}

export function appendGitHubFilesTruncatedWarning(
  body: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  return [
    body.trim(),
    "",
    localizeText(
      {
        zh: GITHUB_PULL_FILES_TRUNCATED_WARNING.zh,
        en: GITHUB_PULL_FILES_TRUNCATED_WARNING.en,
      },
      locale,
    ),
  ].join("\n");
}

export async function publishGitHubLineComments(
  context: GitHubReviewContext,
  collected: GitHubCollectedContext,
  reviewResult: PullRequestReviewResult,
  locale: UiLocale,
  publicationRuntime?: GitHubPublicationRuntime,
): Promise<{ posted: number; skipped: number }> {
  const { owner, repo } = collected;
  let posted = 0;
  let skipped = 0;

  for (const review of reviewResult.reviews) {
    const file = findFileForReview(collected.files, review);
    if (!file) {
      skipped += 1;
      continue;
    }

    const line = resolveReviewLineForIssue(file, review);
    if (!line) {
      skipped += 1;
      continue;
    }

    try {
      const body = buildIssueCommentMarkdown(review, { platform: "github", locale });
      const side = review.type === "new" ? "RIGHT" : "LEFT";
      if (publicationRuntime) {
        await publishGitHubInlineCommentDurably({
          runtime: publicationRuntime,
          context,
          owner,
          repo,
          pullNumber: collected.input.number,
          revision: collected.headSha,
          slot: `review-inline:${file.newPath}:${line}:${side}`,
          body,
          path: file.newPath,
          line,
          side,
        });
      } else {
        await context.octokit.pulls.createReviewComment({
          owner,
          repo,
          pull_number: collected.input.number,
          body,
          commit_id: collected.headSha,
          path: file.newPath,
          line,
          side,
        });
      }
      posted += 1;
    } catch (error) {
      if (publicationRuntime) throw error;
      skipped += 1;
    }
  }

  return { posted, skipped };
}

export async function publishSecretWarningComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  findings: SecretFinding[];
  publicationRuntime?: GitHubPublicationRuntime;
}): Promise<void> {
  const dedupeKey = [
    "github-secret-scan",
    `${params.owner}/${params.repo}`,
    `${params.pullNumber}`,
    params.headSha,
  ].join(":");
  if (!params.publicationRuntime?.planOperation
      && isDuplicateRequest(dedupeKey, DEFAULT_DEDUPE_TTL_MS)) {
    return;
  }
  const locale = resolveUiLocale();

  const body = buildSecretWarningComment({
    platform: "github",
    findings: params.findings,
    locale,
  });
  if (params.publicationRuntime) {
    await publishGitHubIssueCommentDurably({
      runtime: params.publicationRuntime,
      context: params.context,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      revision: params.headSha,
      slot: `secret-warning:${params.headSha}`,
      body,
    });
    return;
  }
  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body,
  });
}

export function inferPullRequestLabels(params: {
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
    docsFromFiles: "all-documentation",
    highRiskLabel: "needs-attention",
    fallbackLabel: "ai-reviewed",
    maxLabels: 8,
  });
}

export async function tryAddPullRequestLabels(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  labels: string[];
  revision: string;
  publicationRuntime?: GitHubPublicationRuntime;
}): Promise<void> {
  if (!params.context.octokit.issues.addLabels || params.labels.length === 0) {
    return;
  }

  if (params.publicationRuntime) {
    await publishGitHubLabelsDurably({
      runtime: params.publicationRuntime,
      context: params.context,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      revision: params.revision,
      slot: "review-labels",
      labels: params.labels,
    });
    return;
  }
  try {
    await params.context.octokit.issues.addLabels({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      labels: params.labels,
    });
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        labels: params.labels,
        error: getErrorMessage(error),
      },
      "Failed to add auto labels",
    );
  }
}
