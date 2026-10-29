import { z } from "zod";

import type { VerificationResult } from "./contracts.js";

export const sandboxCommandResultSchema = z.object({ status: z.enum(["pass", "fail", "timeout", "not_run"]),
  exitCode: z.number().int().nullable(), failedTests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
  testsRun: z.number().int().min(0).max(1_000_000), log: z.string(), logTruncated: z.boolean() }).strict();
export const sandboxRunnerResultSchema = z.object({ protocolVersion: z.literal(1),
  baselineTarget: sandboxCommandResultSchema, patchedTarget: sandboxCommandResultSchema,
  baselineRegression: sandboxCommandResultSchema, patchedRegression: sandboxCommandResultSchema }).strict();
export type SandboxRunnerResult = z.infer<typeof sandboxRunnerResultSchema>;

export function evaluateVerificationResult(input: { runner: SandboxRunnerResult;
  relevance: VerificationResult["relevance"]; relevanceReasons: readonly string[];
  imageDigest: string; policyHash: string; proposalHash: string;
  logHashes: VerificationResult["logHashes"] }): VerificationResult {
  const reasons = new Set(input.relevanceReasons);
  if (input.runner.baselineTarget.status !== "fail") reasons.add("baseline_target_did_not_fail");
  if (input.runner.patchedTarget.status !== "pass") reasons.add("patched_target_did_not_pass");
  if (input.runner.baselineRegression.status !== "pass") reasons.add("baseline_regression_did_not_pass");
  if (input.runner.patchedRegression.status !== "pass") reasons.add("patched_regression_did_not_pass");
  for (const [name, result] of Object.entries(input.runner).filter(([name]) => name !== "protocolVersion")) {
    if (typeof result === "object" && result && "testsRun" in result && result.testsRun === 0) {
      reasons.add(`${name.replaceAll(/([A-Z])/g, "_$1").toLowerCase()}_executed_no_tests`);
    }
  }
  if (input.relevance !== "verified") reasons.add("relevance_not_verified");
  const incomplete = Object.values(input.runner).some((value) =>
    typeof value === "object" && value !== null && "status" in value && value.status === "not_run");
  if (incomplete) reasons.add("verification_incomplete");
  return { outcome: incomplete ? "failed" : reasons.size === 0 ? "verified" : "suggestion_only",
    reasonCodes: [...reasons].sort(), baselineTarget: input.runner.baselineTarget.status,
    patchedTarget: input.runner.patchedTarget.status,
    baselineRegression: input.runner.baselineRegression.failedTests,
    patchedRegression: input.runner.patchedRegression.failedTests,
    relevance: input.relevance, logRefs: { baselineTarget: undefined, patchedTarget: undefined,
      baselineRegression: undefined, patchedRegression: undefined }, logHashes: input.logHashes,
    imageDigest: input.imageDigest, policyHash: input.policyHash, proposalHash: input.proposalHash };
}
