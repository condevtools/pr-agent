import { z } from "zod";

import type { DeepReviewArtifact } from "../review/deep/contracts.js";
import { fingerprint } from "../agent-runtime/versions.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const REPLAY_VERIFIER_HASH = fingerprint({ scorer: "eval-replay-scorer.v2", matching: "exact-location-severity.v1",
  safety: "partial-or-high-fp-or-high-fn.v1" });
export const EVALUATION_SCHEDULING_POLICY = Object.freeze({ schemaVersion: 1 as const,
  maxCasesPerSplit: 500, maxConcurrentChildrenPerIntegration: 4, maxChildRunMs: 15 * 60_000,
  minimumDeadlineMs: 7 * 24 * 60 * 60_000, deadlineBufferMs: 24 * 60 * 60_000 });
export const EVALUATION_SCHEDULING_POLICY_HASH = fingerprint(EVALUATION_SCHEDULING_POLICY);

export const createEvaluationSchema = z.object({
  datasetId: z.string().uuid(), candidateId: z.string().uuid(),
  split: z.enum(["development", "validation", "holdout"]),
}).strict();

export const replayRunInputSchema = z.object({
  schemaVersion: z.literal(1), workflow: z.literal("eval.replay.v1"),
  evaluationId: z.string().uuid(), resultId: z.string().uuid(), datasetId: z.string().uuid(),
  caseId: z.string().uuid(), candidateId: z.string().uuid(), variant: z.enum(["baseline", "candidate"]),
  repetition: z.number().int().min(1).max(3), samplingMode: z.literal("unseeded"),
  attemptIdentityHash: sha256, fixtureHash: sha256,
  labelSetId: z.string().uuid(), labelSetHash: sha256, componentHash: sha256, verifierHash: sha256,
}).strict();

export type ReplayRunInput = z.infer<typeof replayRunInputSchema>;
export type EvaluationSplit = z.infer<typeof createEvaluationSchema>["split"];
export type EvaluationVariant = ReplayRunInput["variant"];

export interface ReplayScoreV1 {
  schemaVersion: 1;
  expected: number;
  predicted: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  severityWeightedF1: number;
  highFalsePositives: number;
  highFalseNegatives: number;
  safetyRegression: boolean;
  analysisStatus: DeepReviewArtifact["analysisStatus"];
}
export interface EvaluationReceipt {
  id: string;
  datasetId: string;
  candidateId: string;
  split: EvaluationSplit;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  version: number;
  repetitions: 3;
  plannedResults: number;
  completedResults: number;
  failedResults: number;
  manifestHash: string;
  metrics?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}
