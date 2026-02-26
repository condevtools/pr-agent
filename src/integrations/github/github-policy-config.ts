import {
  getFreshCacheValue,
  nowMs,
  pruneExpiredCache,
  readNumberEnv,
  trimCache,
  type ExpiringCacheEntry,
} from "#core";
import type { ReviewMode } from "#review";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { decodeGitHubFileContent } from "./github-content.js";
import {
  parseYamlBooleanMaybe,
  stripYamlQuotes,
} from "../shared/yaml.js";
import type {
  GitHubRepositoryContentFile,
  GitHubReviewContext,
} from "./github-review.js";

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
  customRules: string[];
}

export interface RepoPolicyConfig {
  mode: PolicyMode;
  issue: PolicySectionConfig;
  pullRequest: PullRequestPolicySectionConfig;
  review: ReviewPolicyConfig;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const repoPolicyIssueSchema = z
  .object({
    enabled: z.boolean().optional(),
    minBodyLength: z.number().int().optional(),
    requiredSections: z.array(z.string()).optional(),
  })
  .strict()
  .partial();

const repoPolicyPullRequestSchema = repoPolicyIssueSchema
  .extend({
    requireLinkedIssue: z.boolean().optional(),
  })
  .strict()
  .partial();

const repoPolicyReviewSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["comment", "report"]).optional(),
    onOpened: z.boolean().optional(),
    onEdited: z.boolean().optional(),
    onSynchronize: z.boolean().optional(),
    describeEnabled: z.boolean().optional(),
    describeAllowApply: z.boolean().optional(),
    checksCommandEnabled: z.boolean().optional(),
    includeCiChecks: z.boolean().optional(),
    secretScanEnabled: z.boolean().optional(),
    secretScanCustomPatterns: z.array(z.string()).optional(),
    autoLabelEnabled: z.boolean().optional(),
    askCommandEnabled: z.boolean().optional(),
    generateTestsCommandEnabled: z.boolean().optional(),
    changelogCommandEnabled: z.boolean().optional(),
    changelogAllowApply: z.boolean().optional(),
    feedbackCommandEnabled: z.boolean().optional(),
    improveCommandEnabled: z.boolean().optional(),
    addDocCommandEnabled: z.boolean().optional(),
    implementCommandEnabled: z.boolean().optional(),
    customRules: z.array(z.string()).optional(),
  })
  .strict()
  .partial();

const repoPolicyConfigSchema = z
  .object({
    mode: z.enum(["remind", "enforce"]).optional(),
    issue: repoPolicyIssueSchema.optional(),
    pullRequest: repoPolicyPullRequestSchema.optional(),
    review: repoPolicyReviewSchema.optional(),
  })
  .strict()
  .partial();

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;

