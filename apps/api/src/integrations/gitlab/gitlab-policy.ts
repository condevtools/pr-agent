/**
 * Review policy resolution and parsing for GitLab.
 */

import {
  loadRuntimeStateValueAsync,
  nowMs,
  readNumberEnv,
  saveRuntimeStateValueAsync,
} from "@mr-agent/core";
import { parseReviewPolicyOverridesFromConfigText } from "@mr-agent/shared/review-policy-parser.js";
import type { ReviewMode } from "@mr-agent/review";

export interface GitLabReviewPolicy {
  enabled: boolean;
  mode: ReviewMode;
  onOpened: boolean;
  onEdited: boolean;
  onSynchronize: boolean;
  describeEnabled: boolean;
  describeAllowApply: boolean;
  checksCommandEnabled: boolean;
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  askCommandEnabled: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  feedbackCommandEnabled: boolean;
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
  customRules: string[];
}

export const defaultGitLabReviewPolicy: GitLabReviewPolicy = {
  enabled: true,
  mode: "comment",
  onOpened: true,
  onEdited: false,
  onSynchronize: true,
  describeEnabled: true,
  describeAllowApply: false,
  checksCommandEnabled: true,
  includeCiChecks: true,
  secretScanEnabled: true,
  secretScanCustomPatterns: [],
  autoLabelEnabled: true,
  askCommandEnabled: true,
  generateTestsCommandEnabled: true,
  changelogCommandEnabled: true,
  changelogAllowApply: false,
  feedbackCommandEnabled: true,
  improveCommandEnabled: true,
  addDocCommandEnabled: true,
  implementCommandEnabled: true,
  customPromptCommandEnabled: true,
  helpDocsCommandEnabled: true,
  analyzeCommandEnabled: true,
  complianceCommandEnabled: true,
  similarCodeCommandEnabled: true,
  autoApproveCommandEnabled: false,
  scanRepoDiscussionsCommandEnabled: true,
  customRules: [],
};

const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;
const GITLAB_POLICY_CACHE_SCOPE = "gitlab-review-policy";

export async function resolveGitLabReviewPolicy(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  tryLoadTextFile: (path: string) => Promise<string | undefined>;
}): Promise<{ policy: GitLabReviewPolicy; hasConfigFile: boolean }> {
  const cacheKey = `${params.baseUrl}:${params.projectId}@${params.ref}`;
  const now = nowMs();
  const cached = await loadRuntimeStateValueAsync<{
    policy: GitLabReviewPolicy;
    hasConfigFile: boolean;
  }>(GITLAB_POLICY_CACHE_SCOPE, cacheKey, now);
  if (cached) {
    return cached;
  }

  const raw =
    (await params.tryLoadTextFile(".mr-agent.yml")) ??
    (await params.tryLoadTextFile(".mr-agent.yaml"));

  const hasConfigFile = raw != null;
  const policy = raw
    ? parseGitLabReviewPolicyConfig(raw)
    : {
        ...defaultGitLabReviewPolicy,
        customRules: [...defaultGitLabReviewPolicy.customRules],
        secretScanCustomPatterns: [
          ...defaultGitLabReviewPolicy.secretScanCustomPatterns,
        ],
      };
  const resolved = { policy, hasConfigFile };
  await saveRuntimeStateValueAsync({
    scope: GITLAB_POLICY_CACHE_SCOPE,
    key: cacheKey,
    value: resolved,
    expiresAt:
      now +
      readNumberEnv(
        "GITLAB_POLICY_CONFIG_CACHE_TTL_MS",
        DEFAULT_POLICY_CONFIG_CACHE_TTL_MS,
      ),
    maxEntries: 500,
  });

  return resolved;
}

