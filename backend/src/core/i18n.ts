import { readOptionalStringEnv } from "./env.js";

export type UiLocale = "zh" | "en" | (string & {});

export function resolveUiLocale(
  rawLocale: string | undefined = readOptionalStringEnv("PR_AGENT_LOCALE"),
): UiLocale {
  const normalized = (rawLocale ?? "").trim().toLowerCase();
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh_cn" ||
    normalized === "zh-hans" ||
    normalized === "chinese"
  ) {
    return "zh";
  }

  if (
    normalized === "en" ||
    normalized === "en-us" ||
    normalized === "en_us" ||
    normalized === "en-gb" ||
    normalized === "english"
  ) {
    return "en";
  }

  if (/^[a-z]{2}(?:[-_][a-z0-9]+)*$/.test(normalized)) {
    return normalized.replace(/_/g, "-");
  }

  return "en";
}

export function detectTextLocale(text: string): UiLocale {
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  return cjkPattern.test(text) ? "zh" : "en";
}

export function localizeText(
  text: Record<string, string>,
  locale: UiLocale = resolveUiLocale(),
): string {
  if (!text || typeof text !== "object") {
    return "";
  }
  if (text[locale]) {
    return text[locale];
  }
  if (text.en) {
    return text.en;
  }
  if (text.zh) {
    return text.zh;
  }

  const firstValue = Object.values(text).find((item) => typeof item === "string");
  return firstValue ?? "";
}
