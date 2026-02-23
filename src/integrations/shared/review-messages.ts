import { localizeText, type UiLocale } from "#core";

const reviewMessages = {
  reviewNoDiffSkipped: {
    zh: "`AI Review` 未发现可评审的文本改动，已跳过。",
    en: "`AI Review` found no textual changes to review, skipped.",
  },
  reviewNoDiff: {
    zh: "`AI Review` 未发现可评审的文本改动。",
    en: "`AI Review` found no textual changes to review.",
  },
  reviewRunning: {
    zh: "`AI Review` 正在分析这个 PR，请稍候...",
    en: "`AI Review` is analyzing this PR, please wait...",
  },
  reviewCommentModeTitle: {
    zh: "## AI 评审结果（Comment 模式）",
    en: "## AI Review Result (Comment Mode)",
  },
  reviewCommentModeHint: {
    zh: "如需汇总报告，请评论：`/ai-review report`",
    en: "For a consolidated report, comment: `/ai-review report`",
  },
  reviewCompleted: {
    zh: "`AI Review` 分析完成，结果已发布。",
    en: "`AI Review` analysis completed. Results have been published.",
  },
  reviewFailureTitle: {
    zh: "## AI Review 执行失败",
    en: "## AI Review Failed",
  },
  reviewFailureProgressHint: {
    zh: "`AI Review` 执行失败，请查看下方错误说明。",
    en: "`AI Review` failed. See the error details below.",
  },
  changelogSkippedRecently: {
    zh: "`AI Changelog` 最近 5 分钟内已执行过同类请求，本次已跳过。",
    en: "`AI Changelog` already handled a similar request in the last 5 minutes, skipped this request.",
  },
  changelogApplyHint: {
    zh: "如需自动写入仓库 CHANGELOG，请使用：`/changelog --apply`。",
    en: "To apply this draft to repository CHANGELOG, use: `/changelog --apply`.",
  },
  changelogUpdatedTitle: {
    zh: "## AI Changelog 已更新",
    en: "## AI Changelog Updated",
  },
  changelogFailedTitle: {
    zh: "## AI Changelog 执行失败",
    en: "## AI Changelog Failed",
  },
} as const;

export type ReviewMessageKey = keyof typeof reviewMessages;

export function reviewMessage(key: ReviewMessageKey, locale: UiLocale): string {
  return localizeText(reviewMessages[key], locale);
}
