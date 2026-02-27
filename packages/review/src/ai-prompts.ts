import type { AskConversationTurn, UiLocale } from "@mr-agent/core";
import { resolveUiLocale } from "@mr-agent/core";
import { isProcessTemplateFile } from "./review-policy.js";
import type { PullRequestReviewInput } from "./review-types.js";

const REVIEW_SYSTEM_PROMPT_ZH = [
  "你是资深代码评审工程师。",
  "你需要对 PR/MR 进行严格代码评审，输出可执行问题列表。",
  "重点关注：逻辑错误、异常处理、安全风险、并发与幂等、性能、可维护性、测试缺失。",
  "除代码问题外，你还要评估 PR/MR 流程质量：PR 描述完整性、模板遵循度、协作流程合理性。",
  "如果变更涉及 .github 模板、workflow、CODEOWNERS、CONTRIBUTING 等流程文件，必须给出针对流程的建议和评价。",
  "reviews 数组中的行号必须是证据充分的真实行号；不确定就不要输出该问题。",
  "issueHeader 简短（建议 <= 12 字），issueContent 要有明确修复建议。",
  "若有明确且可直接替换的修复代码，可提供 suggestion（仅代码本体，不含解释和 markdown 标记）。",
  "若输入提供了 Team custom review rules，必须严格按规则检查并在结论中体现。",
  "若输入提供了 feedback signals，请在建议中体现这些历史反馈偏好，降低重复误报。",
  "若输入提供了 CI checks，必须结合失败检查给出针对性修复建议。",
  "输出必须是 JSON 对象，不要 markdown 代码块。",
].join("\n");

const REVIEW_SYSTEM_PROMPT_EN = [
  "You are a senior code review engineer.",
  "You must perform strict PR/MR review and output actionable findings.",
  "Focus on: logic defects, error handling, security, concurrency/idempotency, performance, maintainability, and missing tests.",
  "Besides code, evaluate PR/MR process quality: description completeness, template compliance, and collaboration flow.",
  "When changes touch workflow/process files (.github templates, workflow, CODEOWNERS, CONTRIBUTING), provide process-focused feedback.",
  "Line numbers in reviews must map to real diff evidence; skip uncertain findings.",
  "Keep issueHeader concise (recommended <= 12 words), and issueContent must contain a concrete fix direction.",
  "Only provide suggestion when a direct replacement snippet is clear (code only, no markdown wrappers).",
  "If Team custom review rules are provided, enforce them and reflect results in the conclusion.",
  "If feedback signals are provided, adapt recommendations to historical preferences and reduce repeated low-value findings.",
  "If CI checks are provided, include targeted fix advice for failed checks.",
  "Output must be a JSON object; do not use markdown code fences.",
].join("\n");

const ASK_SYSTEM_PROMPT_ZH = [
  "你是资深代码评审助手。",
  "用户会基于同一个 PR/MR 的 diff 提问，请给出准确、可执行、可验证的回答。",
  "回答要先给结论，再给证据（文件/行号/代码片段线索）。",
  "若输入提供了 feedback signals，请优先遵循这些历史反馈偏好。",
  "若信息不足以得出结论，请明确说不确定并指出还缺什么。",
  "输出必须是 JSON 对象，格式为 {\"answer\":\"...\"}，不要 markdown 代码块。",
].join("\n");

const ASK_SYSTEM_PROMPT_EN = [
  "You are a senior code review assistant.",
  "The user asks questions based on one PR/MR diff. Provide precise, actionable, and verifiable answers.",
  "Answer with conclusion first, then evidence (file/line/snippet clues).",
  "If feedback signals are provided, prioritize those historical preferences.",
  "If evidence is insufficient, clearly state uncertainty and what is missing.",
  "Output must be a JSON object in format {\"answer\":\"...\"} with no markdown code fences.",
].join("\n");

export function resolveReviewSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): string {
  return locale === "en" ? REVIEW_SYSTEM_PROMPT_EN : REVIEW_SYSTEM_PROMPT_ZH;
}

