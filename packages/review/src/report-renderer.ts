import { getDiffSnippet } from "./patch.js";
import { findFileForReview } from "./review-utils.js";
import { encodePath, localizeText, resolveUiLocale, type UiLocale } from "@mr-agent/core";
import type {
  DiffFileContext,
  PullRequestReviewResult,
  ReviewIssue,
  ReviewMode,
  RiskLevel,
} from "./review-types.js";

export interface GitHubReportContext {
  platform: "github";
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
}

export interface GitLabReportContext {
  platform: "gitlab";
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
}

export type ReportContext = GitHubReportContext | GitLabReportContext;

const REVIEW_COMMAND_RE =
  /^\/ai-review(?:\s+(report|comment))?(?:\s+--mode=(report|comment))?\s*$/i;
const DESCRIBE_COMMAND_RE = /^\/(?:describe|ai-review\s+describe)(?:\s+--apply)?\s*$/i;
const ASK_COMMAND_RE = /^\/(?:ask|ai-review\s+ask)\s+([\s\S]+)$/i;
const CHECKS_COMMAND_RE = /^\/(?:checks|ai-review\s+checks)(?:\s+([\s\S]+))?\s*$/i;
const GENERATE_TESTS_COMMAND_RE =
  /^\/(?:generate[_-]?tests|ai-review\s+generate[_-]?tests)(?:\s+([\s\S]+))?\s*$/i;
const CHANGELOG_COMMAND_RE =
  /^\/(?:changelog|ai-review\s+changelog)(?:\s+([\s\S]+))?\s*$/i;
const IMPROVE_COMMAND_RE =
  /^\/(?:improve|ai-review\s+improve)(?:\s+([\s\S]+))?\s*$/i;
const ADD_DOC_COMMAND_RE =
  /^\/(?:add[_-]?doc|ai-review\s+add[_-]?doc)(?:\s+([\s\S]+))?\s*$/i;
const REFLECT_COMMAND_RE =
  /^\/(?:reflect|ai-review\s+reflect)(?:\s+([\s\S]+))?\s*$/i;
const SIMILAR_ISSUE_COMMAND_RE =
  /^\/(?:similar[_-]?issue|ai-review\s+similar[_-]?issue)(?:\s+([\s\S]+))?\s*$/i;
const FEEDBACK_COMMAND_RE =
  /^\/(?:feedback|ai-review\s+feedback)\s+(resolved|dismissed|up|down)(?:\s+([\s\S]+))?\s*$/i;
const HELP_COMMAND_RE = /^\/(?:help|ai-review\s+help)\s*$/i;
const CONFIG_COMMAND_RE = /^\/(?:config|ai-review\s+config)\s*$/i;
const IMPLEMENT_COMMAND_RE = /^\/(?:implement|ai-review\s+implement)\s*$/i;
const CUSTOM_PROMPT_COMMAND_RE =
  /^\/(?:custom[_-]?prompt|ai-review\s+custom[_-]?prompt)\s+([\s\S]+)$/i;
const HELP_DOCS_COMMAND_RE =
  /^\/(?:help[_-]?docs|ai-review\s+help[_-]?docs)\s+([\s\S]+)$/i;
const ANALYZE_COMMAND_RE = /^\/(?:analyze|ai-review\s+analyze)\s*$/i;
const COMPLIANCE_COMMAND_RE =
  /^\/(?:compliance|ai-review\s+compliance)(?:\s+([\s\S]+))?\s*$/i;
const IMPROVE_COMPONENT_COMMAND_RE =
  /^\/(?:improve[_-]?component|ai-review\s+improve[_-]?component)\s+([\s\S]+)$/i;
const GENERATE_LABELS_COMMAND_RE =
  /^\/(?:generate[_-]?labels|ai-review\s+generate[_-]?labels)\s*$/i;
const SIMILAR_CODE_COMMAND_RE =
  /^\/(?:similar[_-]?code|ai-review\s+similar[_-]?code)(?:\s+([\s\S]+))?\s*$/i;
