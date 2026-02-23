import {
  BadWebhookRequestError,
  clearDuplicateRecord,
  ensureError,
  isDuplicateRequest,
  isRateLimited,
  loadRuntimeStateValue,
  loadAskConversationTurns,
  localizeText,
  nowMs,
  normalizeRateLimitPart,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
  readStringEnv,
  rememberAskConversationTurn,
  resolveUiLocale,
  saveRuntimeStateValue,
  type UiLocale,
} from "#core";
import { publishNotification } from "#integrations/notify";
import {
  analyzePullRequest,
  answerPullRequestQuestion,
  buildIssueCommentMarkdown,
  buildReportCommentMarkdown,
  countPatchChanges,
  findSimilarIssues,
  findFileForReview,
  GITLAB_GUIDELINE_DIRECTORIES,
  GITLAB_GUIDELINE_FILE_PATHS,
  parseAddDocCommand,
  isProcessTemplateFile,
  isReviewTargetFile,
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parseImproveCommand,
  parseReflectCommand,
  parseReviewCommand,
  parseSimilarIssueCommand,
  resolveReviewLineForIssue,
} from "#review";
import type {
  DiffFileContext,
  PullRequestReviewInput,
  PullRequestReviewResult,
  ReviewMode,
  ReviewTrigger,
} from "#review";
import {
  buildAddDocRule,
  buildChangelogQuestion,
  buildChecksQuestion,
  buildGenerateTestsQuestion,
  buildImproveRule,
  buildReflectQuestion,
} from "../shared/command-builders.js";
import { inferReviewLabels } from "../shared/auto-labels.js";
import { buildDescribeQuestion } from "../shared/describe-question.js";
import {
  dispatchCommandRegistrations,
  type CommandDispatchResult,
  type CommandRegistration,
} from "../shared/command-dispatch.js";
import { buildDiffFileContexts } from "../shared/diff-context.js";
import {
  buildCommandApplyDisabledByPolicyMessage,
  buildCommandDisabledByPolicyMessage,
  buildFeedbackSignalRecordedMessage,
  buildReflectDependsOnAskMessage,
} from "../shared/command-messages.js";
import { mergeChangelogContent as mergeSharedChangelogContent } from "../shared/changelog.js";
import { recordFeedbackSignal } from "../shared/feedback-signals.js";
import {
  loadProcessGuidelinesWithCache,
  type ProcessGuideline,
} from "../shared/process-guidelines.js";
import { getPublicErrorMessage } from "../shared/public-error.js";
import { parseReviewPolicyOverridesFromConfigText } from "../shared/review-policy-parser.js";
import {
  loadIncrementalReviewHead,
  readMergedFeedbackSignals,
  rememberIncrementalReviewHead,
} from "../shared/review-state.js";
import {
  findPotentialSecrets as findSharedPotentialSecrets,
  type SecretFinding,
} from "../shared/secret-scan.js";
import { buildSecretWarningComment } from "../shared/secret-warning.js";
import { reviewMessage } from "../shared/review-messages.js";
import {
  buildSimilarIssueComment,
  buildSimilarIssueQueryMissingMessage,
  resolveSimilarIssueQuery,
} from "../shared/similar-issue.js";
import { createGitLabCommandWorkflows } from "./gitlab-command-workflows.js";
import { gitLabApiRequest } from "./gitlab-http.js";
import {
  buildManagedCommandCommentKey,
  buildManagedCommentBody,
  buildManagedCommentMarker,
  type ManagedCommentKey,
  MANAGED_COMMENT_SCAN_PER_PAGE,
  MAX_MANAGED_COMMENT_SCAN_PAGES,
} from "../shared/managed-comments.js";
import {
  DEFAULT_DEDUPE_TTL_MS,
  isAutoReviewTrigger,
  resolveDedupeTtlMs,
  shouldSkipReviewForDraft,
  shouldUseIncrementalReview,
  shouldUseManagedReviewSummary,
} from "../shared/review-triggers.js";

const MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS_PER_FILE = 4_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
const MAX_FEEDBACK_SIGNALS = 80;
const MAX_FEEDBACK_CACHE_ENTRIES = 1_000;
const GITLAB_INCREMENTAL_STATE_SCOPE = "gitlab-incremental-head";
const GITLAB_FEEDBACK_SIGNAL_SCOPE = "gitlab-feedback-signals";
const GITLAB_GUIDELINE_CACHE_SCOPE = "gitlab-process-guidelines";
const GITLAB_POLICY_CACHE_SCOPE = "gitlab-review-policy";

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

interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitLabMrWebhookBody {
  object_kind?: string;
  event_type?: string;
  user?: {
    username?: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
    path_with_namespace?: string;
  };
  object_attributes: {
    action?: string;
    state?: string;
    iid: number;
    url: string;
    title: string;
    description?: string;
    work_in_progress?: boolean;
    draft?: boolean;
    source_branch: string;
    target_branch: string;
    last_commit?: {
      id?: string;
    };
  };
  merge_request?: {
    iid?: number;
    title?: string;
    description?: string;
    work_in_progress?: boolean;
    draft?: boolean;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    state?: string;
  };
}

export interface GitLabNoteWebhookBody {
  object_kind?: string;
  event_type?: string;
  user?: {
    username?: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
    path_with_namespace?: string;
  };
  object_attributes: {
    action?: string;
    note?: string;
    noteable_type?: string;
    noteable_iid?: number | string;
    url?: string;
  };
  merge_request?: {
    iid?: number;
    title?: string;
    description?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    state?: string;
  };
}

export type GitLabWebhookBody = GitLabMrWebhookBody | GitLabNoteWebhookBody;

interface GitLabChange {
  new_path: string;
  old_path: string;
  diff: string;
  deleted_file?: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}

interface GitLabChangesResponse {
  changes: GitLabChange[];
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

interface GitLabCompareResponse {
  diffs?: GitLabChange[];
}

interface GitLabCommentTarget {
  baseUrl: string;
  projectId: number;
  mrId: number;
}

interface GitLabCollectedContext extends GitLabCommentTarget {
  input: PullRequestReviewInput;
  files: DiffFileContext[];
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  repository: string;
  diffRefs: {
    baseSha: string;
    headSha: string;
    startSha: string;
  };
  mrUrl: string;
}

interface GitLabReviewRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  mode?: ReviewMode;
  trigger?: ReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  enableSecretScan?: boolean;
  secretScanCustomPatterns?: string[];
  enableAutoLabel?: boolean;
  throwOnError?: boolean;
}

interface GitLabAskRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  question: string;
  trigger: ReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  managedCommentKey?: string;
  enableConversationContext?: boolean;
  throwOnError?: boolean;
}