export function parseGitLabReviewPolicyConfig(raw: string): GitLabReviewPolicy {
  const basePolicy: GitLabReviewPolicy = {
    ...defaultGitLabReviewPolicy,
    customRules: [...defaultGitLabReviewPolicy.customRules],
    secretScanCustomPatterns: [...defaultGitLabReviewPolicy.secretScanCustomPatterns],
  };
  let overrides: ReturnType<typeof parseReviewPolicyOverridesFromConfigText>;
  try {
    overrides = parseReviewPolicyOverridesFromConfigText(raw);
  } catch {
    return basePolicy;
  }

  return {
    ...basePolicy,
    enabled: overrides.enabled ?? basePolicy.enabled,
    mode: overrides.mode ?? basePolicy.mode,
    onOpened: overrides.onOpened ?? basePolicy.onOpened,
    onEdited: overrides.onEdited ?? basePolicy.onEdited,
    onSynchronize: overrides.onSynchronize ?? basePolicy.onSynchronize,
    describeEnabled: overrides.describeEnabled ?? basePolicy.describeEnabled,
    describeAllowApply: overrides.describeAllowApply ?? basePolicy.describeAllowApply,
    checksCommandEnabled: overrides.checksCommandEnabled ?? basePolicy.checksCommandEnabled,
    includeCiChecks: overrides.includeCiChecks ?? basePolicy.includeCiChecks,
    secretScanEnabled: overrides.secretScanEnabled ?? basePolicy.secretScanEnabled,
    secretScanCustomPatterns: normalizePolicyStringList(
      overrides.secretScanCustomPatterns,
      20,
    ),
    autoLabelEnabled: overrides.autoLabelEnabled ?? basePolicy.autoLabelEnabled,
    askCommandEnabled: overrides.askCommandEnabled ?? basePolicy.askCommandEnabled,
    generateTestsCommandEnabled:
      overrides.generateTestsCommandEnabled ?? basePolicy.generateTestsCommandEnabled,
    changelogCommandEnabled:
      overrides.changelogCommandEnabled ?? basePolicy.changelogCommandEnabled,
    changelogAllowApply: overrides.changelogAllowApply ?? basePolicy.changelogAllowApply,
    feedbackCommandEnabled:
      overrides.feedbackCommandEnabled ?? basePolicy.feedbackCommandEnabled,
    improveCommandEnabled:
      overrides.improveCommandEnabled ?? basePolicy.improveCommandEnabled,
    addDocCommandEnabled:
      overrides.addDocCommandEnabled ?? basePolicy.addDocCommandEnabled,
    implementCommandEnabled:
      overrides.implementCommandEnabled ?? basePolicy.implementCommandEnabled,
    customPromptCommandEnabled:
      overrides.customPromptCommandEnabled ?? basePolicy.customPromptCommandEnabled,
    helpDocsCommandEnabled:
      overrides.helpDocsCommandEnabled ?? basePolicy.helpDocsCommandEnabled,
    analyzeCommandEnabled:
      overrides.analyzeCommandEnabled ?? basePolicy.analyzeCommandEnabled,
    complianceCommandEnabled:
      overrides.complianceCommandEnabled ?? basePolicy.complianceCommandEnabled,
    similarCodeCommandEnabled:
      overrides.similarCodeCommandEnabled ?? basePolicy.similarCodeCommandEnabled,
    autoApproveCommandEnabled:
      overrides.autoApproveCommandEnabled ?? basePolicy.autoApproveCommandEnabled,
    scanRepoDiscussionsCommandEnabled:
      overrides.scanRepoDiscussionsCommandEnabled ?? basePolicy.scanRepoDiscussionsCommandEnabled,
    customRules: normalizePolicyStringList(overrides.customRules, 30),
  };
}

export function shouldRunGitLabAutoReview(
  policy: GitLabReviewPolicy,
  action: "opened" | "edited" | "synchronize" | "merged" | "ignored",
): boolean {
  if (!policy.enabled || action === "ignored") return false;
  if (action === "opened") return policy.onOpened;
  if (action === "edited") return policy.onEdited;
  if (action === "synchronize") return policy.onSynchronize;
  return true;
}

function normalizePolicyStringList(items: string[] | undefined, limit: number): string[] {
  if (!items || items.length === 0) return [];
  return items.map((item) => item.trim()).filter(Boolean).slice(0, limit);
}
