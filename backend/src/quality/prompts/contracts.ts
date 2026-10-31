import { z } from "zod";

import { fingerprint } from "../../agent-runtime/versions.js";

export const MANAGED_PROMPT_KEYS = [
  "review.single.system.zh", "review.single.system.en",
  "review.single.requirements.zh", "review.single.requirements.en",
  "review.deep.role.system", "review.deep.role.instruction",
  "review.deep.critic.system", "review.deep.critic.instruction",
  "issues.triage.system", "fix.proposal.system",
  "evolution.proposal.system", "evolution.proposal.instruction",
  "evaluation.judge.system",
] as const;
export type ManagedPromptKey = typeof MANAGED_PROMPT_KEYS[number];

export interface FrozenPromptSnapshot {
  key: ManagedPromptKey; name: string; version: number; template: string;
  contentHash: string; variables: string[]; targetFingerprint: string;
}
export interface PromptBundleV1 {
  schemaVersion: 1; targetFingerprint: string;
  prompts: Partial<Record<ManagedPromptKey, FrozenPromptSnapshot>>; hash: string;
}
export interface ManagedPromptReference { name: string; version: number; contentHash: string }

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.enum(MANAGED_PROMPT_KEYS);
const snapshotSchema = z.object({
  key, name: z.string().trim().min(1).max(256),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  template: z.string().min(1).max(64 * 1024), contentHash: hash,
  variables: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(32),
  targetFingerprint: hash,
}).strict();
const bundleSchema = z.object({
  schemaVersion: z.literal(1), targetFingerprint: hash,
  prompts: z.record(key, snapshotSchema), hash,
}).strict();

export function promptTemplateHash(template: string): string {
  return fingerprint({ schemaVersion: 1, type: "text", template });
}

export function promptBundleHash(targetFingerprint: string,
  prompts: PromptBundleV1["prompts"]): string {
  return fingerprint({ schemaVersion: 1, targetFingerprint,
    prompts: Object.fromEntries(MANAGED_PROMPT_KEYS.filter((item) => prompts[item]).map((item) => {
      const prompt = prompts[item]!;
      return [item, { name: prompt.name, version: prompt.version,
        contentHash: prompt.contentHash, variables: prompt.variables }];
    })) });
}

export function parsePromptBundle(value: unknown): PromptBundleV1 {
  const parsed = bundleSchema.parse(value) as PromptBundleV1;
  for (const promptKey of MANAGED_PROMPT_KEYS) {
    const prompt = parsed.prompts[promptKey];
    if (!prompt) continue;
    if (prompt.key !== promptKey || prompt.targetFingerprint !== parsed.targetFingerprint
        || prompt.contentHash !== promptTemplateHash(prompt.template)
        || !same(prompt.variables, promptTemplateVariables(prompt.template))) {
      throw new Error(`Frozen managed prompt is invalid: ${promptKey}`);
    }
  }
  if (parsed.hash !== promptBundleHash(parsed.targetFingerprint, parsed.prompts)) {
    throw new Error("Frozen managed prompt bundle hash is invalid");
  }
  const prompts = Object.fromEntries(Object.entries(parsed.prompts).map(([promptKey, prompt]) => [
    promptKey,
    Object.freeze({ ...prompt, variables: Object.freeze([...prompt.variables]) }),
  ])) as PromptBundleV1["prompts"];
  return Object.freeze({ ...parsed, prompts: Object.freeze(prompts) });
}

export function promptTemplateVariables(template: string): string[] {
  const result = [...template.matchAll(/\{\{([a-z][a-z0-9_]{0,63})\}\}/gu)].map((match) => match[1]!);
  const residue = template.replace(/\{\{[a-z][a-z0-9_]{0,63}\}\}/gu, "");
  if (residue.includes("{{") || residue.includes("}}")) throw new Error("Managed prompt contains an invalid variable");
  return [...new Set(result)].sort();
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
