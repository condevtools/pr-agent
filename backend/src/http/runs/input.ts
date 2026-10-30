import { z } from "zod";
import { fingerprint } from "../../agent-runtime/versions.js";
import { reviewRunInputSchema } from "../../review/intake/run-input.js";

export const createReviewRequestSchema = z.object({
  workflow: z.enum(["review.single.v1", "review.deep.v1"]).default("review.single.v1"),
  number: z.number().int().positive(), mode: z.enum(["report", "comment"]).default("report"),
  options: reviewRunInputSchema.shape.options.default({ customRules: [], includeCiChecks: true,
    enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: true }),
}).strict();
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;

const usageCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
export const reconcileModelUsageSchema = z.object({
  providerUsageRevision: z.string().min(1).max(128),
  supersedesProviderUsageRevision: z.string().min(1).max(128).nullable(),
  evidenceReference: z.string().min(1).max(2048),
  usage: z.object({
    inputTokens: usageCounter,
    cachedInputTokens: usageCounter,
    cacheWriteInputTokens: usageCounter,
    outputTokens: usageCounter,
    reasoningOrThoughtTokens: usageCounter,
    toolInputTokens: usageCounter,
    totalTokens: usageCounter,
    original: z.record(z.unknown()).default({}),
  }).strict(),
}).strict();

/** Preserve the original single-review idempotency bytes after adding a default field. */
export function reviewApiSourceHash(request: CreateReviewRequest): string {
  const { workflow, ...legacy } = request;
  return fingerprint(workflow === "review.single.v1" ? legacy : request);
}