const AUTO_APPROVE_COMMAND_RE = /^\/(?:auto[_-]?approve|ai-review\s+auto[_-]?approve)\s*$/i;
const SCAN_REPO_DISCUSSIONS_COMMAND_RE =
  /^\/(?:scan[_-]?repo[_-]?discussions|ai-review\s+scan[_-]?repo[_-]?discussions)\s*$/i;

export function parseReviewCommand(rawBody: string): {
  matched: boolean;
  mode: ReviewMode;
} {
  const body = rawBody.trim();
  const matched = body.match(REVIEW_COMMAND_RE);
  if (!matched) {
    return { matched: false, mode: "report" };
  }

  const fromPositional = matched[1]?.toLowerCase();
  const fromFlag = matched[2]?.toLowerCase();
  const modeRaw = fromFlag ?? fromPositional ?? "report";

  return {
    matched: true,
    mode: modeRaw === "comment" ? "comment" : "report",
  };
}

export function parseDescribeCommand(rawBody: string): {
  matched: boolean;
  apply: boolean;
} {
  const body = rawBody.trim();
  if (!DESCRIBE_COMMAND_RE.test(body)) {
    return { matched: false, apply: false };
  }

  return {
    matched: true,
    apply: /\s--apply(?:\s|$)/i.test(body),
  };
}

export function parseAskCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(ASK_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }

  const question = matched[1]?.trim() ?? "";
  if (!question) {
    return { matched: false, question: "" };
  }

  return { matched: true, question };
}

