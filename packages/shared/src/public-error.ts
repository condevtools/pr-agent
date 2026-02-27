import { localizeText, resolveUiLocale, type UiLocale } from "@mr-agent/core";

export function getPublicErrorMessage(
  error: unknown,
  locale: UiLocale = resolveUiLocale(),
): string {
  const message = error instanceof Error ? error.message : String(error);

  const allowList = [
    /^Missing\s+[A-Z0-9_]+/,
    /^Unsupported AI_PROVIDER/,
    /^Model returned empty/,
    /^Model response is not valid JSON/,
    /^Request timed out\.?/i,
  ];

  if (allowList.some((pattern) => pattern.test(message))) {
    return message;
  }

  return localizeText(
    {
      zh: "内部执行错误（详情请查看服务日志）",
      en: "Internal execution error (check service logs for details).",
    },
    locale,
  );
}
