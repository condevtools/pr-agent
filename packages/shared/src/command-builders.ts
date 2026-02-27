import { resolveUiLocale, type UiLocale } from "@mr-agent/core";

export type ReviewTargetLabel = "PR" | "MR";

export function buildImproveRule(focus: string): string {
  const normalizedFocus = focus.trim();
  if (normalizedFocus) {
    return `Focus mode: improvement suggestions only. Prioritize high-impact fixes related to: ${normalizedFocus}. Prefer concrete code suggestions when possible.`;
  }
  return "Focus mode: improvement suggestions only. Prioritize high-impact fixes and include concrete code suggestions when possible.";
}

export function buildAddDocRule(focus: string): string {
  const normalizedFocus = focus.trim();
  if (normalizedFocus) {
    return `Focus mode: docstrings/comments only. Improve developer-facing documentation for: ${normalizedFocus}. Output only doc-related findings with concrete snippets.`;
  }
  return "Focus mode: docstrings/comments only. Output only documentation-related findings with concrete doc snippet suggestions.";
}

export function buildReflectQuestion(
  target: ReviewTargetLabel,
  request: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  const normalizedRequest = request.trim();
  if (locale === "en") {
    if (normalizedRequest) {
      return `Based on current ${target} changes and the goal below, provide 3-5 clarification questions to help the author refine requirements and acceptance criteria. Goal: ${normalizedRequest}. Requirements: one sentence per question, sorted by priority, and include why each question matters.`;
    }
    return `Based on current ${target} changes, provide 3-5 clarification questions to help the author refine requirements and acceptance criteria. Requirements: one sentence per question, sorted by priority, and include why each question matters.`;
  }

  if (normalizedRequest) {
    return `请基于当前 ${target} 改动与以下目标，给出 3-5 个澄清问题，帮助作者明确需求与验收标准。目标：${normalizedRequest}。要求：每个问题一句话，按优先级排序，并附带“为什么要确认”。`;
  }
  return `请基于当前 ${target} 改动给出 3-5 个澄清问题，帮助作者明确需求与验收标准。要求：每个问题一句话，按优先级排序，并附带“为什么要确认”。`;
}

export function buildChangelogQuestion(
  target: ReviewTargetLabel,
  focus: string | undefined,
  locale: UiLocale,
): string {
  const normalizedFocus = focus?.trim() ?? "";
  if (locale === "en") {
    if (normalizedFocus) {
      return `Generate a Markdown changelog entry (Keep a Changelog style) for the current ${target} changes, with extra focus on: ${normalizedFocus}. Output only the changelog content body without extra explanation.`;
    }
    return `Generate a Markdown changelog entry (Keep a Changelog style) for the current ${target} changes. Output only the changelog content body without extra explanation.`;
  }

  if (normalizedFocus) {
    return `请根据当前 ${target} 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格），重点覆盖：${normalizedFocus}。仅输出 changelog 内容本体，不要额外说明。`;
  }

  return `请根据当前 ${target} 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格）。仅输出 changelog 内容本体，不要额外说明。`;
}

export function buildChecksQuestion(
  target: ReviewTargetLabel,
  extraQuestion: string,
  locale: UiLocale,
): string {
  const normalizedQuestion = extraQuestion.trim();
  if (locale === "en") {
    if (normalizedQuestion) {
      return `Please analyze current ${target} CI check results and provide fix suggestions. Extra question: ${normalizedQuestion}`;
    }
    return `Please analyze current ${target} CI check failures and provide executable fix steps (from high to low priority).`;
  }

  if (normalizedQuestion) {
    return `请结合当前 ${target} 的 CI 检查结果给出修复建议。额外问题：${normalizedQuestion}`;
  }
  return `请结合当前 ${target} 的 CI 检查结果，分析失败原因并给出可执行修复步骤（优先级从高到低）。`;
}

export function buildGenerateTestsQuestion(
  target: ReviewTargetLabel,
  focus: string,
  locale: UiLocale,
): string {
  const normalizedFocus = focus.trim();
  if (locale === "en") {
    if (normalizedFocus) {
      return `Based on current ${target} changes, generate an executable test plan and test code drafts, with extra focus on: ${normalizedFocus}. Output requirements: grouped by file path, include test name, preconditions, key assertions, and boundary/regression cases.`;
    }
    return `Based on current ${target} changes, generate an executable test plan and test code drafts. Output requirements: grouped by file path, include test name, preconditions, key assertions, and boundary/regression cases.`;
  }

  if (normalizedFocus) {
    return `请基于当前 ${target} 改动生成可执行测试方案和测试代码草案，重点覆盖：${normalizedFocus}。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。`;
  }
  return `请基于当前 ${target} 改动生成可执行测试方案和测试代码草案。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。`;
}

export function buildAnalyzeQuestion(
  target: ReviewTargetLabel,
  locale: UiLocale = resolveUiLocale(),
): string {
  if (locale === "en") {
    return `List every code component (function, class, module, type) changed in this ${target}. For each component provide: (1) name, (2) kind (function/class/module/type), (3) a one-sentence summary of what changed, (4) risk level (high/medium/low) with a brief justification. Sort the output from highest to lowest risk.`;
  }
  return `请列出当前 ${target} 中所有变更的代码组件（函数、类、模块、类型）。对每个组件给出：(1) 名称，(2) 类型（函数/类/模块/类型），(3) 一句话变更摘要，(4) 风险等级（高/中/低）并附简要理由。按风险从高到低排序输出。`;
}

