import { loadRefetchableCacheValue, nowMs, readNumberEnv, saveRefetchableCacheValue } from "#core";
import type { ReviewMode } from "#review";
import { gitLabApiRequest } from "../../integrations/gitlab/api/http-client.js";
import { parseReviewPolicyOverridesFromConfigText } from "./parser.js";

const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;
const GITLAB_POLICY_CACHE_SCOPE = "gitlab-review-policy";

export interface GitLabReviewPolicy {
  enabled: boolean;
  mode: ReviewMode;
  onOpened: boolean;
  onEdited: boolean;
  onSynchronize: boolean;
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  secretScanCustomPatterns: string[];
  autoLabelEnabled: boolean;
  feedbackCommandEnabled: boolean;
  improveCommandEnabled: boolean;
  addDocCommandEnabled: boolean;
  customRules: string[];
}

const defaultGitLabReviewPolicy: GitLabReviewPolicy = {
  enabled: true,
  mode: "comment",
  onOpened: true,
  onEdited: false,
  onSynchronize: true,
  includeCiChecks: true,
  secretScanEnabled: true,
  secretScanCustomPatterns: [],
  autoLabelEnabled: true,
  feedbackCommandEnabled: true,
  improveCommandEnabled: true,
  addDocCommandEnabled: true,
  customRules: [],
};


export async function resolveGitLabReviewPolicy(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
}): Promise<{ policy: GitLabReviewPolicy; hasConfigFile: boolean }> {
  const cacheKey = `${params.baseUrl}:${params.projectId}@${params.ref}`;
  const now = nowMs();
  const cached = loadRefetchableCacheValue<{ policy: GitLabReviewPolicy; hasConfigFile: boolean }>(
    GITLAB_POLICY_CACHE_SCOPE,
    cacheKey,
    now,
  );
  if (cached) {
    return cached;
  }

  const raw =
    (await tryLoadGitLabTextFile({
      baseUrl: params.baseUrl,
      projectId: params.projectId,
      gitlabToken: params.gitlabToken,
      ref: params.ref,
      path: ".pr-agent.yml",
    })) ??
    (await tryLoadGitLabTextFile({
      baseUrl: params.baseUrl,
      projectId: params.projectId,
      gitlabToken: params.gitlabToken,
      ref: params.ref,
      path: ".pr-agent.yaml",
    }));

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
  saveRefetchableCacheValue({
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
    includeCiChecks: overrides.includeCiChecks ?? basePolicy.includeCiChecks,
    secretScanEnabled: overrides.secretScanEnabled ?? basePolicy.secretScanEnabled,
    secretScanCustomPatterns: normalizePolicyStringList(
      overrides.secretScanCustomPatterns,
      20,
    ),
    autoLabelEnabled: overrides.autoLabelEnabled ?? basePolicy.autoLabelEnabled,
    feedbackCommandEnabled:
      overrides.feedbackCommandEnabled ?? basePolicy.feedbackCommandEnabled,
    improveCommandEnabled:
      overrides.improveCommandEnabled ?? basePolicy.improveCommandEnabled,
    addDocCommandEnabled:
      overrides.addDocCommandEnabled ?? basePolicy.addDocCommandEnabled,
    customRules: normalizePolicyStringList(overrides.customRules, 30),
  };
}


function normalizePolicyStringList(items: string[] | undefined, limit: number): string[] {
  if (!items || items.length === 0) {
    return [];
  }
  return items.map((item) => item.trim()).filter(Boolean).slice(0, limit);
}

async function tryLoadGitLabTextFile(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<string | undefined> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/files/${encodeURIComponent(params.path)}/raw?ref=${encodeURIComponent(params.ref)}`,
      token: params.gitlabToken,
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const text = (await response.text()).trim();
  return text || undefined;
}
