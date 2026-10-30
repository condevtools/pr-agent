import { BadWebhookRequestError, parseBooleanEnv, readNumberEnv, readOptionalStringEnv } from "#core";
import { assertReviewRunRevision, currentRunLease } from "../../../agent-runtime/execution/run-context.js";
import { buildDiffFileContexts } from "../../../repository/diff/context.js";
import { countPatchChanges, GITLAB_GUIDELINE_DIRECTORIES, GITLAB_GUIDELINE_FILE_PATHS, isProcessTemplateFile, isReviewTargetFile } from "#review";
import { loadProcessGuidelinesWithCache, type ProcessGuideline } from "../../../repository/process-guidelines.js";
import { gitLabApiRequest } from "../api/http-client.js";
import type { GitLabMrWebhookBody } from "../webhooks/contracts.js";
import type { GitLabChange, GitLabChangesResponse, GitLabCollectedContext, GitLabCommentTarget, GitLabCompareResponse } from "./contracts.js";
import type { PullRequestReviewInput } from "#review";
import { loadGitLabHeadChecks } from "./ci-checks.js";
import { loadGitLabRepositoryProcessGuidelines } from "./guidelines.js";
import { loadGitLabIncrementalChanges } from "./incremental-changes.js";

const MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS_PER_FILE = 4_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 60_000;

export function resolveGitLabPatchCharLimits(): {
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
} {
  const maxPatchCharsPerFile = Math.max(
    1,
    readNumberEnv(
      "GITLAB_MAX_PATCH_CHARS_PER_FILE",
      DEFAULT_MAX_PATCH_CHARS_PER_FILE,
    ),
  );
  const maxTotalPatchChars = Math.max(
    maxPatchCharsPerFile,
    readNumberEnv(
      "GITLAB_MAX_TOTAL_PATCH_CHARS",
      DEFAULT_MAX_TOTAL_PATCH_CHARS,
    ),
  );

  return {
    maxPatchCharsPerFile,
    maxTotalPatchChars,
  };
}