interface GitLabDescribeRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: ReviewTrigger;
  apply?: boolean;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

interface GitLabChangelogRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: ReviewTrigger;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}

interface GitLabReviewPolicy {
  enabled: boolean;
  mode: ReviewMode;
  onOpened: boolean;
  onEdited: boolean;
  onSynchronize: boolean;
  describeEnabled: boolean;
  describeAllowApply: boolean;
  checksCommandEnabled: boolean;
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  askCommandEnabled: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  feedbackCommandEnabled: boolean;
  customRules: string[];
}

const defaultGitLabReviewPolicy: GitLabReviewPolicy = {
  enabled: true,
  mode: "comment",
  onOpened: true,
  onEdited: false,
  onSynchronize: true,
  describeEnabled: true,
  describeAllowApply: false,
  checksCommandEnabled: true,
  includeCiChecks: true,
  secretScanEnabled: true,
  secretScanCustomPatterns: [],
  autoLabelEnabled: true,
  askCommandEnabled: true,
  generateTestsCommandEnabled: true,
  changelogCommandEnabled: true,
  changelogAllowApply: false,
  feedbackCommandEnabled: true,
  customRules: [],
};

const gitLabCommandWorkflows = createGitLabCommandWorkflows({
  defaultDedupeTtlMs: DEFAULT_DEDUPE_TTL_MS,
  requireGitLabToken,
  buildCommentTarget: (payload) =>
    buildGitLabCommentTargetFromPayload({
      payload: payload as GitLabMrWebhookBody,
      baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
    }),
  postCommandComment: postGitLabCommandComment,
  loadFeedbackSignals: loadGitLabFeedbackSignals,
  collectMergeRequestContext: async (params) =>
    collectGitLabMergeRequestContext({
      payload: params.payload as GitLabMrWebhookBody,
      gitlabToken: params.gitlabToken,
      baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
      customRules: params.customRules,
      includeCiChecks: params.includeCiChecks,
      feedbackSignals: params.feedbackSignals,
    }),
  buildDescribeQuestion: (locale) => buildGitLabDescribeQuestion(locale),
  buildChangelogQuestion: (focus, locale) =>
    buildGitLabChangelogQuestion(focus, locale),
  updateMergeRequestDescription: async (params) =>
    updateGitLabMergeRequestDescription({
      gitlabToken: params.gitlabToken,
      collected: params.collected as GitLabCollectedContext,
      description: params.description,
    }),
  applyChangelogUpdate: async (params) =>
    applyGitLabChangelogUpdate({
      gitlabToken: params.gitlabToken,
      collected: params.collected as GitLabCollectedContext,
      pullNumber: params.pullNumber,
      draft: params.draft,
    }),
});

function isGitLabTitleDraftLike(titleRaw: string | undefined): boolean {
  const title = (titleRaw ?? "").trim().toLowerCase();
  if (!title) {
    return false;
  }
  return (
    title.startsWith("draft:") ||
    title.startsWith("wip:") ||
    title.startsWith("[draft]") ||
    title.startsWith("(draft)")
  );
}

function isGitLabMergeRequestDraft(payload: GitLabMrWebhookBody): boolean {
  return Boolean(
    payload.object_attributes.draft ||
      payload.object_attributes.work_in_progress ||
      payload.merge_request?.draft ||
      payload.merge_request?.work_in_progress ||
      isGitLabTitleDraftLike(payload.object_attributes.title) ||
      isGitLabTitleDraftLike(payload.merge_request?.title),
  );
}

export function shouldSkipGitLabReviewForDraft(
  trigger: ReviewTrigger,
  isDraft: boolean,
): boolean {
  return shouldSkipReviewForDraft(trigger, isDraft);
}

