import { resolveUiLocale } from "#core";
import { reviewMessage } from "../../../review/rendering/messages.js";
import {
  buildManagedCommentBody,
  buildManagedCommentMarker,
  type ManagedCommentKey,
  MANAGED_COMMENT_SCAN_PER_PAGE,
  MAX_MANAGED_COMMENT_SCAN_PAGES,
} from "../../../review/rendering/managed-comments.js";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";
import { getErrorMessage } from "../error.js";

export async function upsertGitHubManagedIssueComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  markerKey: ManagedCommentKey;
}): Promise<void> {
  const marker = buildManagedCommentMarker(params.markerKey);
  const nextBody = buildManagedCommentBody(params.body, params.markerKey);
  const listComments = params.context.octokit.issues.listComments;
  if (listComments) {
    try {
      for (let page = 1; page <= MAX_MANAGED_COMMENT_SCAN_PAGES; page += 1) {
        const listed = await listComments({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          per_page: MANAGED_COMMENT_SCAN_PER_PAGE,
          page,
        });
        const existing = listed.data.find((item) => item.body?.includes(marker));
        if (existing) {
          await params.context.octokit.issues.updateComment({
            owner: params.owner,
            repo: params.repo,
            comment_id: existing.id,
            body: nextBody,
          });
          return;
        }
        if (listed.data.length < MANAGED_COMMENT_SCAN_PER_PAGE) {
          break;
        }
      }
    } catch (error) {
      params.context.log.error(
        {
          owner: params.owner,
          repo: params.repo,
          issueNumber: params.issueNumber,
          markerKey: params.markerKey,
          error: getErrorMessage(error),
        },
        "Failed to list/update managed GitHub issue comment; falling back to create",
      );
    }
  }

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: nextBody,
  });
}

export async function postGitHubCommandComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  managedCommentKey?: string;
}): Promise<void> {
  if (params.managedCommentKey) {
    await upsertGitHubManagedIssueComment({
      context: params.context,
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
      body: params.body,
      markerKey: params.managedCommentKey,
    });
    return;
  }

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: params.body,
  });
}

export async function publishGitHubNoDiffStatus(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  progressCommentId?: number;
  markerKey: ManagedCommentKey;
  body?: string;
}): Promise<void> {
  const locale = resolveUiLocale();
  const body =
    params.body?.trim() ||
    reviewMessage("reviewNoDiffSkipped", locale);
  if (params.progressCommentId) {
    await params.context.octokit.issues.updateComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.progressCommentId,
      body: buildManagedCommentBody(body, params.markerKey),
    });
    return;
  }

  await upsertGitHubManagedIssueComment({
    context: params.context,
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.pullNumber,
    body,
    markerKey: params.markerKey,
  });
}
