import {
  clearDuplicateRecord,
  fnv1a32Hex,
  isDuplicateRequest,
  localizeText,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
  resolveUiLocale,
  type UiLocale,
} from "#core";
import {
  answerPullRequestQuestion,
  findSimilarIssues,
  type PullRequestReviewInput,
  type SimilarIssueMatch,
} from "#review";
import { resolveSimilarIssueQuery } from "../shared/similar-issue.js";
import { hasRepositoryPolicyConfigFile } from "./github-policy-config.js";
import {
  upsertGitHubManagedIssueComment,
  type GitHubIssueSummary,
  type GitHubReviewContext,
} from "./github-review.js";

const DEFAULT_ISSUE_AUTO_TRIAGE_DEDUPE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_ISSUE_AUTO_TRIAGE_SIMILAR_LIMIT = 5;
const MAX_ISSUE_LABELS = 8;
const ISSUE_AUTO_TRIAGE_COMMENT_KEY = "issue-ai-triage";

interface RunGitHubIssueAutoTriageWorkflowParams {
  context: GitHubReviewContext;
  issueNumber: number;
  title?: string;
  body?: string;
  defaultBranch?: string;
  author?: string;
}

export async function runGitHubIssueAutoTriageWorkflow(
  params: RunGitHubIssueAutoTriageWorkflowParams,
): Promise<void> {
  if (!isIssueAutoTriageEnabled()) {
    return;
  }

  const locale = resolveUiLocale();
  const { owner, repo } = params.context.repo();
  const ref = params.defaultBranch;
  const hasPolicyConfig = await hasRepositoryPolicyConfigFile({
    context: params.context,
    owner,
    repo,
    ref,
  });
  if (hasPolicyConfig) {
    return;
  }

  const title = params.title?.trim() ?? "";
  const body = params.body?.trim() ?? "";
  const dedupeKey = [
    "github-issue-auto-triage",
    `${owner}/${repo}#${params.issueNumber}`,
    fnv1a32Hex(`${title}\n${body}`),
  ].join(":");
  const dedupeTtlMs = Math.max(
    1_000,
    readNumberEnv(
      "GITHUB_ISSUE_AUTO_TRIAGE_DEDUPE_TTL_MS",
      DEFAULT_ISSUE_AUTO_TRIAGE_DEDUPE_TTL_MS,
    ),
  );
  if (isDuplicateRequest(dedupeKey, dedupeTtlMs)) {
    return;
  }

  try {
    const similar = await resolveIssueSimilarMatches({
      context: params.context,
      owner,
      repo,
      issueNumber: params.issueNumber,
      title,
      body,
    });
    const assessment = await resolveIssueAssessment({
      owner,
      repo,
      issueNumber: params.issueNumber,
      title,
      body,
      author: params.author,
      defaultBranch: params.defaultBranch,
      locale,
    });
    const labels = inferIssueLabels({
      title,
      body,
      similar,
    });

    await upsertGitHubManagedIssueComment({
      context: params.context,
      owner,
      repo,
      issueNumber: params.issueNumber,
      markerKey: ISSUE_AUTO_TRIAGE_COMMENT_KEY,
      body: buildIssueAutoTriageComment({
        assessment,
        labels,
        similar,
        locale,
      }),
    });
    await tryAddIssueLabels({
      context: params.context,
      owner,
      repo,
      issueNumber: params.issueNumber,
      labels,
    });
  } catch (error) {
    clearDuplicateRecord(dedupeKey);
    params.context.log.error(
      {
        owner,
        repo,
        issueNumber: params.issueNumber,
        error: error instanceof Error ? error.message : String(error),
      },
      "GitHub issue auto triage failed",
    );
  }
}

