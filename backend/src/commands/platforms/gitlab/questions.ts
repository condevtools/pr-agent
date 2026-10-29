export function buildGitLabChangelogQuestion(
  focus: string | undefined,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildChangelogQuestion("MR", focus, locale);
}

export function buildGitLabDescribeQuestion(
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildDescribeQuestion("MR", locale);
}

export function buildGitLabReflectQuestion(
  request: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildReflectQuestion("MR", request, locale);
}

import { resolveUiLocale, type UiLocale } from "#core";
import { buildChangelogQuestion, buildReflectQuestion } from "../../builders/questions.js";
import { buildDescribeQuestion } from "../../builders/describe-question.js";