export function parseMentionCommand(
  rawBody: string,
  botLogin: string | string[],
): { matched: boolean; question: string } {
  const loginAliases = normalizeMentionLogins(botLogin);
  if (loginAliases.length === 0) {
    return { matched: false, question: "" };
  }
  const body = rawBody.trim();

  // Match @botLogin (case-insensitive) followed by the question text
  for (const login of loginAliases) {
    const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^@${escaped}\\s+([\\s\\S]+)$`, "i");
    const matched = body.match(re);
    if (!matched) {
      continue;
    }
    const question = matched[1]?.trim() ?? "";
    if (!question) {
      return { matched: false, question: "" };
    }
    return { matched: true, question };
  }

  return { matched: false, question: "" };
}

function normalizeMentionLogins(raw: string | string[]): string[] {
  const seeds = Array.isArray(raw) ? raw : [raw];
  const normalized = new Set<string>();

  for (const value of seeds) {
    const login = value.trim();
    if (!login) {
      continue;
    }
    normalized.add(login);

    if (login.toLowerCase().endsWith("[bot]")) {
      const withoutSuffix = login.slice(0, -5).trim();
      if (withoutSuffix) {
        normalized.add(withoutSuffix);
      }
      continue;
    }

    normalized.add(`${login}[bot]`);
  }

  return [...normalized];
}

export function parseChecksCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CHECKS_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }

  return {
    matched: true,
    question: matched[1]?.trim() ?? "",
  };
}

export function parseGenerateTestsCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(GENERATE_TESTS_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseImproveCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(IMPROVE_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseAddDocCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(ADD_DOC_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseReflectCommand(rawBody: string): {
  matched: boolean;
  request: string;
} {
  const body = rawBody.trim();
  const matched = body.match(REFLECT_COMMAND_RE);
  if (!matched) {
    return { matched: false, request: "" };
  }

  return {
    matched: true,
    request: matched[1]?.trim() ?? "",
  };
}

export function parseSimilarIssueCommand(rawBody: string): {
  matched: boolean;
  query: string;
} {
  const body = rawBody.trim();
  const matched = body.match(SIMILAR_ISSUE_COMMAND_RE);
  if (!matched) {
    return { matched: false, query: "" };
  }

  return {
    matched: true,
    query: matched[1]?.trim() ?? "",
  };
}

export function parseChangelogCommand(rawBody: string): {
  matched: boolean;
  apply: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CHANGELOG_COMMAND_RE);
  if (!matched) {
    return { matched: false, apply: false, focus: "" };
  }

  const args = (matched[1] ?? "").trim();
  if (!args) {
    return { matched: true, apply: false, focus: "" };
  }

  const focusParts: string[] = [];
  let apply = false;
  for (const token of args.split(/\s+/)) {
    if (!token) {
      continue;
    }
    if (/^--apply$/i.test(token)) {
      apply = true;
      continue;
    }
    focusParts.push(token);
  }

  return {
    matched: true,
    apply,
    focus: focusParts.join(" ").trim(),
  };
}

export function parseFeedbackCommand(rawBody: string): {
  matched: boolean;
  action: "resolved" | "dismissed" | "up" | "down";
  note: string;
} {
  const body = rawBody.trim();
  const matched = body.match(FEEDBACK_COMMAND_RE);
  if (!matched) {
    return { matched: false, action: "up", note: "" };
  }

  const actionRaw = (matched[1] ?? "").toLowerCase();
  const action: "resolved" | "dismissed" | "up" | "down" =
    actionRaw === "resolved" ||
    actionRaw === "dismissed" ||
    actionRaw === "down"
      ? actionRaw
      : "up";

  return {
    matched: true,
    action,
    note: matched[2]?.trim() ?? "",
  };
}

export function parseHelpCommand(rawBody: string): { matched: boolean } {
  return { matched: HELP_COMMAND_RE.test(rawBody.trim()) };
}

export function parseConfigCommand(rawBody: string): { matched: boolean } {
  return { matched: CONFIG_COMMAND_RE.test(rawBody.trim()) };
}

export function parseImplementCommand(rawBody: string): { matched: boolean } {
  return { matched: IMPLEMENT_COMMAND_RE.test(rawBody.trim()) };
}

export function parseCustomPromptCommand(rawBody: string): {
  matched: boolean;
  prompt: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CUSTOM_PROMPT_COMMAND_RE);
  if (!matched) {
    return { matched: false, prompt: "" };
  }
  const prompt = matched[1]?.trim() ?? "";
  if (!prompt) {
    return { matched: false, prompt: "" };
  }
  return { matched: true, prompt };
}

export function parseHelpDocsCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(HELP_DOCS_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }
  const question = matched[1]?.trim() ?? "";
  if (!question) {
    return { matched: false, question: "" };
  }
  return { matched: true, question };
}

export function parseAnalyzeCommand(rawBody: string): { matched: boolean } {
  return { matched: ANALYZE_COMMAND_RE.test(rawBody.trim()) };
}

export function parseComplianceCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(COMPLIANCE_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }
  return { matched: true, focus: matched[1]?.trim() ?? "" };
}

export function parseImproveComponentCommand(rawBody: string): {
  matched: boolean;
  component: string;
} {
  const body = rawBody.trim();
  const matched = body.match(IMPROVE_COMPONENT_COMMAND_RE);
  if (!matched) {
    return { matched: false, component: "" };
  }
  const component = matched[1]?.trim() ?? "";
  if (!component) {
    return { matched: false, component: "" };
  }
  return { matched: true, component };
}

export function parseGenerateLabelsCommand(rawBody: string): { matched: boolean } {
  return { matched: GENERATE_LABELS_COMMAND_RE.test(rawBody.trim()) };
}

export function parseSimilarCodeCommand(rawBody: string): {
  matched: boolean;
  query: string;
} {
  const body = rawBody.trim();
  const matched = body.match(SIMILAR_CODE_COMMAND_RE);
  if (!matched) {
    return { matched: false, query: "" };
  }
  return { matched: true, query: matched[1]?.trim() ?? "" };
}

export function parseAutoApproveCommand(rawBody: string): { matched: boolean } {
  return { matched: AUTO_APPROVE_COMMAND_RE.test(rawBody.trim()) };
}

export function parseScanRepoDiscussionsCommand(rawBody: string): { matched: boolean } {
  return { matched: SCAN_REPO_DISCUSSIONS_COMMAND_RE.test(rawBody.trim()) };
}

export function buildIssueCommentMarkdown(
  review: ReviewIssue,
  options?: { platform?: "github" | "gitlab"; locale?: UiLocale },
): string {
  const locale = options?.locale ?? resolveUiLocale();
  const issueHeader = escapeHtmlText(review.issueHeader);
  const issueContent = escapeHtmlText(review.issueContent);
  const content = [
    "<table>",
    `<thead><tr><td><strong>${localizeText(
      { zh: "问题", en: "Issue" },
      locale,
    )}</strong></td><td><strong>${localizeText(
      { zh: "描述", en: "Description" },
      locale,
    )}</strong></td></tr></thead>`,
    "<tbody>",
    `<tr><td>[${riskLabel(review.severity, locale)}] ${issueHeader}</td><td>${issueContent}</td></tr>`,
    "</tbody>",
    "</table>",
  ];

  const suggestion = buildSuggestionBlock(review, options?.platform);
  if (suggestion) {
    content.push("", suggestion);
  }

  return content.join("\n");
}

export function buildReportCommentMarkdown(
  result: PullRequestReviewResult,
  files: DiffFileContext[],
  context: ReportContext,
  options?: { locale?: UiLocale },
): string {
  const locale = options?.locale ?? resolveUiLocale();
  const positives =
    result.positives.length === 0
      ? `- ${localizeText({ zh: "无", en: "None" }, locale)}`
      : result.positives.map((item) => `- ${item}`).join("\n");

  const actionItems =
    result.actionItems.length === 0
      ? `- ${localizeText({ zh: "无", en: "None" }, locale)}`
      : result.actionItems.map((item) => `- ${item}`).join("\n");

  const issuesTable = renderIssuesTable(result, files, context, locale);
  const changeGraph = buildChangedFilesMermaid(files);

  return [
    localizeText(
      { zh: "## AI 代码评审报告", en: "## AI Code Review Report" },
      locale,
    ),
    "",
    `${localizeText({ zh: "风险等级", en: "Risk level" }, locale)}: **${riskLabel(
      result.riskLevel,
      locale,
    )}**`,
    "",
    localizeText({ zh: "### 总结", en: "### Summary" }, locale),
    result.summary,
    "",
    issuesTable,
    "",
    localizeText({ zh: "### 正向反馈", en: "### Positive Notes" }, locale),
    positives,
    "",
    localizeText({ zh: "### 建议后续动作", en: "### Recommended Next Actions" }, locale),
    actionItems,
    ...(changeGraph
      ? [
          "",
          localizeText(
            { zh: "### 变更结构图（Mermaid）", en: "### Change Structure Diagram (Mermaid)" },
            locale,
          ),
          "",
          changeGraph,
        ]
      : []),
  ].join("\n");
}

function renderIssuesTable(
  result: PullRequestReviewResult,
  files: DiffFileContext[],
  context: ReportContext,
  locale: UiLocale,
): string {
  if (result.reviews.length === 0) {
    return localizeText(
      {
        zh: "### 问题清单\n- 未发现明确问题。",
        en: "### Findings\n- No concrete issues found.",
      },
      locale,
    );
  }

  let rows = "";
  for (const review of result.reviews) {
    const file = findFileForReview(files, review);
    const location = renderIssueLocation(review, file, context, locale);
    const issueHeader = escapeHtmlText(review.issueHeader);
    const issueContent = escapeHtmlText(review.issueContent);

    rows += [
      "<tr>",
      `  <td>[${riskLabel(review.severity, locale)}] ${issueHeader}</td>`,
      `  <td>${location}</td>`,
      `  <td>${issueContent}</td>`,
      "</tr>",
      "",
    ].join("\n");
  }

  return [
    localizeText({ zh: "### 问题清单", en: "### Findings" }, locale),
    "<table>",
    `<thead><tr><td><strong>${localizeText(
      { zh: "问题", en: "Issue" },
      locale,
    )}</strong></td><td><strong>${localizeText(
      { zh: "代码位置", en: "Code Location" },
      locale,
    )}</strong></td><td><strong>${localizeText(
      { zh: "描述", en: "Description" },
      locale,
    )}</strong></td></tr></thead>`,
    "<tbody>",
    rows.trim(),
    "</tbody>",
    "</table>",
  ].join("\n");
}

function renderIssueLocation(
  review: ReviewIssue,
  file: DiffFileContext | undefined,
  context: ReportContext,
  locale: UiLocale,
): string {
  const path = review.type === "new" ? review.newPath : review.oldPath;
  const lineLabel = localizeText(
    {
      zh: `第${review.startLine}到${review.endLine}行`,
      en: `lines ${review.startLine}-${review.endLine}`,
    },
    locale,
  );
  const link = buildCodeLink(review, context);
  const snippet = file
    ? getDiffSnippet(file, review.type, review.startLine, review.endLine)
    : localizeText(
        { zh: "(无可用 diff 片段)", en: "(no diff snippet available)" },
        locale,
      );

  return [
    `[${path} ${lineLabel}](${link})`,
    "",
    "<details><summary>diff</summary>",
    "",
    "```diff",
    snippet,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function buildCodeLink(review: ReviewIssue, context: ReportContext): string {
  if (context.platform === "github") {
    const path = review.type === "new" ? review.newPath : review.oldPath;
    const sha = review.type === "new" ? context.headSha : context.baseSha;
    const encodedPath = encodePath(path);

    return `https://github.com/${context.owner}/${context.repo}/blob/${sha}/${encodedPath}#L${review.startLine}-L${review.endLine}`;
  }

  if (review.type === "new") {
    return `${context.webUrl}/-/blob/${context.sourceBranch}/${encodePath(review.newPath)}?ref_type=heads#L${review.startLine}-${review.endLine}`;
  }

  return `${context.webUrl}/-/blob/${context.targetBranch}/${encodePath(review.oldPath)}?ref_type=heads#L${review.startLine}-${review.endLine}`;
}

function riskLabel(level: RiskLevel, locale: UiLocale = resolveUiLocale()): string {
  if (level === "high") {
    return localizeText({ zh: "高", en: "High" }, locale);
  }

  if (level === "medium") {
    return localizeText({ zh: "中", en: "Medium" }, locale);
  }

  return localizeText({ zh: "低", en: "Low" }, locale);
}

function buildSuggestionBlock(
  review: ReviewIssue,
  _platform: "github" | "gitlab" | undefined,
): string | undefined {
  const suggestion = review.suggestion?.trim();
  if (!suggestion) {
    return undefined;
  }

  const sanitized = suggestion.replace(/```/g, "``\\`").trim();
  if (!sanitized) {
    return undefined;
  }

  if (review.type !== "new") {
    return [
      "```text",
      "Suggested fix (cannot be auto-applied on old/deleted lines):",
      sanitized,
      "```",
    ].join("\n");
  }

  return ["```suggestion", sanitized, "```"].join("\n");
}

function buildChangedFilesMermaid(files: DiffFileContext[]): string | undefined {
  const uniquePaths = Array.from(
    new Set(
      files
        .map((file) => file.newPath?.trim())
        .filter((path): path is string => Boolean(path)),
    ),
  ).slice(0, 24);
  if (uniquePaths.length === 0) {
    return undefined;
  }

  const lines: string[] = ["```mermaid", "flowchart TD", '  PR["PR"]'];
  const topNodeIds = new Map<string, string>();
  const rootEdges = new Set<string>();

  let index = 0;
  for (const path of uniquePaths) {
    const [firstSegment] = path.split("/", 1);
    const topLevel = firstSegment && firstSegment.length > 0 ? firstSegment : "(root)";
    let topNodeId = topNodeIds.get(topLevel);
    if (!topNodeId) {
      topNodeId = `T${topNodeIds.size + 1}`;
      topNodeIds.set(topLevel, topNodeId);
      lines.push(`  ${topNodeId}["${escapeMermaidLabel(topLevel)}"]`);
    }

    const rootEdge = `PR-->${topNodeId}`;
    if (!rootEdges.has(rootEdge)) {
      rootEdges.add(rootEdge);
      lines.push(`  PR --> ${topNodeId}`);
    }

    index += 1;
    const fileNodeId = `F${index}`;
    lines.push(`  ${fileNodeId}["${escapeMermaidLabel(path)}"]`);
    lines.push(`  ${topNodeId} --> ${fileNodeId}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
