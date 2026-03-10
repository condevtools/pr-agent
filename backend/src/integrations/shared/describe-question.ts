import { resolveUiLocale, type UiLocale } from "#core";

export function buildDescribeQuestion(
  target: "PR" | "MR",
  locale: UiLocale = resolveUiLocale(),
): string {
  if (target === "PR") {
    if (locale === "en") {
      return [
        "Based on current PR changes, generate a Markdown draft that can be pasted directly into the PR description.",
        "Structure requirements: include the following headings in this exact order:",
        "## Summary",
        "## Change Overview",
        "## File Walkthrough",
        "## Test Plan",
        "## Related Issue",
        "Content requirements:",
        "1) Summarize the goal and major impact of this change;",
        "2) In Change Overview, include change size and branch information;",
        "3) In File Walkthrough, cover key files and important changes;",
        "4) In Test Plan, provide an executable verification checklist;",
        "5) In Related Issue, keep the placeholder `- Closes #`.",
        "Output requirement: return Markdown body only. No JSON, no code fences, no extra explanation.",
      ].join("\n");
    }

    return [
      "请基于当前 PR 的变更内容，生成一份可直接粘贴到 PR 描述区的 Markdown 草稿。",
      "结构要求：必须包含以下标题（按顺序）：",
      "## Summary",
      "## Change Overview",
      "## File Walkthrough",
      "## Test Plan",
      "## Related Issue",
      "内容要求：",
      "1) 总结本次变更的目标和主要影响；",
      "2) Change Overview 里给出变更规模和分支信息；",
      "3) File Walkthrough 覆盖关键文件和改动点；",
      "4) Test Plan 给出可执行的验证清单；",
      "5) Related Issue 保留 `- Closes #` 占位。",
      "输出要求：只输出 Markdown 本体，不要 JSON，不要代码块，不要额外解释。",
    ].join("\n");
  }

  if (locale === "en") {
    return [
      "Based on current MR changes, generate a Markdown draft that can be pasted directly into the MR description.",
      "Structure requirements: include the following headings in this exact order:",
      "## Summary",
      "## Change Overview",
      "## File Walkthrough",
      "## Test Plan",
      "Content requirements:",
      "1) Summarize the objective, impact scope, and major risk points;",
      "2) In Change Overview, include source/target branches and change size;",
      "3) In File Walkthrough, cover key files and change intent;",
      "4) In Test Plan, provide an executable verification checklist.",
      "Output requirement: return Markdown body only. No JSON, no code fences, no extra explanation.",
    ].join("\n");
  }

  return [
    "请基于当前 MR 的变更内容，生成一份可直接粘贴到 MR 描述区的 Markdown 草稿。",
    "结构要求：必须包含以下标题（按顺序）：",
    "## Summary",
    "## Change Overview",
    "## File Walkthrough",
    "## Test Plan",
    "内容要求：",
    "1) 总结本次变更目标、影响范围与风险点；",
    "2) Change Overview 里说明 source/target 分支和变更规模；",
    "3) File Walkthrough 覆盖关键文件与改动意图；",
    "4) Test Plan 给出可执行的验证清单。",
    "输出要求：只输出 Markdown 本体，不要 JSON，不要代码块，不要额外解释。",
  ].join("\n");
}