export async function collectGitLabMergeRequestContext(params: {
  payload: GitLabMrWebhookBody;
  gitlabToken: string;
  baseUrl?: string;
  incrementalBaseSha?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  feedbackSignals?: string[];
}): Promise<GitLabCollectedContext> {
  const {
    payload,
    gitlabToken,
    incrementalBaseSha,
    customRules,
    includeCiChecks = true,
    feedbackSignals,
  } = params;
  const projectId = payload.project.id;
  const mrId = payload.object_attributes.iid;
  const baseUrl = resolveGitLabBaseUrl(params.baseUrl, payload.project.web_url);

  const response = await gitLabApiRequest({
    url: `${baseUrl}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrId}/changes`,
    token: gitlabToken,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch GitLab MR changes (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const changesResponse = (await response.json()) as GitLabChangesResponse;
  if (!changesResponse.diff_refs || !Array.isArray(changesResponse.changes)) {
    throw new Error("GitLab changes response omitted diff refs or the frozen change list");
  }
  const durableLease = currentRunLease();
  if (durableLease) {
    // GitLab returns diff refs and changes in one response, so validate the
    // immutable Run revision before interpreting any returned patch.
    assertReviewRunRevision(
      changesResponse.diff_refs.base_sha,
      changesResponse.diff_refs.head_sha,
    );
  }
  let sourceChanges = changesResponse.changes;
  if (
    incrementalBaseSha &&
    incrementalBaseSha !== changesResponse.diff_refs.head_sha
  ) {
    const compared = await loadGitLabIncrementalChanges({
      baseUrl,
      projectId,
      gitlabToken,
      incrementalBaseSha,
      headSha: changesResponse.diff_refs.head_sha,
    });
    if (compared.length > 0) {
      sourceChanges = compared;
    }
  }

  const limits = resolveGitLabPatchCharLimits();
  const {
    files,
    totalAdditions,
    totalDeletions,
    coverage,
  } = buildDiffFileContexts({
    candidates: sourceChanges.map((change) => ({
      newPath: change.new_path,
      oldPath: change.old_path || change.new_path,
      status: resolveGitLabChangeStatus(change),
      patch: change.diff,
    })),
    maxFiles: MAX_FILES,
    maxPatchCharsPerFile: limits.maxPatchCharsPerFile,
    maxTotalPatchChars: limits.maxTotalPatchChars,
    shouldIncludeFile: (newPath) => isReviewTargetFile(newPath, "gitlab"),
    resolveStats: (trimmedPatch) => countPatchChanges(trimmedPatch),
  });

  const processGuidelines = await loadGitLabRepositoryProcessGuidelines({
    baseUrl,
    projectId,
    gitlabToken,
    ref: durableLease?.baseSha ?? payload.object_attributes.target_branch,
  });
  const ciChecks = includeCiChecks
    ? await loadGitLabHeadChecks({
        baseUrl,
        projectId,
        gitlabToken,
        headSha: changesResponse.diff_refs.head_sha,
      })
    : [];

  const input: PullRequestReviewInput = {
    platform: "gitlab",
    repository: payload.project.path_with_namespace ?? payload.project.name,
    number: mrId,
    title: payload.object_attributes.title,
    body: payload.object_attributes.description ?? "",
    author: payload.user?.username ?? "unknown",
    baseBranch: payload.object_attributes.target_branch,
    headBranch: payload.object_attributes.source_branch,
    additions: totalAdditions,
    deletions: totalDeletions,
    changedFilesCount:
      incrementalBaseSha && incrementalBaseSha !== changesResponse.diff_refs.head_sha
        ? files.length
        : changesResponse.changes.length,
    changedFiles: files.map((file) => ({
      newPath: file.newPath,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      extendedDiff: file.extendedDiff,
    })),
    customRules: customRules ?? [],
    ciChecks,
    feedbackSignals: feedbackSignals ?? [],
    processGuidelines,
  };

  return {
    input,
    files,
    coverage: changesResponse.overflow ? { status: "partial", reasonCodes: [...coverage.reasonCodes, "provider_diff_overflow"] } : coverage,
    baseUrl,
    projectId,
    mrId,
    webUrl: payload.project.web_url,
    sourceBranch: payload.object_attributes.source_branch,
    targetBranch: payload.object_attributes.target_branch,
    author: payload.user?.username ?? "unknown",
    repository: payload.project.path_with_namespace ?? payload.project.name,
    diffRefs: {
      baseSha: changesResponse.diff_refs.base_sha,
      headSha: changesResponse.diff_refs.head_sha,
      startSha: changesResponse.diff_refs.start_sha,
    },
    mrUrl: payload.object_attributes.url,
  };
}


export function resolveGitLabBaseUrl(
  baseUrlFromEnv: string | undefined,
  projectWebUrl: string,
): string {
  const allowInsecureHttp = readBoolEnv("ALLOW_INSECURE_GITLAB_HTTP");
  const fromEnv = baseUrlFromEnv?.trim();
  if (fromEnv) {
    return ensureSecureGitLabBaseUrl(fromEnv.replace(/\/$/, ""), allowInsecureHttp);
  }

  try {
    const parsed = new URL(projectWebUrl);
    return ensureSecureGitLabBaseUrl(parsed.origin, allowInsecureHttp);
  } catch {
    throw new Error("Missing GITLAB_BASE_URL and cannot infer from project.web_url");
  }
}

function ensureSecureGitLabBaseUrl(
  baseUrl: string,
  allowInsecureHttp: boolean,
): string {
  if (!allowInsecureHttp && /^http:\/\//i.test(baseUrl)) {
    throw new BadWebhookRequestError(
      "Insecure HTTP GitLab base URL is not allowed by default; use HTTPS or set ALLOW_INSECURE_GITLAB_HTTP=true for local testing",
    );
  }
  return baseUrl;
}


function resolveGitLabChangeStatus(change: GitLabChange): string {
  if (change.deleted_file) {
    return "removed";
  }

  if (change.new_file) {
    return "added";
  }

  if (change.renamed_file) {
    return "renamed";
  }

  return "modified";
}


function readBoolEnv(key: string): boolean {
  return parseBooleanEnv(readOptionalStringEnv(key));
}

export function buildGitLabCommentTargetFromPayload(params: {
  payload: GitLabMrWebhookBody;
  baseUrl?: string;
}): GitLabCommentTarget {
  return {
    baseUrl: resolveGitLabBaseUrl(params.baseUrl, params.payload.project.web_url),
    projectId: params.payload.project.id,
    mrId: params.payload.object_attributes.iid,
  };
}

export function requireGitLabToken(_headers: Record<string, string | undefined>): string {
  const token = readOptionalStringEnv("GITLAB_TOKEN");
  if (!token) {
    throw new BadWebhookRequestError(
      "Missing server-side GITLAB_TOKEN",
    );
  }
  return token;
}
