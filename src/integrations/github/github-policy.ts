import {
  isDuplicateRequest,
  localizeText,
  readNumberEnv,
  readStringEnv,
  resolveUiLocale,
  type UiLocale,
} from "#core";
import type { ReviewMode } from "#review";
import {
  parseYamlBoolean as parseSharedYamlBoolean,
} from "../shared/yaml.js";
import type {
  GitHubCheckRunCreateParams,
  GitHubReviewContext,
} from "./github-review.js";
import {
  loadRepositoryPolicyConfig,
  type PolicyMode,
} from "./github-policy-config.js";
import {
  findMissingSections,
  loadIssueTemplateSections,
  loadPullRequestTemplateSections,
} from "./github-policy-templates.js";

// Re-export public types and functions from sub-modules
export { parseRepoPolicyConfig } from "./github-policy-config.js";
export type {
  PolicyMode,
  PolicySectionConfig,
  PullRequestPolicySectionConfig,
  RepoPolicyConfig,
  ReviewPolicyConfig,
} from "./github-policy-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLICY_COMMENT_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_POLICY_CHECK_NAME = "MR Agent Policy";

// ---------------------------------------------------------------------------
// Issue policy check
// ---------------------------------------------------------------------------

export async function runGitHubIssuePolicyCheck(params: {
  context: GitHubReviewContext;
  issueNumber: number;
  title?: string;
  body?: string;
  ref?: string;
}): Promise<void> {
  const { context, issueNumber } = params;
  const { owner, repo } = context.repo();
  const ref = params.ref;
  const locale = resolveUiLocale();

  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref,
  });
  if (!config.issue.enabled) {
    return;
  }

  const requiredSections =
    config.issue.requiredSections.length > 0
      ? config.issue.requiredSections
      : await loadIssueTemplateSections({ context, owner, repo, ref });
  const result = validateIssueBody({
    title: params.title ?? "",
    body: params.body ?? "",
    minBodyLength: config.issue.minBodyLength,
    requiredSections,
    locale,
  });
  if (result.missing.length === 0) {
    return;
  }

  await publishPolicyReminderComment({
    context,
    owner,
    repo,
    issueNumber,
    kind: "issue",
    missing: result.missing,
    mode: config.mode,
    locale,
  });
}

// ---------------------------------------------------------------------------
// Pull request policy check
// ---------------------------------------------------------------------------

export async function runGitHubPullRequestPolicyCheck(params: {
  context: GitHubReviewContext;
  pullNumber: number;
  title?: string;
  body?: string;
  headSha?: string;
  baseRef?: string;
  detailsUrl?: string;
}): Promise<void> {
  const { context, pullNumber } = params;
  const { owner, repo } = context.repo();
  const ref = params.baseRef;
  const locale = resolveUiLocale();

  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref,
  });
  if (!config.pullRequest.enabled) {
    return;
  }

  const requiredSections =
    config.pullRequest.requiredSections.length > 0
      ? config.pullRequest.requiredSections
      : await loadPullRequestTemplateSections({ context, owner, repo, ref });
  const result = validatePullRequestBody({
    title: params.title ?? "",
    body: params.body ?? "",
    minBodyLength: config.pullRequest.minBodyLength,
    requiredSections,
    requireLinkedIssue: config.pullRequest.requireLinkedIssue,
    locale,
  });

  if (result.missing.length > 0) {
    await publishPolicyReminderComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      kind: "pull_request",
      missing: result.missing,
      mode: config.mode,
      locale,
    });
  }

  if (config.mode === "enforce" && params.headSha) {
    await publishPolicyCheckRun({
      context,
      owner,
      repo,
      headSha: params.headSha,
      detailsUrl: params.detailsUrl,
      missing: result.missing,
      locale,
    });
  }
}

// ---------------------------------------------------------------------------
// Review policy resolution
// ---------------------------------------------------------------------------

