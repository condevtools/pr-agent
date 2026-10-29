import type { ReviewTrigger } from "#review";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";

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