export const CONFIG_PATH_CANDIDATES = [".mr-agent.yml", ".mr-agent.yaml"];

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
        "Failed to parse .mr-agent.yml, using defaults",
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
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    const parsedJson = JSON.parse(trimmed) as unknown;
    const validated = repoPolicyConfigSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new Error(
        `Invalid JSON policy config: ${validated.error.issues[0]?.message ?? "schema validation failed"}`,
      );
    }
    return validated.data as Partial<RepoPolicyConfig>;
  }

  return parseSimpleYamlPolicyConfig(trimmed);
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
      describeEnabled: review.describeEnabled !== false,
      describeAllowApply: Boolean(review.describeAllowApply),
      checksCommandEnabled: review.checksCommandEnabled !== false,
      includeCiChecks: review.includeCiChecks !== false,
      secretScanEnabled: review.secretScanEnabled !== false,
      secretScanCustomPatterns: normalizeStringList(review.secretScanCustomPatterns).slice(0, 20),
      autoLabelEnabled: review.autoLabelEnabled !== false,
      askCommandEnabled: review.askCommandEnabled !== false,
      generateTestsCommandEnabled: review.generateTestsCommandEnabled !== false,
      changelogCommandEnabled: review.changelogCommandEnabled !== false,
      changelogAllowApply: Boolean(review.changelogAllowApply),
      feedbackCommandEnabled: review.feedbackCommandEnabled !== false,
      improveCommandEnabled: review.improveCommandEnabled !== false,
      addDocCommandEnabled: review.addDocCommandEnabled !== false,
      implementCommandEnabled: review.implementCommandEnabled !== false,
      customRules: normalizeStringList(review.customRules).slice(0, 30),
    },
  };
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function parseSimpleYamlPolicyConfig(yamlText: string): Partial<RepoPolicyConfig> {
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText, { json: true });
  } catch (error) {
    throw new Error(
      `Invalid YAML policy config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("Invalid YAML policy config: root must be a mapping object");
  }

  const normalized = normalizeYamlPolicyRoot(root);
  const validated = repoPolicyConfigSchema.safeParse(normalized);
  if (!validated.success) {
    throw new Error(
      `Invalid YAML policy config: ${validated.error.issues[0]?.message ?? "schema validation failed"}`,
    );
  }
  return validated.data as Partial<RepoPolicyConfig>;
}

function normalizeYamlPolicyRoot(
  root: Record<string, unknown>,
): Partial<RepoPolicyConfig> {
  const result: Partial<RepoPolicyConfig> = {};

  const mode = parsePolicyModeFromUnknown(root.mode);
  if (mode) {
    result.mode = mode;
  }

  const issue = asRecord(root.issue);
  if (issue) {
    const normalizedIssue = normalizeYamlSectionConfig(issue);
    if (Object.keys(normalizedIssue).length > 0) {
      result.issue = normalizedIssue as PolicySectionConfig;
    }
  }

  const pullRequest = asRecord(root.pullRequest) ?? asRecord(root.pull_request);
  if (pullRequest) {
    const normalizedPullRequest = normalizeYamlPullRequestSection(pullRequest);
    if (Object.keys(normalizedPullRequest).length > 0) {
      result.pullRequest = normalizedPullRequest as PullRequestPolicySectionConfig;
    }
  }

  const review = asRecord(root.review);
  if (review) {
    const normalizedReview = normalizeYamlReviewConfig(review);
    if (Object.keys(normalizedReview).length > 0) {
      result.review = normalizedReview as ReviewPolicyConfig;
    }
  }

  return result;
}

function normalizeYamlSectionConfig(
  raw: Record<string, unknown>,
): Partial<PolicySectionConfig> {
  const target: Partial<PolicySectionConfig> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeYamlConfigKey(rawKey);
    if (key === "enabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.enabled = bool;
      }
      continue;
    }
    if (key === "minbodylength") {
      const number = coerceNumber(rawValue);
      if (number !== undefined) {
        target.minBodyLength = number;
      }
      continue;
    }
    if (key === "requiredsections") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.requiredSections = list;
      }
    }
  }
  return target;
}

function normalizeYamlPullRequestSection(
  raw: Record<string, unknown>,
): Partial<PullRequestPolicySectionConfig> {
  const target = normalizeYamlSectionConfig(raw) as Partial<PullRequestPolicySectionConfig>;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeYamlConfigKey(rawKey);
    if (key === "requirelinkedissue") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.requireLinkedIssue = bool;
      }
    }
  }
  return target;
}

function normalizeYamlReviewConfig(
  raw: Record<string, unknown>,
): Partial<ReviewPolicyConfig> {
  const target: Partial<ReviewPolicyConfig> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeYamlConfigKey(rawKey);
    if (key === "enabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.enabled = bool;
      }
      continue;
    }
    if (key === "mode") {
      const mode = parseReviewModeFromUnknown(rawValue);
      if (mode) {
        target.mode = mode;
      }
      continue;
    }
    if (key === "onopened") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.onOpened = bool;
      }
      continue;
    }
    if (key === "onedited") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.onEdited = bool;
      }
      continue;
    }
    if (key === "onsynchronize") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.onSynchronize = bool;
      }
      continue;
    }
    if (key === "describeenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.describeEnabled = bool;
      }
      continue;
    }
    if (key === "describeallowapply") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.describeAllowApply = bool;
      }
      continue;
    }
    if (key === "checkscommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.checksCommandEnabled = bool;
      }
      continue;
    }
    if (key === "includecichecks") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.includeCiChecks = bool;
      }
      continue;
    }
    if (key === "secretscanenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.secretScanEnabled = bool;
      }
      continue;
    }
    if (key === "secretscancustompatterns") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.secretScanCustomPatterns = list;
      }
      continue;
    }
    if (key === "autolabelenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.autoLabelEnabled = bool;
      }
      continue;
    }
    if (key === "askcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.askCommandEnabled = bool;
      }
      continue;
    }
    if (key === "generatetestscommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.generateTestsCommandEnabled = bool;
      }
      continue;
    }
    if (key === "changelogcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.changelogCommandEnabled = bool;
      }
      continue;
    }
    if (key === "changelogallowapply") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.changelogAllowApply = bool;
      }
      continue;
    }
    if (key === "feedbackcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.feedbackCommandEnabled = bool;
      }
      continue;
    }
    if (key === "improvecommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.improveCommandEnabled = bool;
      }
      continue;
    }
    if (key === "adddoccommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.addDocCommandEnabled = bool;
      }
      continue;
    }
    if (key === "implementcommandenabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.implementCommandEnabled = bool;
      }
      continue;
    }
    if (key === "customrules") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.customRules = list;
      }
    }
  }

  return target;
}

function normalizeYamlConfigKey(rawKey: string): string {
  return rawKey.trim().toLowerCase().replace(/[_-]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }
  if (typeof value === "string") {
    return parseYamlBooleanMaybe(value);
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(stripYamlQuotes(value));
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function coerceStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return list;
  }
  if (typeof value === "string") {
    const trimmed = stripYamlQuotes(value).trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const parsed = trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => stripYamlQuotes(item).trim())
        .filter(Boolean);
      return parsed.length > 0 ? parsed : undefined;
    }
    return [trimmed];
  }
  return undefined;
}

function parsePolicyModeFromUnknown(value: unknown): PolicyMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parsePolicyMode(value);
}

function parseReviewModeFromUnknown(value: unknown): ReviewMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parseReviewMode(value);
}

function parsePolicyMode(value: string): PolicyMode {
  return stripYamlQuotes(value).toLowerCase() === "enforce" ? "enforce" : "remind";
}

function parseReviewMode(value: string): ReviewMode {
  return stripYamlQuotes(value).toLowerCase() === "report" ? "report" : "comment";
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