export async function resolveGitHubPullRequestAutoReviewPolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
  action: "opened" | "edited" | "synchronize";
}): Promise<{
  enabled: boolean;
  mode: ReviewMode;
  customRules: string[];
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
}> {
  const { context } = params;
  const { owner, repo } = context.repo();
  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref: params.baseRef,
  });

  const review = config.review;
  if (!review.enabled) {
    return {
      enabled: false,
      mode: review.mode,
      customRules: review.customRules,
      includeCiChecks: review.includeCiChecks,
      secretScanEnabled: review.secretScanEnabled,
      secretScanCustomPatterns: review.secretScanCustomPatterns,
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  if (params.action === "opened") {
    return {
      enabled: review.onOpened,
      mode: review.mode,
      customRules: review.customRules,
      includeCiChecks: review.includeCiChecks,
      secretScanEnabled: review.secretScanEnabled,
      secretScanCustomPatterns: review.secretScanCustomPatterns,
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  if (params.action === "edited") {
    return {
      enabled: review.onEdited,
      mode: review.mode,
      customRules: review.customRules,
      includeCiChecks: review.includeCiChecks,
      secretScanEnabled: review.secretScanEnabled,
      secretScanCustomPatterns: review.secretScanCustomPatterns,
      autoLabelEnabled: review.autoLabelEnabled,
    };
  }

  return {
    enabled: review.onSynchronize,
    mode: review.mode,
    customRules: review.customRules,
    includeCiChecks: review.includeCiChecks,
    secretScanEnabled: review.secretScanEnabled,
    secretScanCustomPatterns: review.secretScanCustomPatterns,
    autoLabelEnabled: review.autoLabelEnabled,
  };
}

export async function resolveGitHubDescribePolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
}): Promise<{ enabled: boolean; allowApply: boolean }> {
  const { context } = params;
  const { owner, repo } = context.repo();
  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref: params.baseRef,
  });

  return {
    enabled: config.review.describeEnabled,
    allowApply: config.review.describeAllowApply,
  };
}

export async function resolveGitHubReviewBehaviorPolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
}): Promise<{
  describeEnabled: boolean;
  describeAllowApply: boolean;
  customRules: string[];
  includeCiChecks: boolean;
  checksCommandEnabled: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  askCommandEnabled: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  feedbackCommandEnabled: boolean;
  improveCommandEnabled: boolean;
  addDocCommandEnabled: boolean;
  implementCommandEnabled: boolean;
  customPromptCommandEnabled: boolean;
  helpDocsCommandEnabled: boolean;
  analyzeCommandEnabled: boolean;
  complianceCommandEnabled: boolean;
  similarCodeCommandEnabled: boolean;
  autoApproveCommandEnabled: boolean;
  scanRepoDiscussionsCommandEnabled: boolean;
}> {
  const { context } = params;
  const { owner, repo } = context.repo();
  const config = await loadRepositoryPolicyConfig({
    context,
    owner,
    repo,
    ref: params.baseRef,
  });

  return {
    describeEnabled: config.review.describeEnabled,
    describeAllowApply: config.review.describeAllowApply,
    customRules: config.review.customRules,
    includeCiChecks: config.review.includeCiChecks,
    checksCommandEnabled: config.review.checksCommandEnabled,
    secretScanEnabled: config.review.secretScanEnabled,
    secretScanCustomPatterns: config.review.secretScanCustomPatterns,
    autoLabelEnabled: config.review.autoLabelEnabled,
    askCommandEnabled: config.review.askCommandEnabled,
    generateTestsCommandEnabled: config.review.generateTestsCommandEnabled,
    changelogCommandEnabled: config.review.changelogCommandEnabled,
    changelogAllowApply: config.review.changelogAllowApply,
    feedbackCommandEnabled: config.review.feedbackCommandEnabled,
    improveCommandEnabled: config.review.improveCommandEnabled,
    addDocCommandEnabled: config.review.addDocCommandEnabled,
    implementCommandEnabled: config.review.implementCommandEnabled,
    customPromptCommandEnabled: config.review.customPromptCommandEnabled,
    helpDocsCommandEnabled: config.review.helpDocsCommandEnabled,
    analyzeCommandEnabled: config.review.analyzeCommandEnabled,
    complianceCommandEnabled: config.review.complianceCommandEnabled,
    similarCodeCommandEnabled: config.review.similarCodeCommandEnabled,
    autoApproveCommandEnabled: config.review.autoApproveCommandEnabled,
    scanRepoDiscussionsCommandEnabled: config.review.scanRepoDiscussionsCommandEnabled,
  };
}

