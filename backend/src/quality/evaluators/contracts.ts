import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText = z.string().trim().min(1).max(2_000);

export const judgeRequestSchema = z.object({
  sourceRunId: z.string().uuid(),
  expectedArtifactHash: hash,
}).strict();
export type JudgeRequest = z.infer<typeof judgeRequestSchema>;

export const judgeRubricSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.literal("review-finding-support-v1"),
  evidenceScale: z.object({ min: z.literal(0), max: z.literal(4) }).strict(),
  actionabilityScale: z.object({ min: z.literal(0), max: z.literal(4) }).strict(),
  instructions: z.array(z.string().min(1).max(1_000)).min(1).max(12),
}).strict();
export type JudgeRubric = z.infer<typeof judgeRubricSchema>;

export const JUDGE_RUBRIC: JudgeRubric = freezeRubric(judgeRubricSchema.parse({
  schemaVersion: 1,
  name: "review-finding-support-v1",
  evidenceScale: { min: 0, max: 4 },
  actionabilityScale: { min: 0, max: 4 },
  instructions: [
    "supported means the frozen source directly substantiates the finding; unsupported means it contradicts or does not substantiate it; uncertain means the bounded source cannot decide.",
    "Evidence score: 0=no evidence, 1=weakly related, 2=partial, 3=strong, 4=direct and sufficient.",
    "Actionability score: 0=not actionable, 1=vague, 2=partly actionable, 3=clear remediation, 4=precise and safely actionable.",
    "Do not infer repository state, tests, runtime behavior, or external facts absent from the frozen source.",
  ],
}));

const findingSchema = z.object({
  id: hash,
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(4_000),
  location: z.object({
    path: z.string().min(1).max(1_024),
    side: z.enum(["old", "new"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).strict(),
  evidenceIds: z.array(hash).min(1).max(20),
}).strict();

export const judgeSourceSchema = z.object({
  schemaVersion: z.literal(1),
  sourceRunId: z.string().uuid(),
  sourceArtifactHash: hash,
  collectionHash: hash,
  repository: z.string().min(1).max(512),
  baseSha: z.string().min(1).max(128),
  headSha: z.string().min(1).max(128),
  findings: z.array(findingSchema).max(20),
  collection: z.record(z.unknown()),
  sourceHash: hash,
}).strict();
export type JudgeSource = z.infer<typeof judgeSourceSchema>;

const modelJudgmentSchema = z.object({
  findingId: hash,
  judgment: z.enum(["supported", "unsupported", "uncertain"]),
  evidenceScore: z.number().int().min(0).max(4),
  actionabilityScore: z.number().int().min(0).max(4),
  reason: boundedText,
}).strict();

export const judgeModelResultSchema = z.object({
  judgments: z.array(modelJudgmentSchema).max(20),
  summary: boundedText,
}).strict();
export type JudgeModelResult = z.infer<typeof judgeModelResultSchema>;

export const judgeModelJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["judgments", "summary"],
  properties: {
    judgments: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "judgment", "evidenceScore", "actionabilityScore", "reason"],
        properties: {
          findingId: { type: "string", pattern: "^[a-f0-9]{64}$" },
          judgment: { type: "string", enum: ["supported", "unsupported", "uncertain"] },
          evidenceScore: { type: "integer", minimum: 0, maximum: 4 },
          actionabilityScore: { type: "integer", minimum: 0, maximum: 4 },
          reason: { type: "string", minLength: 1, maxLength: 2_000 },
        },
      },
    },
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
  },
} as const;

export const judgeResultSchema = judgeModelResultSchema.extend({
  schemaVersion: z.literal(1),
  workflow: z.literal("eval.judge.v1"),
  judgeRunId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  sourceArtifactHash: hash,
  sourceHash: hash,
  promptVersionHash: hash,
  modelVersionHash: hash,
  rubricHash: hash,
}).strict();
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export const judgePolicySchema = z.object({
  schemaVersion: z.literal(1),
  maxFindings: z.literal(20),
  maxInputBytes: z.number().int().positive().max(128 * 1024),
  maxOutputTokens: z.number().int().positive().max(4_096),
  maxRunMs: z.number().int().positive().max(15 * 60_000),
  rubric: judgeRubricSchema,
  rubricHash: hash,
}).strict();

export const judgeRunInputSchema = z.object({
  schemaVersion: z.literal(1),
  workflow: z.literal("eval.judge.v1"),
  sourceRunId: z.string().uuid(),
  expectedArtifactHash: hash,
  sourceHash: hash,
}).strict();

function freezeRubric(rubric: JudgeRubric): JudgeRubric {
  Object.freeze(rubric.evidenceScale);
  Object.freeze(rubric.actionabilityScale);
  Object.freeze(rubric.instructions);
  return Object.freeze(rubric);
}
