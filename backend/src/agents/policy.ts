import { z } from "zod";

import type { DeepWorkflowPolicy } from "./contracts.js";

const roleLimitsSchema = z.object({
  maxTurns: z.number().int().min(1).max(3),
  maxToolCalls: z.number().int().min(1).max(3),
  maxCandidates: z.number().int().min(1).max(20),
  maxWallTimeMs: z.number().int().min(1).max(300_000),
  maxInputBytesPerTurn: z.number().int().min(1).max(2_000_000),
  maxOutputTokensPerTurn: z.number().int().min(1).max(100_000),
}).strict();

export const deepWorkflowPolicySchema = z.object({
  roleLimits: z.object({
    security: roleLimitsSchema,
    correctness: roleLimitsSchema,
  }).strict(),
  criticInputCandidateLimit: z.number().int().min(1).max(40),
  criticLimits: z.object({
    maxWallTimeMs: z.number().int().min(1).max(300_000),
    maxInputBytes: z.number().int().min(1).max(2_000_000),
    maxOutputTokens: z.number().int().min(1).max(100_000),
  }).strict(),
}).strict();

export function createDeepWorkflowPolicy(value: unknown): DeepWorkflowPolicy {
  return deepWorkflowPolicySchema.parse(value);
}
