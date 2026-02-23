import { resolveUiLocale, type UiLocale } from "#core";

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