export async function upsertGitLabManagedComment(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  body: string;
  markerKey: ManagedCommentKey;
  logger?: LoggerLike;
}): Promise<void> {
  const marker = buildManagedCommentMarker(params.markerKey);
  const nextBody = buildManagedCommentBody(params.body, params.markerKey);
  try {
    for (let page = 1; page <= MAX_MANAGED_COMMENT_SCAN_PAGES; page += 1) {
      const listed = await gitLabApiRequest({
        url: `${params.target.baseUrl}/api/v4/projects/${encodeURIComponent(params.target.projectId)}/merge_requests/${params.target.mrId}/notes?per_page=${MANAGED_COMMENT_SCAN_PER_PAGE}&page=${page}`,
        token: params.gitlabToken,
      });
      if (!listed.ok) {
        break;
      }

      const data = (await listed.json()) as Array<{ id?: number; body?: string }>;
      const existing = data.find(
        (item) =>
          typeof item.id === "number" &&
          typeof item.body === "string" &&
          item.body.includes(marker),
      );
      if (existing?.id) {
        const updateResp = await gitLabApiRequest({
          url: `${params.target.baseUrl}/api/v4/projects/${encodeURIComponent(params.target.projectId)}/merge_requests/${params.target.mrId}/notes/${existing.id}`,
          token: params.gitlabToken,
          method: "PUT",
          body: { body: nextBody },
        });
        if (updateResp.ok) {
          return;
        }
      }

      if (data.length < MANAGED_COMMENT_SCAN_PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    params.logger?.error(
      {
        projectId: params.target.projectId,
        mrId: params.target.mrId,
        markerKey: params.markerKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to upsert GitLab managed comment; falling back to create",
    );
  }

  await publishGitLabGeneralComment(params.gitlabToken, params.target, nextBody);
}

async function postGitLabCommandComment(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  body: string;
  managedCommentKey?: string;
  logger?: LoggerLike;
}): Promise<void> {
  if (params.managedCommentKey) {
    await upsertGitLabManagedComment({
      gitlabToken: params.gitlabToken,
      target: params.target,
      body: params.body,
      markerKey: params.managedCommentKey,
      logger: params.logger,
    });
    return;
  }

  await publishGitLabGeneralComment(params.gitlabToken, params.target, params.body);
}

function buildGitLabCommentTargetFromPayload(params: {
  payload: GitLabMrWebhookBody;
  baseUrl?: string;
}): GitLabCommentTarget {
  return {
    baseUrl: resolveGitLabBaseUrl(params.baseUrl, params.payload.project.web_url),
    projectId: params.payload.project.id,
    mrId: params.payload.object_attributes.iid,
  };
}

function isGitLabCommandRateLimited(params: {
  projectId: number;
  mrId: number;
  userName?: string;
  command: string;
}): boolean {
  const maxPerWindow = Math.max(
    1,
    readNumberEnv("COMMAND_RATE_LIMIT_MAX", DEFAULT_COMMAND_RATE_LIMIT_MAX),
  );
  const windowMs = Math.max(
    1_000,
    readNumberEnv(
      "COMMAND_RATE_LIMIT_WINDOW_MS",
      DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS,
    ),
  );
  const user = normalizeRateLimitPart(params.userName, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key =
    "gitlab:" +
    `${params.projectId}:mr:${params.mrId}:` +
    `user:${user}:cmd:${command}`;
  return isRateLimited(key, maxPerWindow, windowMs);
}

async function shouldRejectGitLabCommandByRateLimit(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  projectId: number;
  mrId: number;
  userName?: string;
  command: string;
  logger?: LoggerLike;
}): Promise<boolean> {
  if (
    !isGitLabCommandRateLimited({
      projectId: params.projectId,
      mrId: params.mrId,
      userName: params.userName,
      command: params.command,
    })
  ) {
    return false;
  }

  await postGitLabCommandComment({
    gitlabToken: params.gitlabToken,
    target: params.target,
    body: gitLabCommandRateLimitMessage(resolveUiLocale()),
    managedCommentKey: buildManagedCommandCommentKey(
      "rate-limit",
      params.command,
    ),
    logger: params.logger,
  });
  return true;
}

function gitLabCommandRateLimitMessage(locale: UiLocale): string {
  return localizeText(
    {
      zh: "`命令触发过于频繁，请稍后再试（默认每用户每 MR 每小时 10 次）。`",
      en: "`Command triggered too frequently. Please retry later (default: 10 times/hour per user per MR).`",
    },
    locale,
  );
}

export async function runGitLabWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const kind = (params.payload.object_kind ?? "merge_request").toLowerCase();
  if (kind === "merge_request") {
    const payload = params.payload as GitLabMrWebhookBody;
    const actionRaw = payload.object_attributes?.action;
    const action =
      typeof actionRaw === "string" ? actionRaw.toLowerCase() : undefined;
    if (action === "close" || action === "closed") {
      return { ok: true, message: "ignored closed merge request event" };
    }

    const gitlabToken = requireGitLabToken(params.headers);
    const baseUrl = resolveGitLabBaseUrl(
      readOptionalStringEnv("GITLAB_BASE_URL"),
      payload.project.web_url,
    );
    const actionKind = mapGitLabActionToReviewEvent(action);
    const policy = await resolveGitLabReviewPolicy({
      baseUrl,
      projectId: payload.project.id,
      gitlabToken,
      ref: payload.object_attributes.target_branch,
    });

    const headerMode = parseMode(params.headers["x-ai-mode"]);
    const resolvedMode =
      actionKind === "merged" ? "report" : (headerMode ?? policy.mode);
    const shouldRunByPolicy = shouldRunGitLabAutoReview(policy, actionKind);
    if (!shouldRunByPolicy && !headerMode) {
      return { ok: true, message: "merge_request action ignored by review policy" };
    }

    const trigger =
      actionKind === "opened"
        ? "pr-opened"
        : actionKind === "edited"
          ? "pr-edited"
          : actionKind === "synchronize"
            ? "pr-synchronize"
            : actionKind === "merged"
              ? "merged"
              : "gitlab-webhook";
    return runGitLabReview({
      payload,
      headers: params.headers,
      logger: params.logger,
      mode: resolvedMode,
      trigger,
      dedupeSuffix: payload.object_attributes.last_commit?.id,
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
      enableSecretScan: policy.secretScanEnabled,
      secretScanCustomPatterns: policy.secretScanCustomPatterns,
      enableAutoLabel: policy.autoLabelEnabled,
    });
  }

  if (kind === "note") {
    return handleGitLabNoteWebhook(params);
  }

  return { ok: true, message: `ignored object_kind=${kind}` };
}

export async function runGitLabReview(
  params: GitLabReviewRunParams,
): Promise<{ ok: boolean; message: string }> {
  const {
    payload,
    headers,
    logger,
    mode: modeOverride,
    trigger = "gitlab-webhook",
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    secretScanCustomPatterns = [],
    enableAutoLabel = true,
    throwOnError = false,
  } = params;
  if (payload.object_kind && payload.object_kind !== "merge_request") {
    return { ok: true, message: `ignored object_kind=${payload.object_kind}` };
  }

  const actionRaw = payload.object_attributes.action;
  const action = typeof actionRaw === "string" ? actionRaw.toLowerCase() : undefined;
  if (action === "close" || action === "closed") {
    return { ok: true, message: "ignored closed merge request event" };
  }

  const mode = modeOverride ?? parseMode(headers["x-ai-mode"]) ?? "report";
  const locale = resolveUiLocale();
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (isDuplicateRequest(requestKey, resolveDedupeTtlMs(trigger, mode, "GITLAB"))) {
    return { ok: true, message: "duplicate request ignored" };
  }

  if (shouldSkipGitLabReviewForDraft(trigger, isGitLabMergeRequestDraft(payload))) {
    return { ok: true, message: "draft merge request skipped" };
  }

  const gitlabToken = requireGitLabToken(headers);
  const reviewMrKey = `${payload.project.id}#${payload.object_attributes.iid}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? getIncrementalHead(reviewMrKey)
    : undefined;
  const currentHeadSha = payload.object_attributes.last_commit?.id?.trim();
  if (
    trigger === "pr-edited" &&
    incrementalBaseSha &&
    currentHeadSha &&
    incrementalBaseSha === currentHeadSha
  ) {
    logger.info(
      {
        projectId: payload.project.id,
        mrId: payload.object_attributes.iid,
        trigger,
        headSha: currentHeadSha,
      },
      "Skipping GitLab AI review for merge_request.edited without code changes",
    );
    return { ok: true, message: "merge_request.edited without code changes skipped" };
  }

  try {
    const feedbackSignals = loadGitLabFeedbackSignals(payload.project.id);
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
      incrementalBaseSha,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });

    logger.info(
      {
        projectId: collected.projectId,
        mrId: collected.mrId,
        mode,
        trigger,
      },
      "Starting GitLab AI review",
    );

    if (collected.files.length === 0) {
      const noDiffBody = reviewMessage("reviewNoDiffSkipped", locale);
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: noDiffBody,
          markerKey: "review-no-diff",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, noDiffBody);
      }
      rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);
      return { ok: true, message: "no textual diff to review" };
    }

    const result = await analyzePullRequest(collected.input);
    if (mode === "comment") {
      await publishGitLabLineComments(gitlabToken, collected, result, logger, locale);
      const summaryBody = [
        reviewMessage("reviewCommentModeTitle", locale),
        "",
        reviewMessage("reviewCommentModeHint", locale),
      ].join("\n");
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: summaryBody,
          markerKey: "review-comment-summary",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, summaryBody);
      }
    } else {
      const markdown = buildReportCommentMarkdown(result, collected.files, {
        platform: "gitlab",
        webUrl: collected.webUrl,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
      }, {
        locale,
      });
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: markdown,
          markerKey: "review-report",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, markdown);
      }
    }

    if (enableSecretScan) {
      const findings = findSharedPotentialSecrets({
        files: collected.files,
        customPatterns: secretScanCustomPatterns,
        maxFindings: 20,
      });
      if (findings.length > 0) {
        const warning = buildSecretWarningComment({
          platform: "gitlab",
          findings,
          locale,
        });
        await publishGitLabGeneralComment(gitlabToken, collected, warning);
      }

      if (enableAutoLabel) {
        const labels = inferMergeRequestLabels({
          title: collected.input.title,
          files: collected.files,
          reviewResult: result,
          hasSecretFinding: findings.length > 0,
        });
        await tryAddGitLabMergeRequestLabels({
          gitlabToken,
          collected,
          labels,
          logger,
        });
      }
    } else if (enableAutoLabel) {
      const labels = inferMergeRequestLabels({
        title: collected.input.title,
        files: collected.files,
        reviewResult: result,
        hasSecretFinding: false,
      });
      await tryAddGitLabMergeRequestLabels({
        gitlabToken,
        collected,
        labels,
        logger,
      });
    }

    rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);

    const pushUrl =
      headers["x-push-url"] ??
      headers["x-qwx-robot-url"] ??
      readOptionalStringEnv("GITLAB_PUSH_URL") ??
      readOptionalStringEnv("NOTIFY_WEBHOOK_URL");
    try {
      await publishNotification({
        pushUrl,
        author: collected.author,
        repository: collected.repository,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
        content: localizeText(
          {
            zh: `代码评审完毕 ${collected.mrUrl}`,
            en: `Code review completed ${collected.mrUrl}`,
          },
          locale,
        ),
        logger,
      });
    } catch (notifyError) {
      logger.error(
        { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        "GitLab review succeeded but notification publish failed",
      );
    }

    return { ok: true, message: "ok" };
  } catch (error) {
    clearDuplicateRecord(requestKey);
    const originalError = ensureError(error);
    const reason = originalError.message;
    const publicReason = getPublicErrorMessage(originalError);

    logger.error({ error: reason }, "GitLab AI review failed");
    const pushUrl =
      headers["x-push-url"] ??
      headers["x-qwx-robot-url"] ??
      readOptionalStringEnv("GITLAB_PUSH_URL") ??
      readOptionalStringEnv("NOTIFY_WEBHOOK_URL");
    try {
      await publishNotification({
        pushUrl,
        author: payload.user?.username ?? "unknown",
        repository:
          payload.project.path_with_namespace ?? payload.project.name ?? "unknown",
        sourceBranch: payload.object_attributes.source_branch ?? "-",
        targetBranch: payload.object_attributes.target_branch ?? "-",
        content: localizeText(
          {
            zh: `代码评审失败: ${publicReason}`,
            en: `Code review failed: ${publicReason}`,
          },
          locale,
        ),
        logger,
      });
    } catch (notifyError) {
      logger.error(
        { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        "Failed to publish GitLab failure notification",
      );
    }

    if (throwOnError) {
      throw originalError;
    }
    return { ok: false, message: reason };
  }
}

export function recordGitLabFeedbackSignal(params: {
  projectId: number;
  signal: string;
}): void {
  const key = `${params.projectId}`;
  recordFeedbackSignal({
    scope: GITLAB_FEEDBACK_SIGNAL_SCOPE,
    key,
    signal: params.signal,
    ttlMs: readNumberEnv(
      "GITLAB_FEEDBACK_SIGNAL_TTL_MS",
      DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
    ),
    maxSignals: MAX_FEEDBACK_SIGNALS,
    maxEntries: MAX_FEEDBACK_CACHE_ENTRIES,
  });
}

async function handleGitLabNoteWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const payload = params.payload as GitLabNoteWebhookBody;
  const noteableType = String(
    payload.object_attributes.noteable_type ?? "",
  ).toLowerCase();
  if (noteableType !== "mergerequest") {
    return { ok: true, message: "ignored note event (not merge request note)" };
  }

  const noteAction = String(payload.object_attributes.action ?? "create").toLowerCase();
  if (noteAction !== "create") {
    return { ok: true, message: `ignored note action=${noteAction}` };
  }

  const body =
    typeof payload.object_attributes.note === "string"
      ? payload.object_attributes.note.trim()
      : "";
  const locale = resolveUiLocale();
  if (!body) {
    return { ok: true, message: "empty note body" };
  }
  if (isGitLabBotUserName(payload.user?.username)) {
    return { ok: true, message: "ignored note from bot user" };
  }

  const mergePayload = buildMergeRequestPayloadFromNote(payload);
  const gitlabToken = requireGitLabToken(params.headers);
  const target = buildGitLabCommentTargetFromPayload({
    payload: mergePayload,
    baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
  });
  const commentUserName = payload.user?.username;
  const baseUrl = resolveGitLabBaseUrl(
    readOptionalStringEnv("GITLAB_BASE_URL"),
    payload.project.web_url,
  );
  const policy = await resolveGitLabReviewPolicy({
    baseUrl,
    projectId: payload.project.id,
    gitlabToken,
    ref: mergePayload.object_attributes.target_branch,
  });

  const hitRateLimit = async (
    command:
      | "feedback"
      | "describe"
      | "ask"
      | "checks"
      | "generate-tests"
      | "changelog"
      | "improve"
      | "add-doc"
      | "reflect"
      | "similar-issue"
      | "ai-review",
    message: string,
  ): Promise<{ ok: boolean; message: string } | undefined> => {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command,
        logger: params.logger,
      })
    ) {
      return { ok: true, message };
    }
    return undefined;
  };

  const registerCommand = <TParsed>(
    name: string,
    parse: () => TParsed | undefined,
    execute: (parsed: TParsed) => Promise<CommandDispatchResult>,
  ): CommandRegistration<unknown> => ({
    name,
    parse: parse as () => unknown | undefined,
    execute: execute as (parsed: unknown) => Promise<CommandDispatchResult>,
  });

  const commandRegistry: CommandRegistration<unknown>[] = [
    registerCommand(
      "feedback",
      () => {
        const parsed = parseFeedbackCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (feedbackCommand) => {
        const limited = await hitRateLimit("feedback", "feedback command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.feedbackCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "feedback",
              policyPath: ".mr-agent.yml -> review.feedbackCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "feedback command ignored by policy" };
        }

        const positive =
          feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
        const signalCore = positive
          ? "developer prefers high-confidence, actionable suggestions"
          : "developer prefers fewer low-value/noisy suggestions";
        const noteText = feedbackCommand.note ? `; note: ${feedbackCommand.note}` : "";
        recordGitLabFeedbackSignal({
          projectId: payload.project.id,
          signal: `MR !${mergePayload.object_attributes.iid} ${feedbackCommand.action}: ${signalCore}${noteText}`,
        });

        const context = await collectGitLabMergeRequestContext({
          payload: mergePayload,
          gitlabToken,
          baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
        });
        await publishGitLabGeneralComment(
          gitlabToken,
          context,
          buildFeedbackSignalRecordedMessage({
            action: feedbackCommand.action,
            locale,
          }),
        );
        return { ok: true, message: "feedback command recorded" };
      },
    ),
    registerCommand(
      "describe",
      () => {
        const parsed = parseDescribeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (describe) => {
        const limited = await hitRateLimit("describe", "describe command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.describeEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "describe",
              policyPath: ".mr-agent.yml -> review.describeEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "describe command ignored by policy" };
        }
        if (describe.apply && !policy.describeAllowApply) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandApplyDisabledByPolicyMessage({
              command: "describe",
              policyPath: ".mr-agent.yml -> review.describeAllowApply=false",
              locale,
            }),
          );
          return { ok: true, message: "describe apply ignored by policy" };
        }

        await runGitLabDescribe({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          trigger: "describe-command",
          apply: describe.apply && policy.describeAllowApply,
        });
        return { ok: true, message: "describe command triggered" };
      },
    ),
    registerCommand(
      "ask",
      () => {
        const parsed = parseAskCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (ask) => {
        const limited = await hitRateLimit("ask", "ask command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.askCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "ask",
              policyPath: ".mr-agent.yml -> review.askCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "ask command ignored by policy" };
        }

        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: ask.question,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          enableConversationContext: true,
          managedCommentKey: buildManagedCommandCommentKey("ask", ask.question),
        });
        return { ok: true, message: "ask command triggered" };
      },
    ),
    registerCommand(
      "checks",
      () => {
        const parsed = parseChecksCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (checksCommand) => {
        const limited = await hitRateLimit("checks", "checks command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.checksCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "checks",
              policyPath: ".mr-agent.yml -> review.checksCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "checks command ignored by policy" };
        }

        const checksQuestion = buildChecksQuestion("MR", checksCommand.question, locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: checksQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: true,
          commentTitle: "AI Checks",
          managedCommentKey: buildManagedCommandCommentKey(
            "checks",
            checksQuestion,
          ),
        });
        return { ok: true, message: "checks command triggered" };
      },
    ),
    registerCommand(
      "generate-tests",
      () => {
        const parsed = parseGenerateTestsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (generateTests) => {
        const limited = await hitRateLimit(
          "generate-tests",
          "generate_tests command rate limited",
        );
        if (limited) {
          return limited;
        }
        if (!policy.generateTestsCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "generate_tests",
              policyPath: ".mr-agent.yml -> review.generateTestsCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "generate_tests command ignored by policy" };
        }

        const generateTestsQuestion = buildGenerateTestsQuestion(
          "MR",
          generateTests.focus,
          locale,
        );
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: generateTestsQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Test Generator",
          displayQuestion: generateTests.focus
            ? `/generate_tests ${generateTests.focus}`
            : "/generate_tests",
          managedCommentKey: buildManagedCommandCommentKey(
            "generate-tests",
            generateTestsQuestion,
          ),
        });
        return { ok: true, message: "generate_tests command triggered" };
      },
    ),
    registerCommand(
      "changelog",
      () => {
        const parsed = parseChangelogCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (changelogCommand) => {
        const limited = await hitRateLimit("changelog", "changelog command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.changelogCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "changelog",
              policyPath: ".mr-agent.yml -> review.changelogCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "changelog command ignored by policy" };
        }
        if (changelogCommand.apply && !policy.changelogAllowApply) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandApplyDisabledByPolicyMessage({
              command: "changelog",
              policyPath: ".mr-agent.yml -> review.changelogAllowApply=false",
              locale,
            }),
          );
          return { ok: true, message: "changelog apply ignored by policy" };
        }

        await runGitLabChangelog({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          trigger: "comment-command",
          focus: changelogCommand.focus,
          apply: changelogCommand.apply && policy.changelogAllowApply,
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
        });
        return { ok: true, message: "changelog command triggered" };
      },
    ),
    registerCommand(
      "improve",
      () => {
        const parsed = parseImproveCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (improveCommand) => {
        const limited = await hitRateLimit("improve", "improve command rate limited");
        if (limited) {
          return limited;
        }

        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: "comment",
          trigger: "comment-command",
          customRules: [...policy.customRules, buildGitLabImproveRule(improveCommand.focus)],
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: policy.secretScanEnabled,
          secretScanCustomPatterns: policy.secretScanCustomPatterns,
          enableAutoLabel: false,
        });
        return { ok: true, message: "improve command triggered" };
      },
    ),
    registerCommand(
      "add-doc",
      () => {
        const parsed = parseAddDocCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (addDocCommand) => {
        const limited = await hitRateLimit("add-doc", "add_doc command rate limited");
        if (limited) {
          return limited;
        }

        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: "comment",
          trigger: "comment-command",
          customRules: [...policy.customRules, buildGitLabAddDocRule(addDocCommand.focus)],
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: false,
          enableAutoLabel: false,
        });
        return { ok: true, message: "add_doc command triggered" };
      },
    ),
    registerCommand(
      "reflect",
      () => {
        const parsed = parseReflectCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (reflectCommand) => {
        const limited = await hitRateLimit("reflect", "reflect command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.askCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildReflectDependsOnAskMessage({
              askPolicyPath: ".mr-agent.yml -> review.askCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "reflect command ignored by policy" };
        }

        const reflectQuestion = buildGitLabReflectQuestion(reflectCommand.request, locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: reflectQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Reflect",
          displayQuestion: reflectCommand.request
            ? `/reflect ${reflectCommand.request}`
            : "/reflect",
          managedCommentKey: buildManagedCommandCommentKey("reflect", reflectQuestion),
        });
        return { ok: true, message: "reflect command triggered" };
      },
    ),
    registerCommand(
      "similar-issue",
      () => {
        const parsed = parseSimilarIssueCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (similarIssueCommand) => {
        const limited = await hitRateLimit(
          "similar-issue",
          "similar_issue command rate limited",
        );
        if (limited) {
          return limited;
        }

        await runGitLabSimilarIssueCommand({
          payload: mergePayload,
          gitlabToken,
          query: similarIssueCommand.query,
          locale,
        });
        return { ok: true, message: "similar_issue command triggered" };
      },
    ),
    registerCommand(
      "ai-review",
      () => {
        const parsed = parseReviewCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (command) => {
        const limited = await hitRateLimit("ai-review", "note review rate limited");
        if (limited) {
          return limited;
        }

        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: command.mode,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: policy.secretScanEnabled,
          secretScanCustomPatterns: policy.secretScanCustomPatterns,
          enableAutoLabel: policy.autoLabelEnabled,
        });
        return { ok: true, message: "note review triggered" };
      },
    ),
  ];

  return dispatchCommandRegistrations(commandRegistry, {
    ok: true,
    message: "ignored note content",
  });
}

async function runGitLabAsk(params: GitLabAskRunParams): Promise<void> {
  return gitLabCommandWorkflows.runAsk(params);
}

async function runGitLabDescribe(params: GitLabDescribeRunParams): Promise<void> {
  return gitLabCommandWorkflows.runDescribe(params);
}

async function runGitLabChangelog(params: GitLabChangelogRunParams): Promise<void> {
  return gitLabCommandWorkflows.runChangelog(params);
}

async function collectGitLabMergeRequestContext(params: {
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
    ref: payload.object_attributes.target_branch,
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

async function publishGitLabLineComments(
  gitlabToken: string,
  collected: GitLabCollectedContext,
  result: PullRequestReviewResult,
  logger: LoggerLike,
  locale: UiLocale,
): Promise<void> {
  let failed = 0;
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

    let response: Response;
    try {
      response = await gitLabApiRequest({
        url: `${collected.baseUrl}/api/v4/projects/${encodeURIComponent(collected.projectId)}/merge_requests/${collected.mrId}/discussions`,
        token: gitlabToken,
        method: "POST",
        body: {
          body,
          position,
        },
      });
    } catch (error) {
      failed += 1;
      logger.error(
        {
          path: file.newPath,
          line,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to publish GitLab line comment",
      );
      continue;
    }

    if (!response.ok) {
      failed += 1;
      logger.error(
        {
          status: response.status,
          path: file.newPath,
          line,
        },
        "Failed to publish GitLab line comment",
      );
      continue;
    }
  }

  if (failed > 0) {
    logger.error({ failed }, "GitLab line comments published with failures");
  }
}

async function publishGitLabGeneralComment(
  gitlabToken: string,
  target: GitLabCommentTarget,
  body: string,
): Promise<void> {
  const response = await gitLabApiRequest({
    url: `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.mrId}/notes`,
    token: gitlabToken,
    method: "POST",
    body: { body },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to publish GitLab report comment (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}

function resolveGitLabBaseUrl(
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

function readBoolEnv(key: string): boolean {
  return parseBooleanEnv(readOptionalStringEnv(key));
}

function parseMode(modeRaw: string | undefined): ReviewMode | undefined {
  if (!modeRaw?.trim()) {
    return undefined;
  }

  const mode = modeRaw?.trim().toLowerCase();
  return mode === "comment" ? "comment" : "report";
}

async function loadGitLabRepositoryProcessGuidelines(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
}): Promise<ProcessGuideline[]> {
  const { baseUrl, projectId, gitlabToken, ref } = params;
  return loadProcessGuidelinesWithCache({
    scope: GITLAB_GUIDELINE_CACHE_SCOPE,
    cacheKey: `${baseUrl}:${projectId}@${ref}`,
    ttlMs: readNumberEnv(
      "GITLAB_GUIDELINE_CACHE_TTL_MS",
      DEFAULT_GUIDELINE_CACHE_TTL_MS,
    ),
    maxEntries: MAX_GUIDELINE_CACHE_ENTRIES,
    filePaths: GITLAB_GUIDELINE_FILE_PATHS,
    directories: GITLAB_GUIDELINE_DIRECTORIES,
    maxGuidelines: MAX_GUIDELINES,
    maxGuidelinesPerDirectory: MAX_GUIDELINES_PER_DIRECTORY,
    isTemplateFile: (path) => isProcessTemplateFile(path, "gitlab"),
    readFile: async (path) =>
      readGitLabGuidelineFile({
        baseUrl,
        projectId,
        gitlabToken,
        ref,
        path,
      }),
    listDirectory: async (path) =>
      listGitLabDirectory({
        baseUrl,
        projectId,
        gitlabToken,
        ref,
        path,
      }),
  });
}

async function readGitLabGuidelineFile(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<ProcessGuideline | undefined> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/files/${encodeURIComponent(params.path)}/raw?ref=${encodeURIComponent(params.ref)}`,
      token: params.gitlabToken,
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const content = (await response.text()).trim();
  if (!content) {
    return undefined;
  }

  return {
    path: params.path,
    content: content.slice(0, 4_000),
  };
}

