import { localizeText, type UiLocale } from "@mr-agent/core";

interface ConfigDisplayPolicy {
  enabled: boolean;
  mode: string;
  onOpened: boolean;
  onEdited: boolean;
  onSynchronize: boolean;
  describeEnabled: boolean;
  describeAllowApply: boolean;
  askCommandEnabled: boolean;
  checksCommandEnabled: boolean;
  includeCiChecks: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  improveCommandEnabled: boolean;
  addDocCommandEnabled: boolean;
  implementCommandEnabled: boolean;
  customPromptCommandEnabled: boolean;
  helpDocsCommandEnabled: boolean;
  analyzeCommandEnabled: boolean;
  complianceCommandEnabled: boolean;
  similarCodeCommandEnabled: boolean;
  autoApproveCommandEnabled: boolean;
  scanRepoDiscussionsCommandEnabled: boolean;
  feedbackCommandEnabled: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  customRules: string[];
}

export function buildConfigFoundMessage(params: {
  config: { review: ConfigDisplayPolicy };
  locale: UiLocale;
}): string {
  const { config, locale } = params;
  const r = config.review;

  const header = localizeText(
    {
      zh: "### 当前仓库配置（`.mr-agent.yml`）",
      en: "### Current Repository Config (`.mr-agent.yml`)",
    },
    locale,
  );

  const lines = [
    `review.enabled: ${r.enabled}`,
    `review.mode: ${r.mode}`,
    `review.onOpened: ${r.onOpened}`,
    `review.onEdited: ${r.onEdited}`,
    `review.onSynchronize: ${r.onSynchronize}`,
    `review.describeEnabled: ${r.describeEnabled}`,
    `review.describeAllowApply: ${r.describeAllowApply}`,
    `review.askCommandEnabled: ${r.askCommandEnabled}`,
    `review.checksCommandEnabled: ${r.checksCommandEnabled}`,
    `review.includeCiChecks: ${r.includeCiChecks}`,
    `review.generateTestsCommandEnabled: ${r.generateTestsCommandEnabled}`,
    `review.changelogCommandEnabled: ${r.changelogCommandEnabled}`,
    `review.changelogAllowApply: ${r.changelogAllowApply}`,
    `review.improveCommandEnabled: ${r.improveCommandEnabled}`,
    `review.addDocCommandEnabled: ${r.addDocCommandEnabled}`,
    `review.implementCommandEnabled: ${r.implementCommandEnabled}`,
    `review.customPromptCommandEnabled: ${r.customPromptCommandEnabled}`,
    `review.helpDocsCommandEnabled: ${r.helpDocsCommandEnabled}`,
    `review.analyzeCommandEnabled: ${r.analyzeCommandEnabled}`,
    `review.complianceCommandEnabled: ${r.complianceCommandEnabled}`,
    `review.similarCodeCommandEnabled: ${r.similarCodeCommandEnabled}`,
    `review.autoApproveCommandEnabled: ${r.autoApproveCommandEnabled}`,
    `review.scanRepoDiscussionsCommandEnabled: ${r.scanRepoDiscussionsCommandEnabled}`,
    `review.feedbackCommandEnabled: ${r.feedbackCommandEnabled}`,
    `review.secretScanEnabled: ${r.secretScanEnabled}`,
    `review.autoLabelEnabled: ${r.autoLabelEnabled}`,
  ];

  if (r.secretScanCustomPatterns.length > 0) {
    lines.push(`review.secretScanCustomPatterns: [${r.secretScanCustomPatterns.length} pattern(s)]`);
  }
  if (r.customRules.length > 0) {
    lines.push(`review.customRules: [${r.customRules.length} rule(s)]`);
  }

  return [header, "", "```yaml", ...lines, "```"].join("\n");
}

export function buildConfigNotFoundMessage(locale: UiLocale): string {
  return localizeText(
    {
      zh: "当前仓库未找到 `.mr-agent.yml` 配置文件，使用默认配置。可参阅 README 了解可配置项。",
      en: "No `.mr-agent.yml` config file found in this repository. Using default settings. See README for available options.",
    },
    locale,
  );
}
