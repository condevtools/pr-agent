import { localizeText, type UiLocale } from "@mr-agent/core";

export function buildCommandDisabledByPolicyMessage(params: {
  command: string;
  policyPath: string;
  locale: UiLocale;
}): string {
  const normalizedCommand = normalizeCommandName(params.command);
  return localizeText(
    {
      zh: `\`/${normalizedCommand}\` 在当前仓库已被禁用（${params.policyPath}）。`,
      en: `\`/${normalizedCommand}\` is disabled for this repository (${params.policyPath}).`,
    },
    params.locale,
  );
}

export function buildCommandApplyDisabledByPolicyMessage(params: {
  command: string;
  policyPath: string;
  locale: UiLocale;
}): string {
  const normalizedCommand = normalizeCommandName(params.command);
  return localizeText(
    {
      zh: `\`/${normalizedCommand} --apply\` 在当前仓库已被禁用（${params.policyPath}）。`,
      en: `\`/${normalizedCommand} --apply\` is disabled for this repository (${params.policyPath}).`,
    },
    params.locale,
  );
}

export function buildReflectDependsOnAskMessage(params: {
  askPolicyPath: string;
  locale: UiLocale;
}): string {
  return localizeText(
    {
      zh: `\`/reflect\` 依赖 \`/ask\` 能力，但当前仓库已禁用 ask（${params.askPolicyPath}）。`,
      en: `\`/reflect\` depends on \`/ask\`, but ask is disabled for this repository (${params.askPolicyPath}).`,
    },
    params.locale,
  );
}

export function buildFeedbackSignalRecordedMessage(params: {
  action: string;
  locale: UiLocale;
}): string {
  return localizeText(
    {
      zh: `已记录反馈信号：\`${params.action}\`。后续评审会参考该偏好。`,
      en: `Recorded feedback signal: \`${params.action}\`. Future reviews will use this preference.`,
    },
    params.locale,
  );
}

function normalizeCommandName(command: string): string {
  return command.trim().replace(/^\/+/, "");
}