export function resolveAskSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): string {
  return locale === "en" ? ASK_SYSTEM_PROMPT_EN : ASK_SYSTEM_PROMPT_ZH;
}

export function buildUserPrompt(pullRequest: PullRequestReviewInput): string {
  const locale = resolveUiLocale();
  const outputRequirements =
    locale === "en"
      ? [
          "Output requirements:",
          "1) Output JSON object only;",
          "2) Each reviews item must include newPath/oldPath/type/startLine/endLine;",
          "3) line must map to real line numbers in the diff above;",
          "4) If no clear issues exist, reviews must be an empty array;",
          "5) If process/template files changed, actionItems must include at least one process-improvement suggestion.",
          "6) Fill suggestion only when direct replacement code is concrete and safe.",
          "7) If Team custom review rules are non-empty, results must explicitly cover those rules.",
          "8) If CI checks contain failures, actionItems must include at least one fix suggestion directly tied to those failures.",
          "9) If Feedback signals are non-empty, avoid recommendation patterns previously marked as low-value.",
        ]
      : [
          "输出要求:",
          "1) 仅输出 JSON 对象；",
          "2) reviews 每项都要填 newPath/oldPath/type/startLine/endLine；",
          "3) line 必须来自上面 diff 的真实行号；",
          "4) 若没有明确问题，reviews 为空数组；",
          "5) 若存在流程/模板改动，actionItems 至少包含 1 条流程改进建议。",
          "6) 仅当能给出可直接替换的修复代码时，才填写 suggestion 字段。",
          "7) 若 Team custom review rules 非空，必须覆盖这些规则的检查结果。",
          "8) 若存在失败 CI checks，actionItems 至少包含 1 条与失败检查直接相关的修复建议。",
          "9) 若 Feedback signals 非空，尽量避免重复历史上被判定为低价值的建议形态。",
        ];

  return [
    ...buildPromptSharedSections({
      pullRequest,
      maxDiffFiles: undefined,
      includeProcessFiles: true,
    }),
    ...outputRequirements,
  ].join("\n");
}

export function buildAskPrompt(
  pullRequest: PullRequestReviewInput,
  question: string,
  conversation: AskConversationTurn[] = [],
): string {
  return buildAskPromptWithOptions({
    pullRequest,
    question,
    conversation,
    maxDiffFiles: 40,
  });
}

export function buildAskPromptWithOptions(params: {
  pullRequest: PullRequestReviewInput;
  question: string;
  conversation: AskConversationTurn[];
  maxDiffFiles: number;
}): string {
  const { pullRequest, question, conversation, maxDiffFiles } = params;
  const locale = resolveUiLocale();
  const conversationText = formatAskConversationForPrompt(conversation);
  return [
    ...buildPromptSharedSections({
      pullRequest,
      maxDiffFiles,
      includeProcessFiles: false,
    }),
    "Previous Q&A context:",
    conversationText,
    "",
    locale === "en" ? "User question:" : "用户问题：",
    question.trim(),
    "",
    locale === "en"
      ? "Output requirement: return JSON object only: {\"answer\":\"...\"}."
      : "输出要求：仅返回 JSON 对象 {\"answer\":\"...\"}。",
  ].join("\n");
}

function buildPromptHeaderAndDescription(
  pullRequest: PullRequestReviewInput,
): string[] {
  return [
    `Platform: ${pullRequest.platform}`,
    `Repository: ${pullRequest.repository}`,
    `Number: #${pullRequest.number}`,
    `Title: ${pullRequest.title}`,
    `Author: ${pullRequest.author}`,
    `Base -> Head: ${pullRequest.baseBranch} -> ${pullRequest.headBranch}`,
    `Additions: ${pullRequest.additions}, Deletions: ${pullRequest.deletions}, Changed files: ${pullRequest.changedFilesCount}`,
    "",
    "Description:",
    pullRequest.body || "(empty)",
    "",
  ];
}