async function listGitLabDirectory(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<Array<{ path: string; type: string }>> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/tree?path=${encodeURIComponent(params.path)}&ref=${encodeURIComponent(params.ref)}&per_page=20`,
      token: params.gitlabToken,
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as Array<{
    path?: string;
    type?: string;
  }>;

  return data
    .map((item) => ({
      path: item.path ?? "",
      type: item.type ?? "",
    }))
    .filter((item) => Boolean(item.path));
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

function requireGitLabToken(headers: Record<string, string | undefined>): string {
  const token = headers["x-gitlab-api-token"] ?? readOptionalStringEnv("GITLAB_TOKEN");
  if (!token) {
    throw new BadWebhookRequestError(
      "Missing GitLab API token (x-gitlab-api-token or GITLAB_TOKEN)",
    );
  }
  return token;
}

function mapGitLabActionToReviewEvent(
  actionRaw: string | undefined,
): "opened" | "edited" | "synchronize" | "merged" | "ignored" {
  const action = (actionRaw ?? "").toLowerCase();
  if (action === "open" || action === "reopen") {
    return "opened";
  }
  if (action === "update") {
    return "synchronize";
  }
  if (action === "merge") {
    return "merged";
  }
  if (action === "close" || action === "closed") {
    return "ignored";
  }
  return "edited";
}

function shouldRunGitLabAutoReview(
  policy: GitLabReviewPolicy,
  action: "opened" | "edited" | "synchronize" | "merged" | "ignored",
): boolean {
  if (!policy.enabled || action === "ignored") {
    return false;
  }
  if (action === "opened") {
    return policy.onOpened;
  }
  if (action === "edited") {
    return policy.onEdited;
  }
  if (action === "synchronize") {
    return policy.onSynchronize;
  }
  return true;
}

function getIncrementalHead(reviewMrKey: string): string | undefined {
  return loadIncrementalReviewHead({
    scope: GITLAB_INCREMENTAL_STATE_SCOPE,
    key: reviewMrKey,
  });
}

function rememberIncrementalHead(reviewMrKey: string, headSha: string): void {
  rememberIncrementalReviewHead({
    scope: GITLAB_INCREMENTAL_STATE_SCOPE,
    key: reviewMrKey,
    headSha,
    ttlMs: readNumberEnv(
      "GITLAB_INCREMENTAL_STATE_TTL_MS",
      DEFAULT_INCREMENTAL_STATE_TTL_MS,
    ),
    maxEntries: MAX_INCREMENTAL_STATE_ENTRIES,
  });
}

function loadGitLabFeedbackSignals(projectId: number): string[] {
  const key = `${projectId}`;
  return readMergedFeedbackSignals({
    scope: GITLAB_FEEDBACK_SIGNAL_SCOPE,
    scopedKey: key,
    maxSignals: MAX_FEEDBACK_SIGNALS,
  });
}

async function resolveGitLabReviewPolicy(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
}): Promise<GitLabReviewPolicy> {
  const cacheKey = `${params.baseUrl}:${params.projectId}@${params.ref}`;
  const now = nowMs();
  const cached = loadRuntimeStateValue<GitLabReviewPolicy>(
    GITLAB_POLICY_CACHE_SCOPE,
    cacheKey,
    now,
  );
  if (cached) {
    return cached;
  }

  const raw =
    (await tryLoadGitLabTextFile({
      baseUrl: params.baseUrl,
      projectId: params.projectId,
      gitlabToken: params.gitlabToken,
      ref: params.ref,
      path: ".mr-agent.yml",
    })) ??
    (await tryLoadGitLabTextFile({
      baseUrl: params.baseUrl,
      projectId: params.projectId,
      gitlabToken: params.gitlabToken,
      ref: params.ref,
      path: ".mr-agent.yaml",
    }));

  const resolved = raw
    ? parseGitLabReviewPolicyConfig(raw)
    : {
        ...defaultGitLabReviewPolicy,
        customRules: [...defaultGitLabReviewPolicy.customRules],
        secretScanCustomPatterns: [
          ...defaultGitLabReviewPolicy.secretScanCustomPatterns,
        ],
      };
  saveRuntimeStateValue({
    scope: GITLAB_POLICY_CACHE_SCOPE,
    key: cacheKey,
    value: resolved,
    expiresAt:
      now +
      readNumberEnv(
        "GITLAB_POLICY_CONFIG_CACHE_TTL_MS",
        DEFAULT_POLICY_CONFIG_CACHE_TTL_MS,
      ),
    maxEntries: 500,
  });

  return resolved;
}

export function parseGitLabReviewPolicyConfig(raw: string): GitLabReviewPolicy {
  const basePolicy: GitLabReviewPolicy = {
    ...defaultGitLabReviewPolicy,
    customRules: [...defaultGitLabReviewPolicy.customRules],
    secretScanCustomPatterns: [...defaultGitLabReviewPolicy.secretScanCustomPatterns],
  };
  let overrides: ReturnType<typeof parseReviewPolicyOverridesFromConfigText>;
  try {
    overrides = parseReviewPolicyOverridesFromConfigText(raw);
  } catch {
    return basePolicy;
  }

  return {
    ...basePolicy,
    enabled: overrides.enabled ?? basePolicy.enabled,
    mode: overrides.mode ?? basePolicy.mode,
    onOpened: overrides.onOpened ?? basePolicy.onOpened,
    onEdited: overrides.onEdited ?? basePolicy.onEdited,
    onSynchronize: overrides.onSynchronize ?? basePolicy.onSynchronize,
    describeEnabled: overrides.describeEnabled ?? basePolicy.describeEnabled,
    describeAllowApply: overrides.describeAllowApply ?? basePolicy.describeAllowApply,
    checksCommandEnabled: overrides.checksCommandEnabled ?? basePolicy.checksCommandEnabled,
    includeCiChecks: overrides.includeCiChecks ?? basePolicy.includeCiChecks,
    secretScanEnabled: overrides.secretScanEnabled ?? basePolicy.secretScanEnabled,
    secretScanCustomPatterns: normalizePolicyStringList(
      overrides.secretScanCustomPatterns,
      20,
    ),
    autoLabelEnabled: overrides.autoLabelEnabled ?? basePolicy.autoLabelEnabled,
    askCommandEnabled: overrides.askCommandEnabled ?? basePolicy.askCommandEnabled,
    generateTestsCommandEnabled:
      overrides.generateTestsCommandEnabled ?? basePolicy.generateTestsCommandEnabled,
    changelogCommandEnabled:
      overrides.changelogCommandEnabled ?? basePolicy.changelogCommandEnabled,
    changelogAllowApply: overrides.changelogAllowApply ?? basePolicy.changelogAllowApply,
    feedbackCommandEnabled:
      overrides.feedbackCommandEnabled ?? basePolicy.feedbackCommandEnabled,
    customRules: normalizePolicyStringList(overrides.customRules, 30),
  };
}

export function isGitLabBotUserName(userName: string | undefined): boolean {
  const normalized = (userName ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("_bot") ||
    normalized === "gitlab-bot" ||
    normalized === "gitlab_ci_bot"
  );
}

function normalizePolicyStringList(items: string[] | undefined, limit: number): string[] {
  if (!items || items.length === 0) {
    return [];
  }
  return items.map((item) => item.trim()).filter(Boolean).slice(0, limit);
}

async function tryLoadGitLabTextFile(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<string | undefined> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/files/${encodeURIComponent(params.path)}/raw?ref=${encodeURIComponent(params.ref)}`,
      token: params.gitlabToken,
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const text = (await response.text()).trim();
  return text || undefined;
}