async function resolveIssueSimilarMatches(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
}): Promise<SimilarIssueMatch[]> {
  if (!params.context.octokit.issues.listForRepo) {
    return [];
  }

  const query = resolveSimilarIssueQuery({
    query: "",
    title: params.title,
    description: params.body,
  });
  if (!query) {
    return [];
  }

  const listed = await params.context.octokit.issues.listForRepo({
    owner: params.owner,
    repo: params.repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
    page: 1,
  });
  const candidates = listed.data
    .filter((item) => !item.pull_request)
    .filter((item) => Number(item.number) !== params.issueNumber)
    .map((item): GitHubIssueSummary => ({
      number: Number(item.number),
      title: item.title ?? "",
      body: item.body ?? "",
      state: item.state,
      html_url: item.html_url,
      pull_request: item.pull_request,
    }))
    .filter((item) => Boolean(item.title && item.html_url))
    .map((item) => ({
      id: item.number,
      title: item.title ?? "",
      body: item.body ?? "",
      state: item.state ?? undefined,
      url: item.html_url ?? "",
    }));

  const limit = Math.max(
    1,
    readNumberEnv(
      "GITHUB_ISSUE_AUTO_TRIAGE_SIMILAR_LIMIT",
      DEFAULT_ISSUE_AUTO_TRIAGE_SIMILAR_LIMIT,
    ),
  );
  return findSimilarIssues({
    query,
    candidates,
    limit,
  });
}

async function resolveIssueAssessment(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  author?: string;
  defaultBranch?: string;
  locale: UiLocale;
}): Promise<string> {
  if (parseBooleanEnv(readOptionalStringEnv("GITHUB_ISSUE_TRIAGE_DISABLE_AI"))) {
    return buildIssueAssessmentFallback(params.locale);
  }

  const issueAsReviewInput: PullRequestReviewInput = {
    platform: "github",
    repository: `${params.owner}/${params.repo}`,
    number: params.issueNumber,
    title: params.title || `Issue #${params.issueNumber}`,
    body: params.body,
    author: params.author?.trim() || "unknown-author",
    baseBranch: params.defaultBranch ?? "main",
    headBranch: params.defaultBranch ?? "main",
    additions: 0,
    deletions: 0,
    changedFilesCount: 0,
    changedFiles: [],
  };
  const question = localizeText(
    {
      zh: "请对这个 Issue 进行工程可行性评估。仅输出 Markdown，并严格包含三个小节：`### 可行性`（高/中/低 + 一句话理由）、`### 关键风险`（2-4 条）、`### 建议行动`（3-5 条可执行建议）。",
      en: "Please triage this issue for engineering feasibility. Output Markdown only with exactly three sections: `### Feasibility` (High/Medium/Low + one-sentence reason), `### Key Risks` (2-4 bullets), and `### Recommended Actions` (3-5 actionable bullets).",
    },
    params.locale,
  );

  try {
    const answer = (await answerPullRequestQuestion(issueAsReviewInput, question)).trim();
    return answer || buildIssueAssessmentFallback(params.locale);
  } catch {
    return buildIssueAssessmentFallback(params.locale);
  }
}

function buildIssueAssessmentFallback(locale: UiLocale): string {
  return localizeText(
    {
      zh: [
        "### 可行性",
        "中：从当前描述看可以推进，但仍需补充可复现证据与验收边界。",
        "",
        "### 关键风险",
        "- 根因未完全确认时可能出现“修复了表象、遗漏了触发路径”。",
        "- 缺少回归测试会导致同类问题在后续改动中再次出现。",
        "",
        "### 建议行动",
        "- 提供最小复现步骤/输入和预期输出。",
        "- 在修复前先记录根因与影响范围。",
        "- 同步补充回归测试并覆盖边界场景。",
      ].join("\n"),
      en: [
        "### Feasibility",
        "Medium: this looks actionable, but reproducible evidence and acceptance boundaries are still needed.",
        "",
        "### Key Risks",
        "- If the root cause is not fully validated, the fix may only address symptoms.",
        "- Without regression tests, the same class of issue can reappear in later changes.",
        "",
        "### Recommended Actions",
        "- Provide a minimal reproduction with expected vs. actual output.",
        "- Capture root cause and impact scope before implementation.",
        "- Add regression tests, including boundary cases.",
      ].join("\n"),
    },
    locale,
  );
}

