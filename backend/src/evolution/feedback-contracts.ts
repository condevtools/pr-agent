import { z } from "zod";

import { fingerprint } from "../harness/versions.js";
import { assertSafePath } from "../integrations/shared/repository-read-tools.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const findingLabelSchema = z.object({
  path: z.string().min(1).max(512),
  startLine: z.number().int().positive().max(10_000_000),
  endLine: z.number().int().positive().max(10_000_000),
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1).max(300),
}).strict().superRefine((value, context) => {
  if (value.endLine < value.startLine || value.endLine - value.startLine > 100) {
    context.addIssue({ code: "custom", message: "finding location must be ordered and span at most 101 lines" });
  }
  try { assertSafePath(value.path); }
  catch { context.addIssue({ code: "custom", message: "finding path is unsafe" }); }
});

export const trustedLabelSetSchema = z.object({
  schemaVersion: z.literal(1), rubricVersion: z.literal("review-quality.v1"),
  completeness: z.literal("complete"), expectedFindings: z.array(findingLabelSchema).max(100),
}).strict();

export const feedbackObservationSchema = z.object({
  schemaVersion: z.literal(1), artifactHash: hash,
  sentiment: z.enum(["helpful", "not_helpful"]),
  categories: z.array(z.enum(["missed_finding", "false_positive", "incorrect_severity", "poor_explanation", "other"]))
    .max(5).default([]),
  comment: z.string().max(4_000).optional(),
}).strict();

export const annotationRequestSchema = z.object({
  artifactHash: hash, labelSet: trustedLabelSetSchema,
  supersedesAnnotationId: z.string().uuid().optional(),
  provenance: z.object({ method: z.literal("full_diff_review"), notes: z.string().max(4_000).optional() }).strict(),
}).strict();

export const arbitrationRequestSchema = z.object({
  artifactHash: hash, rubricVersion: z.literal("review-quality.v1"),
  leftAnnotationId: z.string().uuid(), leftLabelSetHash: hash,
  rightAnnotationId: z.string().uuid(), rightLabelSetHash: hash,
  chosenLabelSetHash: hash, reason: z.string().min(20).max(4_000),
}).strict();

export type FindingLabelV1 = z.infer<typeof findingLabelSchema>;
export type TrustedLabelSetV1 = z.infer<typeof trustedLabelSetSchema>;
export type FeedbackObservationRequest = z.infer<typeof feedbackObservationSchema>;
export type AnnotationRequest = z.infer<typeof annotationRequestSchema>;
export type ArbitrationRequest = z.infer<typeof arbitrationRequestSchema>;
export interface FeedbackActor { type: "user" | "service"; id: string }
export interface FeedbackReceipt { id: string; sourceRunId: string; artifactHash: string; createdAt: string }
export interface AnnotationReceipt {
  id: string; sourceRunId: string; artifactHash: string; rubricVersion: "review-quality.v1";
  labelSetHash: string; actor: FeedbackActor; supersedesAnnotationId?: string;
  trustedLabelSetId?: string; createdAt: string;
}
export interface ArbitrationReceipt {
  id: string; sourceRunId: string; chosenLabelSetHash: string; trustedLabelSetId: string; createdAt: string;
}

export function canonicalizeLabelSet(value: unknown): TrustedLabelSetV1 {
  const parsed = trustedLabelSetSchema.parse(value);
  const expectedFindings = parsed.expectedFindings.map((finding) => ({
    ...finding, path: finding.path.normalize("NFC"), title: finding.title.trim().normalize("NFC"),
  })).sort((left, right) => left.path.localeCompare(right.path)
    || left.startLine - right.startLine || left.endLine - right.endLine
    || left.severity.localeCompare(right.severity) || left.title.localeCompare(right.title));
  const seen = new Set<string>();
  for (const finding of expectedFindings) {
    const key = findingMatchKey(finding);
    if (seen.has(key)) throw new Error("Label set contains duplicate finding locations");
    seen.add(key);
  }
  return { ...parsed, expectedFindings };
}

export function labelSetHash(value: TrustedLabelSetV1): string { return fingerprint(canonicalizeLabelSet(value)); }

/** Stable scoring identity deliberately ignores presentation-only title text. */
export function findingMatchKey(value: Pick<FindingLabelV1, "path" | "startLine" | "endLine" | "severity">): string {
  return `${value.path.normalize("NFC")}\0${value.startLine}\0${value.endLine}\0${value.severity}`;
}
