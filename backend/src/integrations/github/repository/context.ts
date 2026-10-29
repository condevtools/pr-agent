import { assertReviewRunRevision, currentRunLease } from "../../../agent-runtime/execution/run-context.js";
import { readNumberEnv } from "#core";
import {
  GITHUB_GUIDELINE_DIRECTORIES,
  GITHUB_GUIDELINE_FILE_PATHS,
  isProcessTemplateFile,
  isReviewTargetFile,
} from "#review";
import type { PullRequestReviewInput } from "#review";
import { buildDiffFileContexts } from "../../../repository/diff/context.js";
import {
  loadProcessGuidelinesWithCache,
  type ProcessGuideline,
} from "../../../repository/process-guidelines.js";
import { decodeGitHubFileContent } from "./content.js";
import type {
  GitHubPullFile,
  GitHubPullFilesListParams,
  GitHubPullSummary,
  GitHubRepositoryContentFile,
  MinimalGitHubOctokit,
} from "../api/types.js";
import type { GitHubCollectedContext } from "../../../review/platforms/github/contracts.js";

const MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS_PER_FILE = 4_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const GITHUB_GUIDELINE_CACHE_SCOPE = "github-process-guidelines";

export function resolveGitHubPatchCharLimits(): {
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
} {
  const maxPatchCharsPerFile = Math.max(
    1,
    readNumberEnv(
      "GITHUB_MAX_PATCH_CHARS_PER_FILE",
      DEFAULT_MAX_PATCH_CHARS_PER_FILE,
    ),
  );
  const maxTotalPatchChars = Math.max(
    maxPatchCharsPerFile,
    readNumberEnv(
      "GITHUB_MAX_TOTAL_PATCH_CHARS",
      DEFAULT_MAX_TOTAL_PATCH_CHARS,
    ),
  );

  return {
    maxPatchCharsPerFile,
    maxTotalPatchChars,
  };
}

export async function collectGitHubPullRequestContext(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  pullNumber: number;
  incrementalBaseSha?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  feedbackSignals?: string[];
  pullSummary?: GitHubPullSummary;
}): Promise<GitHubCollectedContext> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    incrementalBaseSha,
    customRules,
    includeCiChecks = true,
    feedbackSignals,
    pullSummary,
  } = params;

  const pr =
    pullSummary ??
    (
      await octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      })
    ).data;
  const durableLease = currentRunLease();
  if (durableLease) {
    // The PR metadata is a freshness check only. All durable reads below are
    // pinned to the immutable revision accepted at Run intake.
    assertReviewRunRevision(pr.base.sha, pr.head.sha);
  }
  let files: GitHubPullFile[];
  let filesTruncated = false;
  if (durableLease) {
    if (!octokit.repos.compareCommits) {
      throw new Error("Durable GitHub review requires compareCommits support");
    }
    const compared = await octokit.repos.compareCommits({
      owner,
      repo,
      base: durableLease.baseSha,
      head: durableLease.headSha,
    });
    if (!Array.isArray(compared.data.files)) {
      throw new Error("GitHub compare response omitted the frozen file list");
    }
    files = compared.data.files;
    // GitHub documents a hard maximum of 300 files for the entire comparison.
    // Exactly 300 is therefore conservatively treated as potentially truncated.
    filesTruncated = files.length >= 300;
  } else if (incrementalBaseSha && incrementalBaseSha !== pr.head.sha) {
    const incrementalResult = await loadIncrementalPullFiles({
      octokit,
      owner,
      repo,
      pullNumber,
      incrementalBaseSha,
      headSha: pr.head.sha,
    });
    files = incrementalResult.files;
    filesTruncated = incrementalResult.truncated;
  } else {
    files = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    filesTruncated = readGitHubListFilesTruncated(octokit, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
  }

  const limits = resolveGitHubPatchCharLimits();
  const { files: changedFiles, coverage } = buildDiffFileContexts({
    candidates: files.map((file) => ({
      newPath: file.filename,
      oldPath: file.previous_filename ?? file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    })),
    maxFiles: MAX_FILES,
    maxPatchCharsPerFile: limits.maxPatchCharsPerFile,
    maxTotalPatchChars: limits.maxTotalPatchChars,
    shouldIncludeFile: (newPath) => isReviewTargetFile(newPath, "github"),
  });

  const usesFrozenComparison = Boolean(durableLease) ||
    Boolean(incrementalBaseSha && incrementalBaseSha !== pr.head.sha);
  const promptAdditions =
    usesFrozenComparison
      ? changedFiles.reduce((sum, item) => sum + Math.max(0, item.additions), 0)
      : pr.additions;
  const promptDeletions =
    usesFrozenComparison
      ? changedFiles.reduce((sum, item) => sum + Math.max(0, item.deletions), 0)
      : pr.deletions;
  const changedFilesCount =
    usesFrozenComparison
      ? changedFiles.length
      : pr.changed_files;

  const processGuidelines = await loadRepositoryProcessGuidelines({
    octokit,
    owner,
    repo,
    ref: durableLease?.baseSha ?? pr.base.ref,
  });
  const ciChecks = includeCiChecks
    ? await loadHeadCheckRuns({
        octokit,
        owner,
        repo,
        headSha: durableLease?.headSha ?? pr.head.sha,
      })
    : [];

  const input: PullRequestReviewInput = {
    platform: "github",
    repository: `${owner}/${repo}`,
    number: pullNumber,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    additions: promptAdditions,
    deletions: promptDeletions,
    changedFilesCount,
    changedFiles: changedFiles.map((file) => ({
      newPath: file.newPath,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      extendedDiff: file.extendedDiff,
    })),
    customRules: customRules ?? [],
    feedbackSignals: feedbackSignals ?? [],
    ciChecks,
    processGuidelines,
  };

  return {
    input,
    files: changedFiles,
    coverage: filesTruncated ? { status: "partial", reasonCodes: [...coverage.reasonCodes, "provider_file_limit"] } : coverage,
    filesTruncated,
    owner,
    repo,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    author: pr.user?.login ?? "unknown",
  };
}

