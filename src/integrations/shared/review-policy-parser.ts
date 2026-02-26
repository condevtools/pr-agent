import { load as loadYaml } from "js-yaml";
import { z } from "zod";

import { parseYamlBooleanMaybe } from "./yaml.js";

const reviewPolicyOverridesSchema = z
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
    customRules: z.array(z.string()).optional(),
  })
  .strict()
  .partial();

export type ReviewPolicyOverrides = z.infer<typeof reviewPolicyOverridesSchema>;

export function parseReviewPolicyOverridesFromConfigText(raw: string): ReviewPolicyOverrides {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  let parsed: unknown;
  if (trimmed.startsWith("{")) {
    parsed = JSON.parse(trimmed) as unknown;
  } else {
    parsed = loadYaml(trimmed, { json: true });
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("review policy config root must be a mapping object");
  }

  const reviewSource = asRecord(root.review) ?? root;
  const normalized = normalizeReviewPolicyOverrides(reviewSource);
  const validated = reviewPolicyOverridesSchema.safeParse(normalized);
  if (!validated.success) {
    throw new Error(
      `invalid review policy config: ${validated.error.issues[0]?.message ?? "schema validation failed"}`,
    );
  }

  return validated.data;
}

function normalizeReviewPolicyOverrides(
  source: Record<string, unknown>,
): ReviewPolicyOverrides {
  const target: ReviewPolicyOverrides = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeConfigKey(rawKey);
    if (key === "enabled") {
      const bool = coerceBoolean(rawValue);
      if (bool !== undefined) {
        target.enabled = bool;
      }
      continue;
    }
    if (key === "mode") {
      const mode = coerceMode(rawValue);
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
    if (key === "customrules") {
      const list = coerceStringList(rawValue);
      if (list) {
        target.customRules = list;
      }
    }
  }

  return target;
}

function normalizeConfigKey(raw: string): string {
  return raw.replace(/[_-]/g, "").trim().toLowerCase();
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

function coerceMode(value: unknown): "comment" | "report" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "comment" || normalized === "report") {
    return normalized;
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
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.includes(",")) {
      return trimmed
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [trimmed];
  }
  return undefined;
}
