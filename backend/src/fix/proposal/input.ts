import { z } from "zod";

import type { FixRunInput, FixSource, VerificationResult } from "../contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const safePath = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === ""),
"path must be repository-relative without traversal");

const fixSourceObjectSchema = z.object({
  tenantId: z.string().uuid(), integrationId: z.string().uuid(), runId: z.string().uuid(),
  sourceReviewRunId: z.string().uuid(), findingId: hash,
  platform: z.enum(["github", "gitlab"]), repository: z.string().min(1).max(512),
  baseSha: z.string().min(1).max(128), headSha: z.string().min(1).max(128),
  sourceBundleRef: z.string().min(1).max(1024), sourceBundleHash: hash,
  allowedPaths: z.array(safePath).min(1).max(200),
  finding: z.object({ title: z.string().min(1).max(300), body: z.string().min(1).max(4000),
    path: safePath, startLine: z.number().int().positive(), endLine: z.number().int().positive() })
    .refine((value) => value.endLine >= value.startLine, "finding line range is invalid"),
}).strict();
export const fixSourceSchema: z.ZodType<FixSource> = fixSourceObjectSchema;

export function parseFixSource(value: unknown): FixSource {
  return fixSourceSchema.parse(value);
}

export const fixRunInputSchema: z.ZodType<FixRunInput> = z.object({
  schemaVersion: z.literal(1), workflow: z.literal("fix.propose.v1"), policyId: z.string().min(1).max(128),
  source: fixSourceObjectSchema.omit({ runId: true }),
  original: z.object({ platform: z.enum(["github", "gitlab"]), repository: z.string().min(1).max(512),
    number: z.number().int().positive(), providerRepositoryId: z.number().int().positive(),
    headBranch: z.string().min(1).max(1024), headSha: z.string().min(1).max(128) }).strict(),
}).strict();

const optionalArtifactMap = z.object({ baselineTarget: z.string().max(1024).optional(), patchedTarget: z.string().max(1024).optional(),
  baselineRegression: z.string().max(1024).optional(), patchedRegression: z.string().max(1024).optional() }).strict();
const optionalHashMap = z.object({ baselineTarget: hash.optional(), patchedTarget: hash.optional(),
  baselineRegression: hash.optional(), patchedRegression: hash.optional() }).strict();

export const verificationResultSchema: z.ZodType<VerificationResult> = z.object({
  outcome: z.enum(["verified", "suggestion_only", "failed"]), reasonCodes: z.array(z.string().min(1).max(200)).max(50),
  baselineTarget: z.enum(["pass", "fail", "timeout", "not_run"]),
  patchedTarget: z.enum(["pass", "fail", "timeout", "not_run"]),
  baselineRegression: z.array(z.string().min(1).max(500)).max(200),
  patchedRegression: z.array(z.string().min(1).max(500)).max(200),
  relevance: z.enum(["verified", "failed", "unknown"]),
  relevanceAttestation: z.object({ kind: z.enum(["trusted_checker", "human"]),
    testPatchHash: hash, attestationHash: hash }).strict().optional(),
  logRefs: optionalArtifactMap, logHashes: optionalHashMap,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), policyHash: hash, proposalHash: hash,
}).strict();
