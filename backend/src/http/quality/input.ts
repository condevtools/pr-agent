import { z } from "zod";

import { trustedLabelSetSchema } from "../../evolution/feedback/contracts.js";
import { MANAGED_PROMPT_KEYS } from "../../quality/prompts/contracts.js";
import { judgeRequestSchema } from "../../quality/evaluators/contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commandKey = z.string().trim().min(1).max(200);
const remotePromptName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u);

export const qualityCommandKeySchema = commandKey;
export const qualityIdSchema = z.string().uuid();

export const promptPullSchema = z.object({
  promptKey: z.enum(MANAGED_PROMPT_KEYS),
  remoteName: remotePromptName,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  seed: z.boolean().optional().default(false),
}).strict();

export const promptActivationSchema = z.object({
  promptKey: z.enum(MANAGED_PROMPT_KEYS),
  expectedContentHash: hash,
  expectedSourceFingerprint: hash,
}).strict();

export const datasetExportSchema = z.object({
  datasetId: z.string().uuid(),
  split: z.enum(["development", "validation"]),
  expectedManifestHash: hash,
}).strict();

export const evaluationExportSchema = z.object({
  evaluationId: z.string().uuid(),
  expectedManifestHash: hash,
}).strict();

export const scoresExportSchema = z.union([
  evaluationExportSchema,
  z.object({ judgeRunId: z.string().uuid() }).strict(),
]);

export const annotationSyncSchema = z.object({ sourceRunId: z.string().uuid() }).strict();

export const annotationInboxQuerySchema = z.object({
  state: z.enum(["pending_review", "promoted", "rejected"]).optional(),
  sourceRunId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export const annotationReviewSchema = z.object({ expectedContentHash: hash }).strict();

export const annotationPromotionSchema = annotationReviewSchema.extend({
  artifactHash: hash,
  labelSet: trustedLabelSetSchema,
  supersedesAnnotationId: z.string().uuid().optional(),
  notes: z.string().trim().min(1).max(4_000).optional(),
}).strict();

export const syncJobListQuerySchema = z.object({
  status: z.enum(["queued", "running", "retry_wait", "succeeded", "dead_letter"]).optional(),
  kind: z.enum(["prompt_pull", "dataset_export", "evaluation_export", "annotation_queue",
    "annotation_pull", "scores_export"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export const syncJobRetrySchema = z.object({
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const qualityJudgeRequestSchema = judgeRequestSchema;
