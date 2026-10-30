import { load as loadYaml } from "js-yaml";
import { z } from "zod";

import { parseYamlBooleanMaybe } from "../../core/config/yaml.js";

export const reviewPolicyOverridesSchema = z.object({
  enabled: z.boolean().optional(), mode: z.enum(["comment", "report"]).optional(),
  onOpened: z.boolean().optional(), onEdited: z.boolean().optional(),
  onSynchronize: z.boolean().optional(),
  includeCiChecks: z.boolean().optional(), secretScanEnabled: z.boolean().optional(),
  secretScanCustomPatterns: z.array(z.string()).optional(), autoLabelEnabled: z.boolean().optional(),
  feedbackCommandEnabled: z.boolean().optional(), improveCommandEnabled: z.boolean().optional(),
  addDocCommandEnabled: z.boolean().optional(), customRules: z.array(z.string()).optional(),
}).strict().partial();

const policySectionOverridesSchema = z.object({
  enabled: z.boolean().optional(),
  minBodyLength: z.number().int().optional(),
  requiredSections: z.array(z.string()).optional(),
}).strict().partial();

const pullRequestPolicyOverridesSchema = policySectionOverridesSchema.extend({
  requireLinkedIssue: z.boolean().optional(),
}).strict().partial();

export const repositoryPolicyOverridesSchema = z.object({
  mode: z.enum(["remind", "enforce"]).optional(),
  issue: policySectionOverridesSchema.optional(),
  pullRequest: pullRequestPolicyOverridesSchema.optional(),
  review: reviewPolicyOverridesSchema.optional(),
}).strict().partial();

export type ReviewPolicyOverrides = z.infer<typeof reviewPolicyOverridesSchema>;
export type RepositoryPolicyOverrides = z.infer<typeof repositoryPolicyOverridesSchema>;

type Coercer = (value: unknown) => unknown;

const reviewFields: Readonly<Record<string, readonly [keyof ReviewPolicyOverrides, Coercer]>> = {
  enabled: ["enabled", coerceBoolean],
  mode: ["mode", (value) => coerceEnum(value, ["comment", "report"])],
  onopened: ["onOpened", coerceBoolean], onedited: ["onEdited", coerceBoolean],
  onsynchronize: ["onSynchronize", coerceBoolean],
  includecichecks: ["includeCiChecks", coerceBoolean],
  secretscanenabled: ["secretScanEnabled", coerceBoolean],
  secretscancustompatterns: ["secretScanCustomPatterns", coerceStringList],
  autolabelenabled: ["autoLabelEnabled", coerceBoolean],
  feedbackcommandenabled: ["feedbackCommandEnabled", coerceBoolean],
  improvecommandenabled: ["improveCommandEnabled", coerceBoolean],
  adddoccommandenabled: ["addDocCommandEnabled", coerceBoolean],
  customrules: ["customRules", coerceStringList],
};

const sectionFields: Readonly<Record<string, readonly [string, Coercer]>> = {
  enabled: ["enabled", coerceBoolean], minbodylength: ["minBodyLength", coerceInteger],
  requiredsections: ["requiredSections", coerceStringList],
};
const pullRequestFields = {
  ...sectionFields,
  requirelinkedissue: ["requireLinkedIssue", coerceBoolean] as const,
};

const retiredReviewFields = new Set([
  "describeenabled", "describeallowapply", "checkscommandenabled",
  "askcommandenabled", "generatetestscommandenabled", "changelogcommandenabled",
  "changelogallowapply", "custompromptcommandenabled", "helpdocscommandenabled",
  "analyzecommandenabled", "compliancecommandenabled", "similarcodecommandenabled",
  "scanrepodiscussionscommandenabled",
]);

export function parseReviewPolicyOverridesFromConfigText(raw: string): ReviewPolicyOverrides {
  const parsed = parseConfigText(raw);
  if (parsed === null || parsed === undefined) return {};
  const root = requireRecord(parsed, "review policy config root must be a mapping object");
  const reviewSource = asRecord(findAliasedValue(root, "review")) ?? root;
  return validate(reviewPolicyOverridesSchema, normalizeFields(reviewSource, reviewFields),
    "invalid review policy config");
}

export function parseRepositoryPolicyOverridesFromConfigText(raw: string): RepositoryPolicyOverrides {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    return validate(repositoryPolicyOverridesSchema, stripRetiredRepositoryReviewFields(JSON.parse(trimmed) as unknown),
      "Invalid JSON policy config");
  }
  let parsed: unknown;
  try {
    parsed = loadYaml(trimmed, { json: true });
  } catch (error) {
    throw new Error(`Invalid YAML policy config: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  const root = requireRecord(parsed, "Invalid YAML policy config: root must be a mapping object");
  const normalized: Record<string, unknown> = {};
  const mode = coerceEnum(findAliasedValue(root, "mode"), ["remind", "enforce"]);
  if (mode !== undefined) normalized.mode = mode;
  const issue = asRecord(findAliasedValue(root, "issue"));
  if (issue) normalized.issue = normalizeFields(issue, sectionFields);
  const pullRequest = asRecord(findAliasedValue(root, "pullrequest"));
  if (pullRequest) normalized.pullRequest = normalizeFields(pullRequest, pullRequestFields);
  const review = asRecord(findAliasedValue(root, "review"));
  if (review) normalized.review = normalizeFields(review, reviewFields);
  return validate(repositoryPolicyOverridesSchema, normalized, "Invalid YAML policy config");
}

function stripRetiredRepositoryReviewFields(value: unknown): unknown {
  const root = asRecord(value);
  const review = root ? asRecord(root.review) : undefined;
  if (!root || !review) return value;
  return {
    ...root,
    review: Object.fromEntries(
      Object.entries(review).filter(([key]) => !retiredReviewFields.has(normalizeKey(key))),
    ),
  };
}

function parseConfigText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("{") ? JSON.parse(trimmed) as unknown : loadYaml(trimmed, { json: true });
}

function normalizeFields(source: Record<string, unknown>,
  fields: Readonly<Record<string, readonly [string, Coercer]>>): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const field = fields[normalizeKey(rawKey)];
    if (!field) continue;
    const value = field[1](rawValue);
    if (value !== undefined) target[field[0]] = value;
  }
  return target;
}

function findAliasedValue(source: Record<string, unknown>, normalizedKey: string): unknown {
  for (const [key, value] of Object.entries(source)) {
    if (normalizeKey(key) === normalizedKey) return value;
  }
  return undefined;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(message);
  return record;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  return typeof value === "string" ? parseYamlBooleanMaybe(value) : undefined;
}

function coerceInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function coerceEnum<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.find((candidate) => candidate === normalized);
}

function coerceStringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!values) return undefined;
  return values.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label}: ${result.error.issues[0]?.message ?? "schema validation failed"}`);
  }
  return result.data;
}
