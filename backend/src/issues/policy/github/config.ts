import {
  getFreshCacheValue,
  nowMs,
  pruneExpiredCache,
  readNumberEnv,
  trimCache,
  type ExpiringCacheEntry,
} from "#core";
import type { ReviewMode } from "#review";
import { decodeGitHubFileContent } from "../../../integrations/github/repository/content.js";
import type { GitHubRepositoryContentFile } from "../../../integrations/github/api/types.js";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";
import { parseRepositoryPolicyOverridesFromConfigText } from "../../../review/policy/parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyMode = "remind" | "enforce";

export interface PolicySectionConfig {
  enabled: boolean;
  minBodyLength: number;
  requiredSections: string[];
}

export interface PullRequestPolicySectionConfig extends PolicySectionConfig {
  requireLinkedIssue: boolean;
}

export interface ReviewPolicyConfig {
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

export interface RepoPolicyConfig {
  mode: PolicyMode;
  issue: PolicySectionConfig;
  pullRequest: PullRequestPolicySectionConfig;
  review: ReviewPolicyConfig;
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;

export const CONFIG_PATH_CANDIDATES = [".pr-agent.yml", ".pr-agent.yaml"];

export const defaultPolicyConfig: RepoPolicyConfig = {
  mode: "remind",
  issue: {
    enabled: true,
    minBodyLength: 20,
    requiredSections: [],
  },
  pullRequest: {
    enabled: true,
    minBodyLength: 20,
    requiredSections: [],
    requireLinkedIssue: false,
  },
  review: {
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
  },
};

// ---------------------------------------------------------------------------

interface RepoPolicyConfigCacheEntry extends ExpiringCacheEntry<RepoPolicyConfig> {}
interface RepoPolicyConfigPresenceCacheEntry extends ExpiringCacheEntry<boolean> {}

const policyConfigCache = new Map<string, RepoPolicyConfigCacheEntry>();
const policyConfigPresenceCache = new Map<string, RepoPolicyConfigPresenceCacheEntry>();

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export async function loadRepositoryPolicyConfig(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<RepoPolicyConfig> {
  const { context, owner, repo, ref } = params;
  const cacheKey = `${owner}/${repo}@${ref ?? "__default__"}`;
  const now = nowMs();
  pruneExpiredCache(policyConfigCache, now);
  const cached = getFreshCacheValue(policyConfigCache, cacheKey, now);
  if (cached) {
    return cached;
  }

  let configFromRepo: RepoPolicyConfig | undefined;
  for (const path of CONFIG_PATH_CANDIDATES) {
    const raw = await tryLoadRepositoryTextFile({
      context,
      owner,
      repo,
      path,
      ref,
    });
    if (!raw) {
      continue;
    }

    try {
      const parsed = parseRepoPolicyConfig(raw);
      configFromRepo = normalizeRepoPolicyConfig(parsed);
      break;
    } catch (error) {
      context.log.error(
        {
          owner,
          repo,
          path,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to parse .pr-agent.yml, using defaults",
      );
      break;
    }
  }

  const resolved = configFromRepo ?? defaultPolicyConfig;
  policyConfigCache.set(cacheKey, {
    expiresAt:
      now +
      readNumberEnv(
        "GITHUB_POLICY_CONFIG_CACHE_TTL_MS",
        DEFAULT_POLICY_CONFIG_CACHE_TTL_MS,
      ),
    value: resolved,
  });
  trimCache(policyConfigCache, 500);

  return resolved;
}

export async function hasRepositoryPolicyConfigFile(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<boolean> {
  const { context, owner, repo, ref } = params;
  const cacheKey = `${owner}/${repo}@${ref ?? "__default__"}:presence`;
  const now = nowMs();
  pruneExpiredCache(policyConfigPresenceCache, now);
  const cached = getFreshCacheValue(policyConfigPresenceCache, cacheKey, now);
  if (typeof cached === "boolean") {
    return cached;
  }

  let found = false;
  for (const path of CONFIG_PATH_CANDIDATES) {
    const content = await tryLoadRepositoryContent({
      context,
      owner,
      repo,
      path,
      ref,
    });
    if (!content || Array.isArray(content)) {
      continue;
    }
    if ((content.type ?? "file") === "dir") {
      continue;
    }
    found = true;
    break;
  }

  policyConfigPresenceCache.set(cacheKey, {
    expiresAt:
      now +
      readNumberEnv(
        "GITHUB_POLICY_CONFIG_CACHE_TTL_MS",
        DEFAULT_POLICY_CONFIG_CACHE_TTL_MS,
      ),
    value: found,
  });
  trimCache(policyConfigPresenceCache, 500);

  return found;
}

// ---------------------------------------------------------------------------
// Repository file access helpers
// ---------------------------------------------------------------------------

export async function tryLoadRepositoryTextFile(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<string | undefined> {
  const response = await tryLoadRepositoryContent(params);
  if (!response || Array.isArray(response)) {
    return undefined;
  }

  if (response.type !== "file" || !response.content) {
    return undefined;
  }

  const text = decodeGitHubFileContent(response.content, response.encoding).trim();
  return text || undefined;
}

export async function tryLoadRepositoryContent(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<GitHubRepositoryContentFile | GitHubRepositoryContentFile[] | undefined> {
  try {
    const response = await params.context.octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      ref: params.ref,
    });
    return response.data;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Config parsing & normalization
// ---------------------------------------------------------------------------

export function parseRepoPolicyConfig(raw: string): Partial<RepoPolicyConfig> {
  return parseRepositoryPolicyOverridesFromConfigText(raw) as Partial<RepoPolicyConfig>;
}

function normalizeRepoPolicyConfig(raw: Partial<RepoPolicyConfig>): RepoPolicyConfig {
  const mode = raw.mode === "enforce" ? "enforce" : "remind";
  const issue = raw.issue ?? defaultPolicyConfig.issue;
  const pullRequest = raw.pullRequest ?? defaultPolicyConfig.pullRequest;
  const review = raw.review ?? defaultPolicyConfig.review;

  return {
    mode,
    issue: {
      enabled: issue.enabled !== false,
      minBodyLength: Math.max(1, issue.minBodyLength ?? defaultPolicyConfig.issue.minBodyLength),
      requiredSections: normalizeStringList(issue.requiredSections),
    },
    pullRequest: {
      enabled: pullRequest.enabled !== false,
      minBodyLength: Math.max(
        1,
        pullRequest.minBodyLength ?? defaultPolicyConfig.pullRequest.minBodyLength,
      ),
      requiredSections: normalizeStringList(pullRequest.requiredSections),
      requireLinkedIssue: Boolean(pullRequest.requireLinkedIssue),
    },
    review: {
      enabled: review.enabled !== false,
      mode: review.mode === "report" ? "report" : "comment",
      onOpened: review.onOpened !== false,
      onEdited: Boolean(review.onEdited),
      onSynchronize: review.onSynchronize !== false,
      includeCiChecks: review.includeCiChecks !== false,
      secretScanEnabled: review.secretScanEnabled !== false,
      secretScanCustomPatterns: normalizeStringList(review.secretScanCustomPatterns).slice(0, 20),
      autoLabelEnabled: review.autoLabelEnabled !== false,
      feedbackCommandEnabled: review.feedbackCommandEnabled !== false,
      improveCommandEnabled: review.improveCommandEnabled !== false,
      addDocCommandEnabled: review.addDocCommandEnabled !== false,
      customRules: normalizeStringList(review.customRules).slice(0, 30),
    },
  };
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
