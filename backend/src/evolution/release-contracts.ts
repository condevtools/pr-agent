import { z } from "zod";

import type { ReviewStrategyText } from "../review/strategy/contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commandKey = z.string().trim().min(1).max(200);

export const releaseRoutingSchema = z.enum(["off", "shadow", "canary", "full"]);
export const releaseStateSchema = z.enum(["evaluated_experimental", "approved_canary", "promoted", "rolled_back"]);
export type EvolutionReleaseRouting = z.infer<typeof releaseRoutingSchema>;
export type EvolutionReleaseState = z.infer<typeof releaseStateSchema>;

export const qualifyCandidateSchema = z.object({
  candidateId: z.string().uuid(), datasetId: z.string().uuid(),
  validationEvaluationId: z.string().uuid(), holdoutEvaluationId: z.string().uuid(),
  commandKey,
}).strict();

export const requestReleaseSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("shadow"), candidateId: z.string().uuid(), qualificationId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(), commandKey }).strict(),
  z.object({ target: z.literal("canary"), candidateId: z.string().uuid(), qualificationId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(), candidateBps: z.number().int().min(1).max(500), commandKey }).strict(),
  z.object({ target: z.literal("promote"), candidateId: z.string().uuid(), qualificationId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(), commandKey }).strict(),
]);

export const decideReleaseSchema = z.object({ requestId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]), commandKey }).strict();
export const revokeReleaseSchema = z.object({ requestId: z.string().uuid(), commandKey }).strict();
export const rollbackReleaseSchema = z.object({ expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000), commandKey }).strict();

export type QualifyCandidateInput = z.infer<typeof qualifyCandidateSchema>;
export type ReleaseRequestInput = z.infer<typeof requestReleaseSchema>;
export type ReleaseDecisionInput = z.infer<typeof decideReleaseSchema>;
export type ReleaseRollbackInput = z.infer<typeof rollbackReleaseSchema>;

export interface EvolutionReleasePolicyV1 {
  schemaVersion: 1; activationEnabled: boolean; minimumCases: 300; minimumRepositories: 30;
  minimumSeverityCases: 30; minimumLanguageCases: 30; requiredLanguages: readonly ["typescript", "javascript"];
  requiredRepetitions: 3; minimumQualityRatio: 1.03; maximumCostRatio: 1.2;
  maximumCanaryBps: 500; minimumCanaryMs: 86_400_000;
  minimumCandidateSelections: 100; minimumControlSelections: 100;
}

export interface OfflineQualificationEvidenceV1 {
  schemaVersion: 1; candidateId: string; candidateHash: string; datasetId: string; datasetVersion: number;
  datasetManifestHash: string; validationEvaluationId: string; holdoutEvaluationId: string;
  repositories: number; cases: number; severityCases: Record<"high" | "medium" | "low", number>;
  languageCases: Record<"typescript" | "javascript", number>;
  validationMetricsHash: string; holdoutMetricsHash: string;
  baselineComponentHash: string; candidateComponentHash: string;
  providerModelVersions: readonly string[]; policyHash: string;
}

export interface EvolutionReleaseQualification {
  id: string; tenantId: string; integrationId: string; candidateId: string; datasetId: string;
  policyHash: string; evidenceHash: string; evidence: OfflineQualificationEvidenceV1;
  createdBy: { type: "user" | "service"; id: string }; createdAt: string;
}

export interface EvolutionReleaseAssignment {
  tenantId: string; integrationId: string; state: EvolutionReleaseState; routing: EvolutionReleaseRouting;
  version: number; candidateId?: string; qualificationId?: string; candidateBps: number;
  routingSalt: string; activatedAt?: string; promotedAt?: string; updatedAt: string;
}

export interface EvolutionReleaseRequest {
  id: string; target: "shadow" | "canary" | "promote"; candidateId: string; qualificationId: string;
  expectedVersion: number; candidateBps: number; status: "open" | "rejected" | "revoked" | "consumed" | "expired";
  makerId: string; requestHash: string; expiresAt: string; createdAt: string;
}

export interface EvolutionReleaseReceipt {
  id: string; requestId?: string; kind: "shadow" | "canary" | "promote" | "rollback";
  before: Record<string, unknown>; after: Record<string, unknown>; evidence: Record<string, unknown>;
  evidenceHash: string; createdAt: string;
}

export interface EvolutionRunAssignment {
  runId: string; assignmentVersion: number; routing: EvolutionReleaseRouting;
  selection: "baseline" | "control" | "candidate";
  candidateId?: string; qualificationId?: string; releaseReceiptId?: string; reviewText: ReviewStrategyText;
  reviewTextHash: string; promptHash: string; toolHash: string; selectionHash: string; createdAt: string;
}

export { hash as releaseHashSchema };
