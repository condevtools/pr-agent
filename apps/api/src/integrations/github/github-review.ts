import {
  clearDuplicateRecord,
  ensureError,
  isDuplicateRequestAsync,
  localizeText,
  readNumberEnv,
  readOptionalStringEnv,
  readStringEnv,
  resolveUiLocale,
  type UiLocale,
} from "@mr-agent/core";
import { publishNotification } from "#integrations/notify";
import {
  analyzePullRequest,
  buildIssueCommentMarkdown,
  buildReportCommentMarkdown,
  findFileForReview,
  getTenantConcurrencyLimiter,
  GITHUB_GUIDELINE_DIRECTORIES,
  GITHUB_GUIDELINE_FILE_PATHS,
  isProcessTemplateFile,
  isReviewTargetFile,
  resolveReviewLineForIssue,
} from "@mr-agent/review";
import type {
  DiffFileContext,
  PullRequestReviewInput,
  PullRequestReviewResult,
  ReviewMode,
  ReviewTrigger,
} from "@mr-agent/review";
import { decodeGitHubFileContent } from "./github-content.js";
import { createGitHubCommandWorkflows } from "./github-command-workflows.js";
import { inferReviewLabels } from "@mr-agent/shared/auto-labels.js";
import { buildChangelogQuestion } from "@mr-agent/shared/command-builders.js";
import { mergeChangelogContent as mergeSharedChangelogContent } from "@mr-agent/shared/changelog.js";
import { buildDescribeQuestion } from "@mr-agent/shared/describe-question.js";
import { buildDiffFileContexts } from "@mr-agent/shared/diff-context.js";
import {
  recordFeedbackSignal,
  recordFeedbackSignalAsync,
} from "@mr-agent/shared/feedback-signals.js";
import {
  loadProcessGuidelinesWithCache,
  type ProcessGuideline,
} from "@mr-agent/shared/process-guidelines.js";
import { getPublicErrorMessage } from "@mr-agent/shared/public-error.js";
import {
  loadIncrementalReviewHeadAsync,
  readMergedFeedbackSignalsAsync,
  readMergedFeedbackSignals,
  rememberIncrementalReviewHeadAsync,
} from "@mr-agent/shared/review-state.js";
import {
  findPotentialSecrets as findSharedPotentialSecrets,
  isLikelyPlaceholder as isLikelyPlaceholderShared,
  type SecretFinding,
} from "@mr-agent/shared/secret-scan.js";
import { buildSecretWarningComment } from "@mr-agent/shared/secret-warning.js";
import { reviewMessage } from "@mr-agent/shared/review-messages.js";
import {
  buildManagedCommentBody,
  buildManagedCommentMarker,
  type ManagedCommentKey,
  MANAGED_COMMENT_SCAN_PER_PAGE,
  MAX_MANAGED_COMMENT_SCAN_PAGES,
} from "@mr-agent/shared/managed-comments.js";
import {
  DEFAULT_DEDUPE_TTL_MS,
  isAutoReviewTrigger,
  resolveDedupeTtlMs,
  shouldSkipReviewForDraft,
  shouldUseIncrementalReview,
  shouldUseManagedReviewSummary,
} from "@mr-agent/shared/review-triggers.js";
export type {
  GitHubAskRunParams,
  GitHubChangelogRunParams,
  GitHubCheckRunCreateParams,
  GitHubCheckRunSummary,
  GitHubCollectedContext,
  GitHubCompareCommitsResponse,
  GitHubDescribeRunParams,
  GitHubIssueCommentSummary,
  GitHubIssueSummary,
  GitHubPullFile,
  GitHubPullFilesListParams,
  GitHubPullsListFilesMethod,
  GitHubPullSummary,
  GitHubRepositoryContentFile,
  GitHubReviewCommentSummary,
  GitHubReviewContext,
  GitHubReviewRunParams,
  LoggerLike,
  MinimalGitHubOctokit,
} from "./github-review-types.js";
import type {
  GitHubAskRunParams,
  GitHubChangelogRunParams,
  GitHubCheckRunCreateParams,
  GitHubCheckRunSummary,
  GitHubCollectedContext,
  GitHubDescribeRunParams,
  GitHubPullFile,
  GitHubPullFilesListParams,
  GitHubPullSummary,
  GitHubRepositoryContentFile,
  GitHubReviewContext,
  GitHubReviewRunParams,
  MinimalGitHubOctokit,
} from "./github-review-types.js";
import { getPlanConcurrencyLimit } from "../../common/config/plan-concurrency.js";
// TODO(refactor): Decompose this 1400+ line file into focused modules
//
// Suggested extraction plan:
//   1. github-review-orchestrator.ts – top-level review orchestration & dedup (~350 lines)
//   2. github-review-diff.ts         – diff fetching, patch limits, file context (~300 lines)
//   3. github-review-comments.ts     – managed comment CRUD & formatting (~250 lines)
//   4. github-review-guidelines.ts   – guideline loading & caching (~200 lines)
//   5. github-review-ask.ts          – /ask & /describe command runners (~200 lines)
//
// Prerequisites:
//   - Ensure exported types from github-review-types.js are re-exported cleanly
//   - Add integration tests for incremental review state round-trips
//   - Add tests for managed-comment update/create flows
// ---------------------------------------------------------------------------

const MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS_PER_FILE = 4_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FEEDBACK_SIGNALS = 80;
const MAX_FEEDBACK_CACHE_ENTRIES = 1_000;
const GITHUB_INCREMENTAL_STATE_SCOPE = "github-incremental-head";
const GITHUB_FEEDBACK_SIGNAL_SCOPE = "github-feedback-signals";
const GITHUB_GUIDELINE_CACHE_SCOPE = "github-process-guidelines";
const GITHUB_PULL_FILES_TRUNCATED_WARNING = {
  zh: "⚠️ 文件列表拉取达到上限（最多 20 页 * 100 = 2000 个文件），当前评审结果可能未覆盖全部变更。",
  en: "⚠️ File listing reached the hard limit (20 pages * 100 = 2000 files); this review may not cover all changed files.",
} as const;

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

export { buildManagedCommandCommentKey } from "@mr-agent/shared/managed-comments.js";

export function shouldSkipGitHubReviewForDraft(
  trigger: ReviewTrigger,
  isDraft: boolean,
): boolean {
  return shouldSkipReviewForDraft(trigger, isDraft);
}

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

export async function runGitHubReview(
  params: GitHubReviewRunParams,
): Promise<void> {
  const {
    context,
    pullNumber,
    mode,
    trigger,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    secretScanCustomPatterns = [],
    enableAutoLabel = true,
    throwOnError = false,
    tenantConfig,
  } = params;
  const { owner, repo } = context.repo();
  const locale = resolveUiLocale();
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  const dedupeTtlMs = resolveDedupeTtlMs(trigger, mode, "GITHUB");

  if (await isDuplicateRequestAsync(requestKey, dedupeTtlMs)) {
    if (trigger === "comment-command") {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "`AI Review` 最近 5 分钟内已经执行过，本次请求已跳过。",
            en: "`AI Review` already ran in the last 5 minutes, skipped this request.",
          },
          locale,
        ),
      });
    }
    return;
  }

  context.log.info(
    { owner, repo, pullNumber, mode, trigger },
    "Starting GitHub AI review",
  );

  const reviewPrKey = `${owner}/${repo}#${pullNumber}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? await getIncrementalHead(reviewPrKey)
    : undefined;
  const feedbackSignals = await loadGitHubFeedbackSignalsAsync(
    owner,
    repo,
    pullNumber,
  );
  let preloadedPullSummary: GitHubPullSummary | undefined;

  if (isAutoReviewTrigger(trigger)) {
    const prMeta = await context.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    preloadedPullSummary = prMeta.data;
    if (shouldSkipGitHubReviewForDraft(trigger, Boolean(prMeta.data.draft))) {
      context.log.info(
        { owner, repo, pullNumber, trigger },
        "Skipping GitHub AI review for draft pull request",
      );
      return;
    }
    if (
      trigger === "pr-edited" &&
      incrementalBaseSha &&
      incrementalBaseSha === prMeta.data.head.sha
    ) {
      context.log.info(
        { owner, repo, pullNumber, trigger, headSha: prMeta.data.head.sha },
        "Skipping GitHub AI review for pull_request.edited without code changes",
      );
      return;
    }
  }

  let progressCommentId: number | undefined;
  if (trigger === "comment-command") {
    const progress = await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: reviewMessage("reviewRunning", locale),
    });
    progressCommentId = progress.data.id;
  }

  try {
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      incrementalBaseSha,
      customRules,
      includeCiChecks,
      feedbackSignals,
      pullSummary: preloadedPullSummary,
    });

    if (collected.files.length === 0) {
      const noDiffBody = collected.filesTruncated
        ? appendGitHubFilesTruncatedWarning(
            reviewMessage("reviewNoDiff", locale),
            locale,
          )
        : undefined;
      await publishGitHubNoDiffStatus({
        context,
        owner,
        repo,
        pullNumber,
        progressCommentId,
        markerKey: "review-no-diff",
        body: noDiffBody,
      });
      await rememberIncrementalHead(reviewPrKey, collected.headSha);
      return;
    }

    const runAnalysis = () => analyzePullRequest(collected.input, { tenantConfig });

    // Apply per-tenant concurrency limiting when tenant is resolved
    const reviewResult = tenantConfig
      ? await getTenantConcurrencyLimiter(
          tenantConfig.tenantId,
          getPlanConcurrencyLimit(tenantConfig.plan),
        ).withLimit(runAnalysis)
      : await runAnalysis();

    if (mode === "comment") {
      const posted = await publishGitHubLineComments(
        context,
        collected,
        reviewResult,
        locale,
      );
      const summaryBody = [
        reviewMessage("reviewCommentModeTitle", locale),
        "",
        localizeText(
          {
            zh: `已发布行级评论: **${posted.posted}**，跳过: **${posted.skipped}**`,
            en: `Line comments posted: **${posted.posted}**, skipped: **${posted.skipped}**`,
          },
          locale,
        ),
        "",
        reviewMessage("reviewCommentModeHint", locale),
      ].join("\n");
      const summaryBodyWithWarning = maybeAppendGitHubFilesTruncatedWarning(
        summaryBody,
        collected.filesTruncated,
        locale,
      );
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitHubManagedIssueComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: summaryBodyWithWarning,
          markerKey: "review-comment-summary",
        });
      } else {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: summaryBodyWithWarning,
        });
      }
    } else {
      const body = buildReportCommentMarkdown(reviewResult, collected.files, {
        platform: "github",
        owner: collected.owner,
        repo: collected.repo,
        baseSha: collected.baseSha,
        headSha: collected.headSha,
      }, {
        locale,
      });
      const bodyWithWarning = maybeAppendGitHubFilesTruncatedWarning(
        body,
        collected.filesTruncated,
        locale,
      );
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitHubManagedIssueComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: bodyWithWarning,
          markerKey: "review-report",
        });
      } else {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: bodyWithWarning,
        });
      }
    }

    if (enableSecretScan) {
      const findings = findSharedPotentialSecrets({
        files: collected.files,
        customPatterns: secretScanCustomPatterns,
        maxFindings: 10,
      });
      if (findings.length > 0) {
        await publishSecretWarningComment({
          context,
          owner,
          repo,
          pullNumber,
          headSha: collected.headSha,
          findings,
        });
      }

      if (enableAutoLabel) {
        const labels = inferPullRequestLabels({
          title: collected.input.title,
          files: collected.files,
          reviewResult,
          hasSecretFinding: findings.length > 0,
        });
        await tryAddPullRequestLabels({
          context,
          owner,
          repo,
          pullNumber,
          labels,
        });
      }
    } else if (enableAutoLabel) {
      const labels = inferPullRequestLabels({
        title: collected.input.title,
        files: collected.files,
        reviewResult,
        hasSecretFinding: false,
      });
      await tryAddPullRequestLabels({
        context,
        owner,
        repo,
        pullNumber,
        labels,
      });
    }

    await rememberIncrementalHead(reviewPrKey, collected.headSha);

    if (progressCommentId) {
      await context.octokit.issues.updateComment({
        owner,
        repo,
        comment_id: progressCommentId,
        body: reviewMessage("reviewCompleted", locale),
      });
    }

    try {
      await publishNotification({
        pushUrl:
          readOptionalStringEnv("GITHUB_PUSH_URL") ??
          readOptionalStringEnv("NOTIFY_WEBHOOK_URL"),
        author: collected.author,
        repository: `${owner}/${repo}`,
        sourceBranch: collected.headBranch,
        targetBranch: collected.baseBranch,
        content: localizeText(
          {
            zh: `代码评审完毕 https://github.com/${owner}/${repo}/pull/${pullNumber}`,
            en: `Code review completed https://github.com/${owner}/${repo}/pull/${pullNumber}`,
          },
          locale,
        ),
      });
    } catch (notifyError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(notifyError),
        },
        "Failed to publish GitHub success notification",
      );
    }
  } catch (error) {
    clearDuplicateRecord(requestKey);

    const reason = getErrorMessage(error);
    const publicReason = getPublicErrorMessage(error);
    context.log.error(
      { owner, repo, pullNumber, mode, trigger, error: reason },
      "GitHub AI review failed",
    );

    try {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          reviewMessage("reviewFailureTitle", locale),
          "",
          localizeText(
            {
              zh: `错误：\`${publicReason}\``,
              en: `Error: \`${publicReason}\``,
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: "请检查 AI_PROVIDER/模型 API Key/GitHub App 权限配置。",
              en: "Please check AI_PROVIDER/model API key/GitHub App permission settings.",
            },
            locale,
          ),
        ].join("\n"),
      });
    } catch (commentError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(commentError),
        },
        "Failed to publish GitHub failure comment",
      );
    }

    if (progressCommentId) {
      try {
        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: progressCommentId,
          body: reviewMessage("reviewFailureProgressHint", locale),
        });
      } catch (updateError) {
        context.log.error(
          {
            owner,
            repo,
            pullNumber,
            mode,
            trigger,
            progressCommentId,
            error: getErrorMessage(updateError),
          },
          "Failed to update GitHub progress comment after failure",
        );
      }
    }

    try {
      await publishNotification({
        pushUrl:
          readOptionalStringEnv("GITHUB_PUSH_URL") ??
          readOptionalStringEnv("NOTIFY_WEBHOOK_URL"),
        author: "system",
        repository: `${owner}/${repo}`,
        sourceBranch: "-",
        targetBranch: "-",
        content: localizeText(
          {
            zh: `代码评审失败: ${publicReason}`,
            en: `Code review failed: ${publicReason}`,
          },
          locale,
        ),
      });
    } catch (notifyError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(notifyError),
        },
        "Failed to publish GitHub failure notification",
      );
    }

    if (throwOnError) {
      throw ensureError(error);
    }
  }
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

