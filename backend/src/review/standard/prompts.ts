import { resolveUiLocale, type UiLocale } from "#core";
import type { PullRequestReviewInput } from "../contracts.js";
import { buildPromptSharedSections } from "../context/prompt-context.js";
import {
  managedPromptReferences,
  renderManagedPrompt,
  type ManagedPromptReference,
} from "../../quality/prompts/index.js";

export const REVIEW_SYSTEM_PROMPT_ZH = [
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

export const REVIEW_SYSTEM_PROMPT_EN = [
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

export function resolveReviewSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): string {
  return resolveManagedReviewSystemPrompt(locale).text;
}

export function resolveManagedReviewSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): { text: string; reference?: ManagedPromptReference } {
  return locale === "en"
    ? renderManagedPrompt("review.single.system.en", {}, REVIEW_SYSTEM_PROMPT_EN)
    : renderManagedPrompt("review.single.system.zh", {}, REVIEW_SYSTEM_PROMPT_ZH);
}

export function buildUserPrompt(pullRequest: PullRequestReviewInput): string {
  return buildManagedUserPrompt(pullRequest).text;
}

export function buildManagedUserPrompt(pullRequest: PullRequestReviewInput): {
  text: string;
  promptReferences?: ManagedPromptReference[];
} {
  const locale = resolveUiLocale();
  const outputRequirementsFallback = locale === "en"
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
        ].join("\n")
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
        ].join("\n");
  const outputRequirements = renderManagedPrompt(
    locale === "en" ? "review.single.requirements.en" : "review.single.requirements.zh",
    {},
    outputRequirementsFallback,
  );

  return { text: [
    ...buildPromptSharedSections({
      pullRequest,
      maxDiffFiles: undefined,
      includeProcessFiles: true,
    }),
    outputRequirements.text,
  ].join("\n"), promptReferences: managedPromptReferences(outputRequirements) };
}
