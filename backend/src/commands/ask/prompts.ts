import { resolveUiLocale, type UiLocale } from "#core";
import type { PullRequestReviewInput } from "../../review/contracts.js";
import { buildPromptSharedSections } from "../../review/context/prompt-context.js";

export interface AskConversationTurn {
  question: string;
  answer: string;
}

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

export function resolveAskSystemPrompt(
  locale: UiLocale = resolveUiLocale(),
): string {
  return locale === "en" ? ASK_SYSTEM_PROMPT_EN : ASK_SYSTEM_PROMPT_ZH;
}

export function buildAskPrompt(
  pullRequest: PullRequestReviewInput,
  question: string,
  conversation: AskConversationTurn[] = [],
  locale?: UiLocale,
): string {
  return buildAskPromptWithOptions({
    pullRequest,
    question,
    conversation,
    maxDiffFiles: 40,
    locale,
  });
}

export function buildAskPromptWithOptions(params: {
  pullRequest: PullRequestReviewInput;
  question: string;
  conversation: AskConversationTurn[];
  maxDiffFiles: number;
  locale?: UiLocale;
}): string {
  const { pullRequest, question, conversation, maxDiffFiles, locale: localeOverride } = params;
  const locale = localeOverride ?? resolveUiLocale();
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
