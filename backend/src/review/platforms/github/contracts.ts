import type { DiffFileContext } from "../../../repository/contracts.js";
import type { PullRequestReviewInput, ReviewMode, ReviewTrigger } from "#review";
import type { GitHubPublicationRuntime } from "../../../integrations/github/publication/contracts.js";
import type { MinimalGitHubOctokit } from "../../../integrations/github/api/types.js";

export interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitHubReviewContext {
  repo(): { owner: string; repo: string };
  octokit: MinimalGitHubOctokit;
  log: LoggerLike;
}

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
  publicationRuntime?: GitHubPublicationRuntime;
  sourceKey?: string;
  sourceHash?: string;
  runActor?: { actorType: "user" | "service"; actorId: string };
}

export interface GitHubCollectedContext {
  coverage?: { status: "complete" | "partial"; reasonCodes: readonly string[] };
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