function readGitHubListFilesTruncated(
  octokit: MinimalGitHubOctokit,
  params: GitHubPullFilesListParams,
): boolean {
  if (octokit.getListFilesTruncated) {
    return octokit.getListFilesTruncated(params);
  }
  return octokit.getLastListFilesTruncated?.() ?? false;
}

async function loadIncrementalPullFiles(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  pullNumber: number;
  incrementalBaseSha: string;
  headSha: string;
}): Promise<{ files: GitHubPullFile[]; truncated: boolean }> {
  if (!params.octokit.repos.compareCommits) {
    const files = await params.octokit.paginate(params.octokit.pulls.listFiles, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100,
    });
    return {
      files,
      truncated: readGitHubListFilesTruncated(params.octokit, {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        per_page: 100,
      }),
    };
  }

  try {
    const compared = await params.octokit.repos.compareCommits({
      owner: params.owner,
      repo: params.repo,
      base: params.incrementalBaseSha,
      head: params.headSha,
    });
    const files = compared.data.files ?? [];
    if (files.length > 0) {
      return {
        files,
        truncated: false,
      };
    }
  } catch {
    // Fallback to full file list when compare API is unavailable or SHAs are invalid.
  }

  const files = await params.octokit.paginate(params.octokit.pulls.listFiles, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });
  return {
    files,
    truncated: readGitHubListFilesTruncated(params.octokit, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100,
    }),
  };
}

async function loadHeadCheckRuns(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<
  Array<{
    name: string;
    status: string;
    conclusion: string;
    detailsUrl?: string;
    summary?: string;
  }>
> {
  if (!params.octokit.checks?.listForRef) {
    return [];
  }

  try {
    const response = await params.octokit.checks.listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.headSha,
      per_page: 100,
    });
    const checkRuns = response.data.check_runs ?? [];
    return checkRuns.slice(0, 50).map((item) => ({
      name: item.name ?? "unknown-check",
      status: item.status ?? "unknown",
      conclusion: (item.conclusion ?? "pending").toString(),
      detailsUrl: item.details_url ?? item.html_url ?? undefined,
      summary:
        item.output?.summary?.trim() ||
        item.output?.title?.trim() ||
        undefined,
    }));
  } catch {
    return [];
  }
}

async function loadRepositoryProcessGuidelines(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  ref: string;
}): Promise<ProcessGuideline[]> {
  const { octokit, owner, repo, ref } = params;
  return loadProcessGuidelinesWithCache({
    scope: GITHUB_GUIDELINE_CACHE_SCOPE,
    cacheKey: `${owner}/${repo}@${ref}`,
    ttlMs: readNumberEnv(
      "GITHUB_GUIDELINE_CACHE_TTL_MS",
      DEFAULT_GUIDELINE_CACHE_TTL_MS,
    ),
    maxEntries: MAX_GUIDELINE_CACHE_ENTRIES,
    filePaths: GITHUB_GUIDELINE_FILE_PATHS,
    directories: GITHUB_GUIDELINE_DIRECTORIES,
    maxGuidelines: MAX_GUIDELINES,
    maxGuidelinesPerDirectory: MAX_GUIDELINES_PER_DIRECTORY,
    isTemplateFile: (path) => isProcessTemplateFile(path, "github"),
    readFile: async (path) =>
      readGitHubGuidelineFile({
        octokit,
        owner,
        repo,
        ref,
        path,
      }),
    listDirectory: async (path) =>
      listGitHubDirectory({
        octokit,
        owner,
        repo,
        ref,
        path,
      }),
  });
}

async function readGitHubGuidelineFile(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}): Promise<ProcessGuideline | undefined> {
  try {
    const response = await params.octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      ref: params.ref,
    });
    const file = asContentFile(response.data);
    if (!file || file.type !== "file" || !file.content) {
      return undefined;
    }

    const text = decodeGitHubFileContent(file.content, file.encoding);
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }

    return {
      path: file.path ?? params.path,
      content: trimmed.slice(0, 4_000),
    };
  } catch {
    // File does not exist or cannot be read. Continue with other candidates.
    return undefined;
  }
}

async function listGitHubDirectory(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}): Promise<Array<{ path: string; type: string }>> {
  try {
    const response = await params.octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      ref: params.ref,
    });
    if (!Array.isArray(response.data)) {
      return [];
    }

    return response.data
      .map((item) => ({
        path: item.path ?? "",
        type: item.type ?? "",
      }))
      .filter((item) => Boolean(item.path));
  } catch {
    return [];
  }
}

function asContentFile(
  data: GitHubRepositoryContentFile | GitHubRepositoryContentFile[],
): GitHubRepositoryContentFile | undefined {
  if (Array.isArray(data)) {
    return undefined;
  }

  return data;
}