export function recordGitHubFeedbackSignal(params: {
  owner: string;
  repo: string;
  pullNumber?: number;
  signal: string;
}): void {
  const feedbackKey = buildGitHubFeedbackSignalKey(
    params.owner,
    params.repo,
    params.pullNumber,
  );
  recordFeedbackSignal({
    scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
    key: feedbackKey,
    signal: params.signal,
    ttlMs: readNumberEnv(
      "GITHUB_FEEDBACK_SIGNAL_TTL_MS",
      DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
    ),
    maxSignals: MAX_FEEDBACK_SIGNALS,
    maxEntries: MAX_FEEDBACK_CACHE_ENTRIES,
  });
}

export async function recordGitHubFeedbackSignalAsync(params: {
  owner: string;
  repo: string;
  pullNumber?: number;
  signal: string;
}): Promise<void> {
  const feedbackKey = buildGitHubFeedbackSignalKey(
    params.owner,
    params.repo,
    params.pullNumber,
  );
  await recordFeedbackSignalAsync({
    scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
    key: feedbackKey,
    signal: params.signal,
    ttlMs: readNumberEnv(
      "GITHUB_FEEDBACK_SIGNAL_TTL_MS",
      DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
    ),
    maxSignals: MAX_FEEDBACK_SIGNALS,
    maxEntries: MAX_FEEDBACK_CACHE_ENTRIES,
  });
}

