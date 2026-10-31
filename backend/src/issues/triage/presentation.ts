import type { IssueTriageResult } from "./analysis.js";
import type { SimilarIssueMatch } from "../similarity/scorer.js";

export function renderIssueTriageComment(input: {
  result: IssueTriageResult;
  similar: readonly SimilarIssueMatch[];
  suggestedLabels: readonly string[];
  autoLabels: readonly string[];
  labelsComplete: boolean;
  revision: string;
  repository: string;
  locale: "zh" | "en";
}): string {
  const zh = input.locale === "zh";
  const similar = input.similar.slice(0, 5);
  const labels = input.suggestedLabels.map(inlineCode).join(", ") || (zh ? "无" : "None");
  const autoLabels = input.autoLabels.map(inlineCode).join(", ") || (zh ? "无" : "None");
  return [
    "## AI Issue Triage",
    "",
    `${zh ? "分析版本" : "Analyzed revision"}: \`${safeRevision(input.revision)}\``,
    "",
    `### ${zh ? "总结" : "Summary"}`,
    safeText(input.result.summary),
    "",
    `### ${zh ? "可行性" : "Feasibility"}`,
    `**${feasibilityLabel(input.result.feasibility.level, input.locale)}** — ${safeText(input.result.feasibility.reason)}`,
    "",
    `### ${zh ? "关键风险" : "Key Risks"}`,
    ...input.result.risks.map((risk) => `- ${safeText(risk)}`),
    "",
    `### ${zh ? "建议行动" : "Recommended Actions"}`,
    ...input.result.actions.map((action) => `- ${safeText(action)}`),
    "",
    `### ${zh ? "相似 Issue" : "Similar Issues"}`,
    ...(similar.length ? similar.map((item, index) =>
      `${index + 1}. [#${safeIssueId(item.id)}](${safeIssueUrl(input.repository, item.id)}) ${safeText(item.title)} ` +
      `(state=${safeInline(item.state ?? "unknown")}, score=${Number.isFinite(item.score) ? item.score : 0})`)
      : [`- ${zh ? "未发现高相关的历史 Issue。" : "No highly related historical issues were found."}`]),
    "",
    `### ${zh ? "建议标签" : "Suggested Labels"}`,
    labels,
    "",
    `${zh ? "已自动添加" : "Automatically added"}: ${autoLabels}`,
    ...(!input.labelsComplete ? ["", zh
      ? "> 仓库标签列表未完整读取，因此本次未自动添加标签；上方内容仅为建议。"
      : "> Repository labels could not be enumerated completely, so no labels were added automatically; the list above is advisory."] : []),
    "",
    zh
      ? "> 范围说明：此分析仅基于 Issue 文本和有限的历史 Issue 检索，未验证代码、运行测试或确认根因。"
      : "> Scope: this analysis uses only the Issue text and a bounded historical Issue search; it did not inspect code, run tests, or verify a root cause.",
  ].join("\n");
}

function safeText(value: string): string {
  return value.trim()
    .replace(/\s+/gu, " ")
    .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|])/gu, "\\$1")
    .replace(/@/gu, "@\u200b");
}
function safeInline(value: string): string { return safeText(String(value)).replace(/\s+/gu, " ").slice(0, 128); }
function inlineCode(value: string): string {
  return `\`${String(value).trim().replace(/\s+/gu, " ").replace(/`/gu, "").slice(0, 128)}\``;
}
function safeRevision(value: string): string { return value.replace(/[^a-f0-9]/giu, "").slice(0, 12) || "unknown"; }
function safeIssueId(value: string | number): string { return String(value).replace(/[^0-9]/gu, "").slice(0, 20) || "unknown"; }
function safeIssueUrl(repository: string, id: string | number): string {
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ? repository : "invalid/invalid";
  return `https://github.com/${repo}/issues/${safeIssueId(id)}`;
}
function feasibilityLabel(level: IssueTriageResult["feasibility"]["level"], locale: "zh" | "en"): string {
  if (locale === "en") return ({ high: "High", medium: "Medium", low: "Low", unknown: "Unknown" })[level];
  return ({ high: "高", medium: "中", low: "低", unknown: "未知" })[level];
}
