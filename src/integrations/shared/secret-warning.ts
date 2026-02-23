import { localizeText, resolveUiLocale, type UiLocale } from "#core";
import type { SecretFinding } from "./secret-scan.js";

export function buildSecretWarningComment(params: {
  platform: "github" | "gitlab";
  findings: SecretFinding[];
  locale?: UiLocale;
}): string {
  const locale = params.locale ?? resolveUiLocale();
  const rows = params.findings
    .slice(0, 10)
    .map((item) => {
      if (params.platform === "github") {
        return localizeText(
          {
            zh: `- [ ] \`${item.path}:${item.line}\` 检测到疑似 **${item.kind}**（样本：\`${item.sample}\`）`,
            en: `- [ ] \`${item.path}:${item.line}\` detected possible **${item.kind}** (sample: \`${item.sample}\`)`,
          },
          locale,
        );
      }
      return localizeText(
        {
          zh: `- \`${item.path}:${item.line}\` (${item.kind}) 片段: \`${item.sample}\``,
          en: `- \`${item.path}:${item.line}\` (${item.kind}) sample: \`${item.sample}\``,
        },
        locale,
      );
    })
    .join("\n");

  const introduction = localizeText(
    params.platform === "github"
      ? {
          zh: "请立即确认以下内容是否为真实凭据；若是，请立刻轮换并从历史中移除：",
          en: "Please verify whether these are real credentials; if yes, rotate and remove them from history immediately:",
        }
      : {
          zh: "以下变更行可能包含敏感信息，请尽快轮换并移除：",
          en: "The following changed lines may contain sensitive information. Please rotate and remove them as soon as possible:",
        },
    locale,
  );

  const recommendation = localizeText(
    params.platform === "github"
      ? {
          zh: "建议：启用 GitHub secret scanning 与 push protection 作为长期防线。",
          en: "Recommendation: enable GitHub secret scanning and push protection as a long-term safeguard.",
        }
      : {
          zh: "建议：启用 GitLab Secret Detection 作为长期防线。",
          en: "Recommendation: enable GitLab Secret Detection as a long-term safeguard.",
        },
    locale,
  );

  return [
    localizeText(
      {
        zh: "## 安全预警：疑似密钥泄露",
        en: "## Security Alert: Potential Secret Leak",
      },
      locale,
    ),
    "",
    introduction,
    rows || localizeText({ zh: "- (无)", en: "- (none)" }, locale),
    "",
    recommendation,
  ].join("\n");
}
