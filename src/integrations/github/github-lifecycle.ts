import { type ReviewTrigger } from "#review";
import {
  resolveGitHubPullRequestAutoReviewPolicy,
  runGitHubIssuePolicyCheck,
  runGitHubPullRequestPolicyCheck,
} from "./github-policy.js";
import { runGitHubIssueAutoTriageWorkflow } from "./github-issue-triage.js";
import { runGitHubReview, type GitHubReviewContext } from "./github-review.js";

type PullRequestAutoReviewAction = Parameters<
  typeof resolveGitHubPullRequestAutoReviewPolicy
>[0]["action"];

type PullRequestReviewTrigger = Extract<
  ReviewTrigger,
  "pr-opened" | "pr-edited" | "pr-synchronize"
>;

export async function runGitHubIssuePolicyWorkflow(params: {
  context: GitHubReviewContext;
  issueNumber: number;
  title?: string;
  body?: string;
  defaultBranch?: string;
  author?: string;
}): Promise<void> {
  await runGitHubIssuePolicyCheck({
    context: params.context,
    issueNumber: params.issueNumber,
    title: params.title ?? "",
    body: params.body ?? "",
    ref: params.defaultBranch,
  });
  await runGitHubIssueAutoTriageWorkflow({
    context: params.context,
    issueNumber: params.issueNumber,
    title: params.title ?? "",
    body: params.body ?? "",
    defaultBranch: params.defaultBranch,
    author: params.author,
  });
}

export async function runGitHubPullRequestLifecycleWorkflow(params: {
  context: GitHubReviewContext;
  pullNumber: number;
  title?: string;
  body?: string;
  headSha?: string;
  baseRef?: string;
  defaultBranch?: string;
  detailsUrl?: string;
  action: PullRequestAutoReviewAction;
  trigger: PullRequestReviewTrigger;
}): Promise<void> {
  const baseRef = params.baseRef ?? params.defaultBranch;
  await runGitHubPullRequestPolicyCheck({
    context: params.context,
    pullNumber: params.pullNumber,
    title: params.title ?? "",
    body: params.body ?? "",
    headSha: params.headSha,
    baseRef,
    detailsUrl: params.detailsUrl,
  });

  const autoReview = await resolveGitHubPullRequestAutoReviewPolicy({
    context: params.context,
    baseRef,
    action: params.action,
  });
  if (!autoReview.enabled) {
    return;
  }

  await runGitHubReview({
    context: params.context,
    pullNumber: params.pullNumber,
    mode: autoReview.mode,
    trigger: params.trigger,
    dedupeSuffix: params.headSha,
    customRules: autoReview.customRules,
    includeCiChecks: autoReview.includeCiChecks,
    enableSecretScan: autoReview.secretScanEnabled,
    secretScanCustomPatterns: autoReview.secretScanCustomPatterns,
    enableAutoLabel: autoReview.autoLabelEnabled,
  });
}
