import type { DiffFileContext, PullRequestReviewInput, ReviewMode, ReviewTrigger } from "@mr-agent/review";
import type { TenantConfig } from "@mr-agent/core";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

// ---------------------------------------------------------------------------
// GitHub API shapes
// ---------------------------------------------------------------------------

export interface GitHubPullSummary {
  title: string;
  body: string | null;
  user: { login: string } | null;
  draft?: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  html_url: string;
}

export interface GitHubIssueCommentSummary {
  id: number;
  body?: string | null;
}

export interface GitHubIssueSummary {
  number: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  pull_request?: unknown;
}

export interface GitHubPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubCompareCommitsResponse {
  files?: GitHubPullFile[];
}

export interface GitHubCheckRunSummary {
  name?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  };
}

export interface GitHubCheckRunCreateParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  details_url?: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required";
  completed_at?: string;
  output?: {
    title: string;
    summary: string;
    text?: string;
  };
}

export interface GitHubRepositoryContentFile {
  type?: "file" | "dir" | string;
  path?: string;
  encoding?: string;
  content?: string;
  sha?: string;
}

export interface GitHubPullFilesListParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  pull_number: number;
  per_page: number;
  page?: number;
}

export type GitHubPullsListFilesMethod = (
  params: GitHubPullFilesListParams,
) => Promise<{ data: GitHubPullFile[] }>;

export interface GitHubReviewCommentSummary {
  id: number;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  start_line?: number | null;
  commit_id?: string | null;
  user?: { login?: string; type?: string } | null;
}

export interface MinimalGitHubOctokit {
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<{
      data: GitHubRepositoryContentFile | GitHubRepositoryContentFile[];
    }>;
    compareCommits?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      base: string;
      head: string;
    }): Promise<{
      data: GitHubCompareCommitsResponse;
    }>;
    createOrUpdateFileContents?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      path: string;
      message: string;
      content: string;
      sha?: string;
      branch?: string;
    }): Promise<unknown>;
  };
  pulls: {
    get(params: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: GitHubPullSummary }>;
    listFiles: GitHubPullsListFilesMethod;
    createReviewComment(params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
      commit_id: string;
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
    }): Promise<unknown>;
    update(params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
    }): Promise<unknown>;
    listReviewComments?(params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubReviewCommentSummary[] }>;
    createReview?(params: {
      owner: string;
      repo: string;
      pull_number: number;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body?: string;
    }): Promise<unknown>;
  };
  issues: {
    listForRepo?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      sort?: "created" | "updated" | "comments";
      direction?: "asc" | "desc";
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubIssueSummary[] }>;
    listComments?(params: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubIssueCommentSummary[] }>;
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number } }>;
    updateComment(params: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<unknown>;
    addLabels?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<unknown>;
  };
  checks?: {
    create(params: GitHubCheckRunCreateParams): Promise<unknown>;
    listForRef?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      ref: string;
      per_page?: number;
    }): Promise<{
      data: { check_runs?: GitHubCheckRunSummary[] };
    }>;
  };
  paginate(
    method: GitHubPullsListFilesMethod,
    params: GitHubPullFilesListParams,
  ): Promise<GitHubPullFile[]>;
  getListFilesTruncated?(params: GitHubPullFilesListParams): boolean;
  getLastListFilesTruncated?(): boolean;
}

export interface GitHubReviewContext {
  repo(): { owner: string; repo: string };
  octokit: MinimalGitHubOctokit;
  log: LoggerLike;
}

// ---------------------------------------------------------------------------
// Internal parameter types
// ---------------------------------------------------------------------------

export interface GitHubReviewRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  mode: ReviewMode;
  trigger: ReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  enableSecretScan?: boolean;
  secretScanCustomPatterns?: string[];
  enableAutoLabel?: boolean;
  throwOnError?: boolean;
  tenantConfig?: TenantConfig;
}

export interface GitHubDescribeRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  apply?: boolean;
  trigger: ReviewTrigger;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

export interface GitHubAskRunParams {
  context: GitHubReviewContext;
  /** GitHub Issue or PR number (shared number space). */
  pullNumber: number;
  question: string;
  trigger: ReviewTrigger;
  managedCommentKey?: string;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  enableConversationContext?: boolean;
  isPullRequest?: boolean;
  /** Issue title — used as AI context when isPullRequest is false. */
  issueTitle?: string;
  /** Issue body — used as AI context when isPullRequest is false. */
  issueBody?: string;
  throwOnError?: boolean;
}

export interface GitHubChangelogRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  trigger: ReviewTrigger;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}

export interface GitHubCollectedContext {
  input: PullRequestReviewInput;
  files: DiffFileContext[];
  filesTruncated: boolean;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  author: string;
}