function loadGitHubFeedbackSignals(
  owner: string,
  repo: string,
  pullNumber?: number,
): string[] {
  const feedbackKey = buildGitHubFeedbackSignalKey(owner, repo, pullNumber);
  const repositoryLevelKey = buildGitHubFeedbackSignalKey(owner, repo);
  if (
    !Number.isInteger(pullNumber) ||
    (pullNumber as number) <= 0 ||
    feedbackKey === repositoryLevelKey
  ) {
    return readMergedFeedbackSignals({
      scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
      scopedKey: repositoryLevelKey,
      maxSignals: MAX_FEEDBACK_SIGNALS,
    });
  }
  return readMergedFeedbackSignals({
    scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
    scopedKey: feedbackKey,
    fallbackKey: repositoryLevelKey,
    maxSignals: MAX_FEEDBACK_SIGNALS,
  });
}

async function loadGitHubFeedbackSignalsAsync(
  owner: string,
  repo: string,
  pullNumber?: number,
): Promise<string[]> {
  const feedbackKey = buildGitHubFeedbackSignalKey(owner, repo, pullNumber);
  const repositoryLevelKey = buildGitHubFeedbackSignalKey(owner, repo);
  if (
    !Number.isInteger(pullNumber) ||
    (pullNumber as number) <= 0 ||
    feedbackKey === repositoryLevelKey
  ) {
    return readMergedFeedbackSignalsAsync({
      scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
      scopedKey: repositoryLevelKey,
      maxSignals: MAX_FEEDBACK_SIGNALS,
    });
  }
  return readMergedFeedbackSignalsAsync({
    scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
    scopedKey: feedbackKey,
    fallbackKey: repositoryLevelKey,
    maxSignals: MAX_FEEDBACK_SIGNALS,
  });
}