export function buildMergeRequestPayloadFromNote(
  payload: GitLabNoteWebhookBody,
): GitLabMrWebhookBody {
  const iid =
    parsePositiveInteger(payload.merge_request?.iid) ??
    parsePositiveInteger(payload.object_attributes.noteable_iid);
  const sourceBranch =
    typeof payload.merge_request?.source_branch === "string"
      ? payload.merge_request.source_branch
      : "";
  const targetBranch =
    typeof payload.merge_request?.target_branch === "string"
      ? payload.merge_request.target_branch
      : "";
  const title =
    typeof payload.merge_request?.title === "string"
      ? payload.merge_request.title
      : "";
  const urlRaw = payload.merge_request?.url ?? payload.object_attributes.url;
  const url = typeof urlRaw === "string" ? urlRaw : "";
  if (!iid || !sourceBranch || !targetBranch || !title || !url) {
    throw new BadWebhookRequestError(
      "invalid gitlab note payload for merge request command",
    );
  }

  return {
    object_kind: "merge_request",
    event_type: payload.event_type,
    user: payload.user,
    project: payload.project,
    object_attributes: {
      action: "update",
      state: payload.merge_request?.state,
      iid,
      url,
      title,
      description: payload.merge_request?.description,
      source_branch: sourceBranch,
      target_branch: targetBranch,
    },
    merge_request: payload.merge_request,
  };
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

async function loadGitLabIncrementalChanges(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  incrementalBaseSha: string;
  headSha: string;
}): Promise<GitLabChange[]> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/compare?from=${encodeURIComponent(params.incrementalBaseSha)}&to=${encodeURIComponent(params.headSha)}`,
      token: params.gitlabToken,
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as GitLabCompareResponse;
  return Array.isArray(data.diffs) ? data.diffs : [];
}

async function loadGitLabHeadChecks(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
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
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/commits/${encodeURIComponent(params.headSha)}/statuses?per_page=100`,
      token: params.gitlabToken,
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as Array<{
    name?: string;
    status?: string;
    target_url?: string | null;
    description?: string | null;
  }>;
  if (!Array.isArray(data)) {
    return [];
  }

  return data.slice(0, 50).map((item) => {
    const status = item.status?.trim() || "unknown";
    return {
      name: item.name?.trim() || "unknown-check",
      status,
      conclusion: mapGitLabStatusToConclusion(status),
      detailsUrl: item.target_url ?? undefined,
      summary: item.description ?? undefined,
    };
  });
}

