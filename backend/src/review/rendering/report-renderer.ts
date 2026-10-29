import { getDiffSnippet } from "../../repository/diff/patch.js";
import { findFileForReview } from "../context/file-policy.js";
import { encodePath, localizeText, resolveUiLocale, type UiLocale } from "#core";
import type { DiffFileContext } from "../../repository/contracts.js";
import type { PullRequestReviewResult, ReviewIssue, RiskLevel } from "../contracts.js";

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
    if (result.coverage?.status === "partial") {
      return localizeText({ zh: "### 问题清单\n- 审查覆盖不完整；当前结果不足以认定没有问题。",
        en: "### Findings\n- Review coverage is incomplete; this result cannot establish that there are no issues." }, locale);
    }
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