function buildGitHubFeedbackSignalKey(
  owner: string,
  repo: string,
  pullNumber?: number,
): string {
  const base = `${owner}/${repo}`;
  if (!Number.isInteger(pullNumber) || (pullNumber as number) <= 0) {
    return base;
  }

  return `${base}#${pullNumber}`;
}

export function readGitHubFeedbackSignals(
  owner: string,
  repo: string,
  pullNumber?: number,
): string[] {
  return loadGitHubFeedbackSignals(owner, repo, pullNumber);
}

async function collectGitHubPullRequestContext(params: {
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
  let files: GitHubPullFile[];
  let filesTruncated = false;
  if (incrementalBaseSha && incrementalBaseSha !== pr.head.sha) {
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
  const { files: changedFiles } = buildDiffFileContexts({
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

  const promptAdditions =
    incrementalBaseSha && incrementalBaseSha !== pr.head.sha
      ? changedFiles.reduce((sum, item) => sum + Math.max(0, item.additions), 0)
      : pr.additions;
  const promptDeletions =
    incrementalBaseSha && incrementalBaseSha !== pr.head.sha
      ? changedFiles.reduce((sum, item) => sum + Math.max(0, item.deletions), 0)
      : pr.deletions;
  const changedFilesCount =
    incrementalBaseSha && incrementalBaseSha !== pr.head.sha
      ? changedFiles.length
      : pr.changed_files;

  const processGuidelines = await loadRepositoryProcessGuidelines({
    octokit,
    owner,
    repo,
    ref: pr.base.ref,
  });
  const ciChecks = includeCiChecks
    ? await loadHeadCheckRuns({
        octokit,
        owner,
        repo,
        headSha: pr.head.sha,
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

async function publishGitHubLineComments(
  context: GitHubReviewContext,
  collected: GitHubCollectedContext,
  reviewResult: PullRequestReviewResult,
  locale: UiLocale,
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
      await context.octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: collected.input.number,
        body: buildIssueCommentMarkdown(review, { platform: "github", locale }),
        commit_id: collected.headSha,
        path: file.newPath,
        line,
        side: review.type === "new" ? "RIGHT" : "LEFT",
      });
      posted += 1;
    } catch {
      skipped += 1;
    }
  }

  return { posted, skipped };
}

const gitHubCommandWorkflows = createGitHubCommandWorkflows({
  defaultDedupeTtlMs: DEFAULT_DEDUPE_TTL_MS,
  collectPullRequestContext: async (params) =>
    collectGitHubPullRequestContext({
      octokit: params.context.octokit as MinimalGitHubOctokit,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      customRules: params.customRules,
      includeCiChecks: params.includeCiChecks,
      feedbackSignals: params.feedbackSignals,
    }),
  postCommandComment: postGitHubCommandComment,
  loadFeedbackSignals: loadGitHubFeedbackSignalsAsync,
  buildDescribeQuestion: buildGitHubDescribeQuestion,
  buildChangelogQuestion: buildGitHubChangelogQuestion,
  applyChangelogUpdate: applyGitHubChangelogUpdate,
  getErrorMessage,
});

export async function runGitHubDescribe(
  params: GitHubDescribeRunParams,
): Promise<void> {
  return gitHubCommandWorkflows.runDescribe(params);
}

export async function runGitHubAsk(
  params: GitHubAskRunParams,
): Promise<void> {
  return gitHubCommandWorkflows.runAsk(params);
}

export async function runGitHubChangelog(
  params: GitHubChangelogRunParams,
): Promise<void> {
  return gitHubCommandWorkflows.runChangelog(params);
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

async function getIncrementalHead(
  reviewPrKey: string,
): Promise<string | undefined> {
  return loadIncrementalReviewHeadAsync({
    scope: GITHUB_INCREMENTAL_STATE_SCOPE,
    key: reviewPrKey,
  });
}

async function rememberIncrementalHead(
  reviewPrKey: string,
  headSha: string,
): Promise<void> {
  await rememberIncrementalReviewHeadAsync({
    scope: GITHUB_INCREMENTAL_STATE_SCOPE,
    key: reviewPrKey,
    headSha,
    ttlMs: readNumberEnv(
      "GITHUB_INCREMENTAL_STATE_TTL_MS",
      DEFAULT_INCREMENTAL_STATE_TTL_MS,
    ),
    maxEntries: MAX_INCREMENTAL_STATE_ENTRIES,
  });
}

export function isLikelyPlaceholder(text: string): boolean {
  return isLikelyPlaceholderShared(text);
}

async function publishSecretWarningComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  findings: SecretFinding[];
}): Promise<void> {
  const dedupeKey = [
    "github-secret-scan",
    `${params.owner}/${params.repo}`,
    `${params.pullNumber}`,
    params.headSha,
  ].join(":");
  if (await isDuplicateRequestAsync(dedupeKey, DEFAULT_DEDUPE_TTL_MS)) {
    return;
  }
  const locale = resolveUiLocale();

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: buildSecretWarningComment({
      platform: "github",
      findings: params.findings,
      locale,
    }),
  });
}