export function mapGitLabStatusToConclusion(statusRaw: string | undefined): string {
  const status = statusRaw?.trim().toLowerCase() ?? "";
  if (status === "success") {
    return "success";
  }
  if (status === "failed" || status === "failure") {
    return "failure";
  }
  if (status === "canceled" || status === "cancelled") {
    return "cancelled";
  }
  if (status === "skipped") {
    return "skipped";
  }
  if (status === "manual") {
    return "action_required";
  }
  if (
    status === "running" ||
    status === "pending" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  ) {
    return "pending";
  }
  return "unknown";
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
  logger: LoggerLike;
}): Promise<void> {
  if (params.labels.length === 0) {
    return;
  }

  try {
    const response = await gitLabApiRequest({
      url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/merge_requests/${params.collected.mrId}`,
      token: params.gitlabToken,
      method: "PUT",
      body: {
        add_labels: params.labels.join(","),
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitLab labels API failed (${response.status}): ${errorText.slice(0, 300)}`,
      );
    }
  } catch (error) {
    params.logger.error(
      {
        projectId: params.collected.projectId,
        mrId: params.collected.mrId,
        labels: params.labels,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to add GitLab merge request labels",
    );
  }
}

async function updateGitLabMergeRequestDescription(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  description: string;
}): Promise<void> {
  const response = await gitLabApiRequest({
    url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/merge_requests/${params.collected.mrId}`,
    token: params.gitlabToken,
    method: "PUT",
    body: {
      description: params.description,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to update GitLab MR description (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}

export function buildGitLabChangelogQuestion(
  focus: string | undefined,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildChangelogQuestion("MR", focus, locale);
}

export function buildGitLabDescribeQuestion(
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildDescribeQuestion("MR", locale);
}

function buildGitLabImproveRule(focus: string): string {
  return buildImproveRule(focus);
}

function buildGitLabAddDocRule(focus: string): string {
  return buildAddDocRule(focus);
}

function buildGitLabReflectQuestion(
  request: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildReflectQuestion("MR", request, locale);
}

async function runGitLabSimilarIssueCommand(params: {
  payload: GitLabMrWebhookBody;
  gitlabToken: string;
  query: string;
  locale: UiLocale;
}): Promise<void> {
  const target = buildGitLabCommentTargetFromPayload({
    payload: params.payload,
    baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
  });
  const query = resolveSimilarIssueQuery({
    query: params.query,
    title: params.payload.object_attributes.title,
    description: params.payload.object_attributes.description,
  });
  if (!query) {
    await publishGitLabGeneralComment(
      params.gitlabToken,
      target,
      buildSimilarIssueQueryMissingMessage(params.locale),
    );
    return;
  }

  const response = await gitLabApiRequest({
    url: `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/issues?state=all&order_by=updated_at&sort=desc&per_page=100`,
    token: params.gitlabToken,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to load GitLab issues (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const rawIssues = (await response.json()) as Array<{
    iid?: number;
    title?: string;
    description?: string;
    state?: string;
    web_url?: string;
  }>;
  const candidates = rawIssues
    .map((issue) => ({
      id: issue.iid ?? 0,
      title: issue.title ?? "",
      body: issue.description ?? "",
      url: issue.web_url ?? "",
      state: issue.state,
    }))
    .filter((issue) => issue.id > 0)
    .filter((issue) => issue.id !== params.payload.object_attributes.iid)
    .filter((issue) => Boolean(issue.url && issue.title));

  const matches = findSimilarIssues({
    query,
    candidates,
    limit: 5,
  });

  await publishGitLabGeneralComment(
    params.gitlabToken,
    target,
    buildSimilarIssueComment(query, matches, params.locale),
  );
}

async function applyGitLabChangelogUpdate(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const locale = resolveUiLocale();
  const path = readStringEnv("GITLAB_CHANGELOG_PATH", "CHANGELOG.md");
  let existing = "";
  let action: "create" | "update" = "create";

  try {
    const response = await gitLabApiRequest({
      url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(params.collected.sourceBranch)}`,
      token: params.gitlabToken,
    });
    if (response.ok) {
      existing = await response.text();
      action = "update";
    }
  } catch {
    // create new file fallback
  }

  const merged = mergeGitLabChangelogContent(
    existing,
    params.draft,
    `MR !${params.pullNumber}`,
  );
  const commitResponse = await gitLabApiRequest({
    url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/repository/commits`,
    token: params.gitlabToken,
    method: "POST",
    body: {
      branch: params.collected.sourceBranch,
      commit_message: `chore(changelog): update from MR !${params.pullNumber}`,
      actions: [
        {
          action,
          file_path: path,
          content: merged,
        },
      ],
    },
  });
  if (!commitResponse.ok) {
    const text = await commitResponse.text();
    throw new Error(
      `Failed to update GitLab CHANGELOG (${commitResponse.status}): ${text.slice(0, 300)}`,
    );
  }

  return {
    message: localizeText(
      {
        zh: `已写入 \`${path}\`（branch: \`${params.collected.sourceBranch}\`）。`,
        en: `Written to \`${path}\` (branch: \`${params.collected.sourceBranch}\`).`,
      },
      locale,
    ),
  };
}

export function mergeGitLabChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  return mergeSharedChangelogContent(currentContent, draft, title);
}