// ---------------------------------------------------------------------------
// Body validation helpers
// ---------------------------------------------------------------------------

function validateIssueBody(params: {
  title: string;
  body: string;
  minBodyLength: number;
  requiredSections: string[];
  locale: UiLocale;
}): { missing: string[] } {
  const missing: string[] = [];
  if (!params.title.trim()) {
    missing.push(
      localizeText(
        { zh: "Issue 标题不能为空", en: "Issue title is required" },
        params.locale,
      ),
    );
  }

  const body = params.body.trim();
  if (!body) {
    missing.push(
      localizeText(
        { zh: "Issue 描述不能为空", en: "Issue body is required" },
        params.locale,
      ),
    );
    return { missing };
  }

  if (body.length < Math.max(1, params.minBodyLength)) {
    missing.push(
      localizeText(
        {
          zh: `Issue 描述至少 ${Math.max(1, params.minBodyLength)} 个字符`,
          en: `Issue body must be at least ${Math.max(1, params.minBodyLength)} characters`,
        },
        params.locale,
      ),
    );
  }

  missing.push(
    ...findMissingSections(body, params.requiredSections).map(
      (section) =>
        localizeText(
          {
            zh: `缺少或未填写模板段落: ${section}`,
            en: `Missing or empty template section: ${section}`,
          },
          params.locale,
        ),
    ),
  );

  return { missing };
}

function validatePullRequestBody(params: {
  title: string;
  body: string;
  minBodyLength: number;
  requiredSections: string[];
  requireLinkedIssue: boolean;
  locale: UiLocale;
}): { missing: string[] } {
  const missing: string[] = [];
  if (!params.title.trim()) {
    missing.push(
      localizeText(
        { zh: "PR 标题不能为空", en: "PR title is required" },
        params.locale,
      ),
    );
  }

  const body = params.body.trim();
  if (!body) {
    missing.push(
      localizeText(
        { zh: "PR 描述不能为空", en: "PR body is required" },
        params.locale,
      ),
    );
  } else {
    if (body.length < Math.max(1, params.minBodyLength)) {
      missing.push(
        localizeText(
          {
            zh: `PR 描述至少 ${Math.max(1, params.minBodyLength)} 个字符`,
            en: `PR body must be at least ${Math.max(1, params.minBodyLength)} characters`,
          },
          params.locale,
        ),
      );
    }
    if (params.requireLinkedIssue && !containsIssueReference(body)) {
      missing.push(
        localizeText(
          {
            zh: "PR 描述中需要关联 Issue（例如 #123）",
            en: "PR body must reference an issue (for example: #123)",
          },
          params.locale,
        ),
      );
    }
    missing.push(
      ...findMissingSections(body, params.requiredSections).map(
        (section) =>
          localizeText(
            {
              zh: `缺少或未填写模板段落: ${section}`,
              en: `Missing or empty template section: ${section}`,
            },
            params.locale,
          ),
      ),
    );
  }

  return { missing };
}

// ---------------------------------------------------------------------------
// Comment & check-run publishing
// ---------------------------------------------------------------------------