export function buildComplianceQuestion(
  target: ReviewTargetLabel,
  focus: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  const normalizedFocus = focus.trim();
  if (locale === "en") {
    if (normalizedFocus) {
      return `Perform a compliance review of the current ${target} changes with focus on: ${normalizedFocus}. Check for: (1) security issues (hardcoded secrets, SQL injection, XSS, etc.), (2) code duplication or copied code blocks, (3) license/attribution concerns, (4) ticket/issue linkage. Provide a compliance summary with actionable recommendations.`;
    }
    return `Perform a compliance review of the current ${target} changes. Check for: (1) security issues (hardcoded secrets, SQL injection, XSS, etc.), (2) code duplication or copied code blocks, (3) license/attribution concerns, (4) ticket/issue linkage. Provide a compliance summary with actionable recommendations.`;
  }
  if (normalizedFocus) {
    return `请对当前 ${target} 改动进行合规审查，重点关注：${normalizedFocus}。检查项：(1) 安全问题（硬编码密钥、SQL 注入、XSS 等），(2) 代码重复或复制的代码块，(3) 许可证/归属问题，(4) 工单/Issue 关联。给出合规摘要及可操作建议。`;
  }
  return `请对当前 ${target} 改动进行合规审查。检查项：(1) 安全问题（硬编码密钥、SQL 注入、XSS 等），(2) 代码重复或复制的代码块，(3) 许可证/归属问题，(4) 工单/Issue 关联。给出合规摘要及可操作建议。`;
}

export function buildImproveComponentRule(component: string): string {
  const normalizedComponent = component.trim();
  if (!normalizedComponent) {
    return "Focus mode: improvement suggestions only. Prioritize high-impact fixes and include concrete code suggestions when possible.";
  }
  return `Focus mode: improvement suggestions only. Focus exclusively on the component: ${normalizedComponent}. Ignore all changes outside this component. Prioritize high-impact fixes and include concrete code suggestions when possible.`;
}

export function buildSimilarCodeQuestion(
  target: ReviewTargetLabel,
  query: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  const normalizedQuery = query.trim();
  if (locale === "en") {
    if (normalizedQuery) {
      return `Analyze the current ${target} diff and identify code patterns similar to: ${normalizedQuery}. For each match report: (1) file path and line range, (2) the pattern detected, (3) whether it could be deduplicated or extracted into a shared utility. Sort by similarity.`;
    }
    return `Analyze the current ${target} diff and identify any duplicate, repeated, or similar code patterns within the changed files. For each match report: (1) file path and line range, (2) the pattern detected, (3) whether it could be deduplicated or extracted into a shared utility. Sort by similarity.`;
  }
  if (normalizedQuery) {
    return `请分析当前 ${target} diff，识别与以下内容相似的代码模式：${normalizedQuery}。对每个匹配报告：(1) 文件路径和行范围，(2) 检测到的模式，(3) 是否可以去重或提取为共享工具方法。按相似度排序。`;
  }
  return `请分析当前 ${target} diff，识别变更文件中所有重复、相似的代码模式。对每个匹配报告：(1) 文件路径和行范围，(2) 检测到的模式，(3) 是否可以去重或提取为共享工具方法。按相似度排序。`;
}

export function buildAutoApproveQuestion(
  target: ReviewTargetLabel,
  locale: UiLocale = resolveUiLocale(),
): string {
  if (locale === "en") {
    return `Evaluate the overall risk of this ${target}. Consider: (1) scope of changes (number of files, lines changed), (2) complexity of logic changes, (3) potential for regressions, (4) security implications, (5) whether adequate tests are included. Output a JSON object with exactly two keys: "risk" (one of "none", "low", "medium", "high") and "reason" (a brief explanation). Output only the JSON, nothing else.`;
  }
  return `请评估当前 ${target} 的整体风险。考虑：(1) 变更范围（文件数、行数），(2) 逻辑变更复杂度，(3) 回归风险，(4) 安全影响，(5) 是否包含充分测试。输出一个 JSON 对象，仅含两个键："risk"（取值 "none"、"low"、"medium"、"high"）和 "reason"（简要说明）。仅输出 JSON，不要其他内容。`;
}

export function buildScanRepoDiscussionsQuestion(
  target: ReviewTargetLabel,
  discussionsSummary: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  if (locale === "en") {
    return `Below are review comments from recently merged ${target}s in this repository:\n\n${discussionsSummary}\n\nAnalyze these comments and extract recurring feedback patterns. Output a Markdown document titled "Best Practices" with: (1) a summary of the most common feedback themes, (2) concrete best practice recommendations derived from the feedback, (3) anti-patterns to avoid. Format as a ready-to-use best_practices.md file.`;
  }
  return `以下是本仓库最近已合并 ${target} 的评审评论：\n\n${discussionsSummary}\n\n请分析这些评论，提取反复出现的反馈模式。输出一个 Markdown 文档，标题为"最佳实践"，包含：(1) 最常见的反馈主题摘要，(2) 从反馈中提炼的具体最佳实践建议，(3) 应避免的反模式。格式为可直接使用的 best_practices.md 文件。`;
}

export function buildHelpDocsQuestion(
  target: ReviewTargetLabel,
  question: string,
  docsContent: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  if (locale === "en") {
    return `The user asks the following question about this project's documentation:\n\n**Question:** ${question}\n\n**Documentation content:**\n${docsContent}\n\nPlease answer the question based on the documentation content above. If the documentation does not contain enough information, say so and provide your best answer based on the ${target} context.`;
  }
  return `用户就本项目的文档提出了以下问题：\n\n**问题：** ${question}\n\n**文档内容：**\n${docsContent}\n\n请基于上述文档内容回答问题。如果文档信息不足，请说明并结合 ${target} 上下文给出最佳回答。`;
}
