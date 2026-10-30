import type { ReviewMode } from "#review";
import { parseYamlBoolean as parseSharedYamlBoolean } from "../../../core/config/yaml.js";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";
import { loadRepositoryPolicyConfig } from "./config.js";

export { parseRepoPolicyConfig } from "./config.js";
export type {
  PolicyMode,
  PolicySectionConfig,
  PullRequestPolicySectionConfig,
  RepoPolicyConfig,
  ReviewPolicyConfig,
} from "./config.js";

export async function resolveGitHubPullRequestAutoReviewPolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
  action: "opened" | "edited" | "synchronize";
}): Promise<{
  enabled: boolean;
  mode: ReviewMode;
  customRules: string[];
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
}> {
  const { owner, repo } = params.context.repo();
  const { review } = await loadRepositoryPolicyConfig({
    context: params.context,
    owner,
    repo,
    ref: params.baseRef,
  });
  const actionEnabled = params.action === "opened"
    ? review.onOpened
    : params.action === "edited"
      ? review.onEdited
      : review.onSynchronize;
  return {
    enabled: review.enabled && actionEnabled,
    mode: review.mode,
    customRules: review.customRules,
    includeCiChecks: review.includeCiChecks,
    secretScanEnabled: review.secretScanEnabled,
    secretScanCustomPatterns: review.secretScanCustomPatterns,
    autoLabelEnabled: review.autoLabelEnabled,
  };
}

export async function resolveGitHubReviewBehaviorPolicy(params: {
  context: GitHubReviewContext;
  baseRef?: string;
}): Promise<{
  customRules: string[];
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  improveCommandEnabled: boolean;
  addDocCommandEnabled: boolean;
}> {
  const { owner, repo } = params.context.repo();
  const { review } = await loadRepositoryPolicyConfig({
    context: params.context,
    owner,
    repo,
    ref: params.baseRef,
  });
  return {
    customRules: review.customRules,
    includeCiChecks: review.includeCiChecks,
    secretScanEnabled: review.secretScanEnabled,
    secretScanCustomPatterns: review.secretScanCustomPatterns,
    autoLabelEnabled: review.autoLabelEnabled,
    improveCommandEnabled: review.improveCommandEnabled,
    addDocCommandEnabled: review.addDocCommandEnabled,
  };
}

export function parseYamlBoolean(value: string): boolean {
  return parseSharedYamlBoolean(value);
}