async function publishPolicyReminderComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  kind: "issue" | "pull_request";
  missing: string[];
  mode: PolicyMode;
  locale: UiLocale;
}): Promise<void> {
  const dedupeKey = [
    "github-policy-reminder",
    `${params.owner}/${params.repo}`,
    `${params.kind}#${params.issueNumber}`,
    params.mode,
    params.missing.join("|"),
  ].join(":");
  const dedupeTtl = readNumberEnv(
    "GITHUB_POLICY_COMMENT_DEDUPE_TTL_MS",
    DEFAULT_POLICY_COMMENT_DEDUPE_TTL_MS,
  );
  if (isDuplicateRequest(dedupeKey, dedupeTtl)) {
    return;
  }

  const title =
    params.kind === "issue"
      ? localizeText(
          { zh: "Issue 模板预检未通过", en: "Issue template pre-check failed" },
          params.locale,
        )
      : localizeText(
          { zh: "PR 流程预检未通过", en: "PR flow pre-check failed" },
          params.locale,
        );
  const modeHint =
    params.mode === "enforce"
      ? localizeText(
          {
            zh: "当前仓库模式：`enforce`（会写入失败检查）",
            en: "Repository mode: `enforce` (failed check run will be posted)",
          },
          params.locale,
        )
      : localizeText(
          {
            zh: "当前仓库模式：`remind`（仅提醒，不阻塞）",
            en: "Repository mode: `remind` (reminder only, non-blocking)",
          },
          params.locale,
        );
  const body = [
    localizeText(
      { zh: "## MR Agent 流程守卫", en: "## MR Agent Flow Guard" },
      params.locale,
    ),
    "",
    `**${title}**`,
    modeHint,
    "",
    localizeText(
      { zh: "请补充以下项：", en: "Please complete the following items:" },
      params.locale,
    ),
    ...params.missing.map((item) => `- [ ] ${item}`),
    "",
    localizeText(
      {
        zh: "可在仓库根目录 `.mr-agent.yml` 调整规则（`remind` / `enforce`）。",
        en: "You can tune these rules in `.mr-agent.yml` (`remind` / `enforce`).",
      },
      params.locale,
    ),
  ].join("\n");

  try {
    await params.context.octokit.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      body,
    });
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
        kind: params.kind,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to publish policy reminder comment",
    );
  }
}

async function publishPolicyCheckRun(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  headSha: string;
  detailsUrl?: string;
  missing: string[];
  locale: UiLocale;
}): Promise<void> {
  if (!params.context.octokit.checks?.create) {
    params.context.log.error(
      { owner: params.owner, repo: params.repo },
      "Policy mode is enforce but checks API is unavailable",
    );
    return;
  }

  const passed = params.missing.length === 0;
  const checkName = readStringEnv("GITHUB_POLICY_CHECK_NAME", DEFAULT_POLICY_CHECK_NAME);
  const output: NonNullable<GitHubCheckRunCreateParams["output"]> = {
    title: passed
      ? localizeText(
          { zh: "GitHub 流程预检通过", en: "GitHub Flow pre-check passed" },
          params.locale,
        )
      : localizeText(
          { zh: "GitHub 流程预检失败", en: "GitHub Flow pre-check failed" },
          params.locale,
        ),
    summary: passed
      ? localizeText(
          { zh: "所有必填流程项已满足。", en: "All required flow items are satisfied." },
          params.locale,
        )
      : [
          localizeText(
            { zh: "以下项未通过：", en: "The following items failed:" },
            params.locale,
          ),
          ...params.missing.map((item) => `- ${item}`),
        ].join("\n"),
  };
  if (params.detailsUrl) {
    output.text = localizeText(
      { zh: `详情: ${params.detailsUrl}`, en: `Details: ${params.detailsUrl}` },
      params.locale,
    );
  }

  const request: GitHubCheckRunCreateParams = {
    owner: params.owner,
    repo: params.repo,
    name: checkName,
    head_sha: params.headSha,
    details_url: params.detailsUrl,
    status: "completed",
    conclusion: passed ? "success" : "failure",
    completed_at: new Date().toISOString(),
    output,
  };

  try {
    await params.context.octokit.checks.create(request);
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        headSha: params.headSha,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to publish policy check run",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function containsIssueReference(body: string): boolean {
  return (
    /(^|\s)#\d+\b/.test(body) ||
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/i.test(body)
  );
}

export function parseYamlBoolean(value: string): boolean {
  return parseSharedYamlBoolean(value);
}
