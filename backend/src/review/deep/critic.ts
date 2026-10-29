import { z } from "zod";

import { canonicalJson, fingerprint } from "../../agent-runtime/versions.js";
import { composeReviewSystemPrompt, frozenReviewText } from "../strategy/text-components.js";
import type {
  CriticDecision,
  DeepWorkflowContext,
  DeepWorkflowPolicy,
  FindingCandidate,
  RoleCoverage,
} from "./contracts.js";

const criticDecisionSchema = z.object({
  candidateId: z.string().min(1).max(256),
  decision: z.enum(["accept", "reject", "needs_more_evidence"]),
  reasonCode: z.string().min(1).max(128),
  duplicateOfCandidateId: z.string().min(1).max(256).nullable().optional(),
}).strict().transform(({ duplicateOfCandidateId, ...decision }) =>
  duplicateOfCandidateId ? { ...decision, duplicateOfCandidateId } : decision);

export const deepCriticResponseSchema = z.object({
  decisions: z.array(criticDecisionSchema).max(40),
}).strict();

export const deepCriticJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "decision", "reasonCode", "duplicateOfCandidateId"],
        properties: {
          candidateId: { type: "string" },
          decision: { type: "string", enum: ["accept", "reject", "needs_more_evidence"] },
          reasonCode: { type: "string" },
          duplicateOfCandidateId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  },
} as const;

export async function runDeepReviewCritic(input: {
  candidates: readonly FindingCandidate[];
  coverage: readonly RoleCoverage[];
  context: DeepWorkflowContext;
  policy: DeepWorkflowPolicy;
}): Promise<CriticDecision[]> {
  const candidates = input.candidates.slice(0, input.policy.criticInputCandidateLimit);
  const signal = input.context.signal
    ? AbortSignal.any([input.context.signal, AbortSignal.timeout(input.policy.criticLimits.maxWallTimeMs)])
    : AbortSignal.timeout(input.policy.criticLimits.maxWallTimeMs);
  const prompt = canonicalJson({ candidates, coverage: input.coverage,
    instruction: "Return one decision per candidate ID. You may not add, rewrite, or relocate candidates." });
  const systemPrompt = composeReviewSystemPrompt("You are a restricted review critic. Decide only on supplied candidate IDs. " +
    "Reject duplicates and request more evidence when support is insufficient. Return strict JSON only.",
  frozenReviewText(input.context.lease.runtimeConfig));
  const result = await input.context.step(
    "deep.critic",
    "model",
    fingerprint({ candidates, coverage: input.coverage, systemPrompt, limits: input.policy.criticLimits }),
    () => input.context.model.generate({
      schemaName: "deep_review_critic",
      jsonSchema: deepCriticJsonSchema as unknown as Record<string, unknown>,
      schema: deepCriticResponseSchema,
      systemPrompt,
      prompt,
      role: "critic",
      turn: 1,
      maxInputBytes: input.policy.criticLimits.maxInputBytes,
      maxOutputTokens: input.policy.criticLimits.maxOutputTokens,
      signal,
    }),
  );
  const allowed = new Set(candidates.map(({ id }) => id));
  const decisions = result.decisions.filter((decision) => {
    const duplicate = "duplicateOfCandidateId" in decision ? decision.duplicateOfCandidateId : undefined;
    return allowed.has(decision.candidateId) && (!duplicate || allowed.has(duplicate));
  });
  const stepKey = "deep.critic.decisions";
  const saved = await input.context.step(stepKey, "coordination", fingerprint(decisions), async () => decisions);
  await input.context.store.registerDecisions(input.context.lease, stepKey, "critic", saved);
  return saved;
}