function formatDiffFilesForPrompt(
  files: PullRequestReviewInput["changedFiles"],
  maxFiles: number | undefined,
): string {
  const selectedFiles = maxFiles ? files.slice(0, maxFiles) : files;
  return selectedFiles
    .map((file, index) => {
      return [
        `### File ${index + 1}`,
        `new_path=${file.newPath}`,
        `old_path=${file.oldPath}`,
        `status=${file.status}, additions=${file.additions}, deletions=${file.deletions}`,
        "```diff",
        file.extendedDiff,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function formatGuidelinesForPrompt(
  processGuidelines: PullRequestReviewInput["processGuidelines"],
): string {
  if (!processGuidelines || processGuidelines.length === 0) {
    return "(none)";
  }

  return processGuidelines
    .map((item, index) => {
      return [
        `### Guideline ${index + 1}`,
        `path=${item.path}`,
        "```text",
        item.content.slice(0, 2_000),
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function formatStringListForPrompt(items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return "(none)";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function formatCiChecksForPrompt(
  ciChecks: PullRequestReviewInput["ciChecks"],
): string {
  if (!ciChecks || ciChecks.length === 0) {
    return "(none)";
  }

  return ciChecks
    .slice(0, 30)
    .map((item) => {
      const url = item.detailsUrl ? `, url=${item.detailsUrl}` : "";
      const summary = item.summary ? `\n  summary=${item.summary}` : "";
      return `- ${item.name} (status=${item.status}, conclusion=${item.conclusion}${url})${summary}`;
    })
    .join("\n");
}

function formatProcessFilesForPrompt(pullRequest: PullRequestReviewInput): string {
  const processFiles = pullRequest.changedFiles.filter(
    (file) =>
      isProcessTemplateFile(file.newPath, pullRequest.platform) ||
      isProcessTemplateFile(file.oldPath, pullRequest.platform),
  );
  if (processFiles.length === 0) {
    return "(none)";
  }

  return processFiles
    .map((file) => `- ${file.newPath} (status=${file.status})`)
    .join("\n");
}

function buildPromptSharedSections(params: {
  pullRequest: PullRequestReviewInput;
  maxDiffFiles?: number;
  includeProcessFiles: boolean;
}): string[] {
  const { pullRequest, maxDiffFiles, includeProcessFiles } = params;
  const sections: string[] = [...buildPromptHeaderAndDescription(pullRequest)];

  if (includeProcessFiles) {
    const processFilesText = formatProcessFilesForPrompt(pullRequest);
    sections.push("Process/template files in this change:");
    sections.push(processFilesText);
    sections.push("");
  }

  const guidelinesText = formatGuidelinesForPrompt(pullRequest.processGuidelines);
  const customRulesText = formatStringListForPrompt(pullRequest.customRules);
  const feedbackSignalsText = formatStringListForPrompt(
    pullRequest.feedbackSignals,
  );
  const ciChecksText = formatCiChecksForPrompt(pullRequest.ciChecks);
  const filesText = formatDiffFilesForPrompt(pullRequest.changedFiles, maxDiffFiles);

  sections.push("Repository process guidelines (.github templates/workflows/etc):");
  sections.push(guidelinesText);
  sections.push("");
  sections.push("Team custom review rules:");
  sections.push(customRulesText);
  sections.push("");
  sections.push("Feedback signals from developers:");
  sections.push(feedbackSignalsText);
  sections.push("");
  sections.push("CI checks on current head:");
  sections.push(ciChecksText);
  sections.push("");
  sections.push("Diff with line mapping:");
  sections.push(filesText || "(no textual patch available)");
  sections.push("");
  return sections;
}

function formatAskConversationForPrompt(conversation: AskConversationTurn[]): string {
  if (!conversation || conversation.length === 0) {
    return "(none)";
  }

  return conversation
    .slice(-6)
    .map((turn, index) => {
      const question = turn.question.trim();
      const answer = turn.answer.trim();
      return [
        `### Turn ${index + 1}`,
        `Q: ${question || "(empty)"}`,
        `A: ${answer || "(empty)"}`,
      ].join("\n");
    })
    .join("\n\n");
}