function inferPullRequestLabels(params: {
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

async function tryAddPullRequestLabels(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  labels: string[];
}): Promise<void> {
  if (!params.context.octokit.issues.addLabels || params.labels.length === 0) {
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

export function buildGitHubChangelogQuestion(
  focus: string | undefined,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildChangelogQuestion("PR", focus, locale);
}

export function buildGitHubDescribeQuestion(
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildDescribeQuestion("PR", locale);
}

async function applyGitHubChangelogUpdate(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  branch: string;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const locale = resolveUiLocale();
  const path = readStringEnv("GITHUB_CHANGELOG_PATH", "CHANGELOG.md");
  const title = `PR #${params.pullNumber}`;
  const octokit = params.context.octokit;
  if (!octokit.repos.createOrUpdateFileContents) {
    return {
      message: localizeText(
        {
          zh: "当前运行模式不支持自动写回仓库文件，已生成 changelog 草稿供手动应用。",
          en: "Current runtime mode does not support writing back repository files automatically. A changelog draft has been generated for manual apply.",
        },
        locale,
      ),
    };
  }

  let existing = "";
  let existingSha: string | undefined;
  try {
    const response = await octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path,
      ref: params.branch,
    });
    const data = response.data;
    if (!Array.isArray(data) && data.content) {
      existing = decodeGitHubFileContent(data.content, data.encoding);
      existingSha = data.sha;
    }
  } catch {
    // create path on first write
  }

  const merged = mergeChangelogContent(existing, params.draft, title);
  await octokit.repos.createOrUpdateFileContents({
    owner: params.owner,
    repo: params.repo,
    path,
    message: `chore(changelog): update from ${title}`,
    content: Buffer.from(merged, "utf8").toString("base64"),
    sha: existingSha,
    branch: params.branch,
  });

  return {
    message: localizeText(
      {
        zh: `已写入 \`${path}\`（branch: \`${params.branch}\`）。`,
        en: `Written to \`${path}\` (branch: \`${params.branch}\`).`,
      },
      locale,
    ),
  };
}

export function mergeChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  return mergeSharedChangelogContent(currentContent, draft, title);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