function buildIssueAutoTriageComment(params: {
  assessment: string;
  labels: string[];
  similar: SimilarIssueMatch[];
  locale: UiLocale;
}): string {
  const similarLines =
    params.similar.length === 0
      ? [
          localizeText(
            {
              zh: "- 未检索到高相关的历史 Issue。",
              en: "- No highly related historical issues were found.",
            },
            params.locale,
          ),
        ]
      : params.similar.map((item, index) => {
          const state = (item.state ?? "unknown").toString();
          return `${index + 1}. [#${item.id}](${item.url}) ${item.title} (state=${state}, score=${item.score})`;
        });

  return [
    "## AI Issue Triage",
    "",
    localizeText(
      {
        zh: "检测到仓库未配置 `.pr-agent.yml/.pr-agent.yaml`，已使用默认策略自动给出分诊建议。",
        en: "No `.pr-agent.yml/.pr-agent.yaml` detected. Applied default triage policy automatically.",
      },
      params.locale,
    ),
    "",
    params.assessment.trim(),
    "",
    `### ${localizeText({ zh: "相似 Issue", en: "Similar Issues" }, params.locale)}`,
    ...similarLines,
    "",
    `### ${localizeText({ zh: "建议标签", en: "Suggested Labels" }, params.locale)}`,
    `\`${params.labels.join("`, `")}\``,
    "",
    localizeText(
      {
        zh: "可在仓库根目录新增 `.pr-agent.yml` 来覆盖默认行为。",
        en: "Add `.pr-agent.yml` at repository root to customize this behavior.",
      },
      params.locale,
    ),
  ].join("\n");
}

function inferIssueLabels(params: {
  title: string;
  body: string;
  similar: SimilarIssueMatch[];
}): string[] {
  const text = `${params.title}\n${params.body}`.toLowerCase();
  const labels = new Set<string>();

  if (/(bug|fix|error|exception|crash|fail|regression|报错|异常|崩溃|失败)/i.test(text)) {
    labels.add("bug");
  }
  if (/(feature|enhancement|proposal|request|建议|需求|优化)/i.test(text)) {
    labels.add("enhancement");
  }
  if (/(docs?|readme|documentation|文档)/i.test(text)) {
    labels.add("documentation");
  }
  if (/(security|xss|csrf|sql injection|token|secret|credential|漏洞|安全)/i.test(text)) {
    labels.add("security");
  }
  if (/(performance|latency|slow|memory leak|cpu|性能|卡顿)/i.test(text)) {
    labels.add("performance");
  }
  if (/(test|flaky|spec|coverage|测试)/i.test(text)) {
    labels.add("testing");
  }
  if (params.similar.length > 0) {
    labels.add("has-similar-issue");
  }
  labels.add("ai-triaged");

  return Array.from(labels).slice(0, MAX_ISSUE_LABELS);
}

async function tryAddIssueLabels(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  labels: string[];
}): Promise<void> {
  if (!isIssueAutoTriageAutoLabelEnabled()) {
    return;
  }
  if (!params.context.octokit.issues.addLabels || params.labels.length === 0) {
    return;
  }

  try {
    await params.context.octokit.issues.addLabels({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      labels: params.labels,
    });
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
        labels: params.labels,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to add issue auto-triage labels",
    );
  }
}

function isIssueAutoTriageEnabled(): boolean {
  return parseBooleanEnv(readOptionalStringEnv("GITHUB_ISSUE_AUTO_TRIAGE_ENABLED") ?? "true");
}

function isIssueAutoTriageAutoLabelEnabled(): boolean {
  return parseBooleanEnv(
    readOptionalStringEnv("GITHUB_ISSUE_AUTO_TRIAGE_AUTO_LABELS") ?? "true",
  );
}
