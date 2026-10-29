import type { VerificationResult } from "./contracts.js";

const allowedNonTechnicalReasons = new Set(["relevance_not_verified", "relevance_attestation_missing"]);
const requiredLogPhases = ["baselineTarget", "patchedTarget", "baselineRegression", "patchedRegression"] as const;

/** Publication eligibility uses only complete, independently persisted differential evidence. */
export function isFixDifferentialEligible(result: VerificationResult): boolean {
  return result.baselineTarget === "fail"
    && result.patchedTarget === "pass"
    && result.baselineRegression.length === 0
    && result.patchedRegression.length === 0
    && requiredLogPhases.every((phase) => /^[a-f0-9]{64}$/.test(result.logHashes[phase] ?? ""))
    && result.reasonCodes.every((reason) => allowedNonTechnicalReasons.has(reason));
}
