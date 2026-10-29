import { reviewTextHashes, withReviewTextVersions } from "../agents/text-components.js";
import { evolutionCandidateSchema, evolutionProposalSourceSchema, type EvolutionCandidateV1 } from "./candidate-contracts.js";
import { createEvaluationSchema, REPLAY_VERIFIER_HASH, type EvaluationReceipt, type ReplayRunInput } from "./replay-contracts.js";
import { EvaluationStore, type PendingReplayResult } from "./replay-store.js";
import type { PublicationBinding } from "../agent-runtime/authority/publication-authority.js";
import { freezeDeepBudget } from "../review/deep/budget.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction } from "../agent-runtime/budget/model-budget-store.js";
import type { RuntimeDatabase } from "../agent-runtime/postgres/database.js";
import type { CreateRunInput } from "../agent-runtime/postgres/run-store.js";
import type { RunPrincipal } from "../agent-runtime/runs/control-contracts.js";
import { requireRunPermission, RunControlError } from "../agent-runtime/runs/control-contracts.js";
import { fingerprint, AGENT_RUNTIME_CONFIG, runtimeVersionManifest } from "../agent-runtime/versions.js";
import { resolveModelConfiguration } from "../review/ai-reviewer.js";

export class ReplayAdmissionManifestDriftError extends Error {
  constructor() { super("Replay component or model manifest drifted before child admission");
    this.name = "ReplayAdmissionManifestDriftError"; }
}

export async function admitEvaluation(input: { db: RuntimeDatabase; principal: RunPrincipal;
  commandKey: string; request: unknown }): Promise<EvaluationReceipt> {
  const request = createEvaluationSchema.parse(input.request);
  requireRunPermission(input.principal, "evaluations:create");
  if (request.split === "holdout") requireRunPermission(input.principal, "evaluations:holdout");
  const frozen = await input.db.transaction(input.principal.tenantId, async (client) => {
    const row = await client.query<{ candidate_json: EvolutionCandidateV1; source_json: unknown }>(
      `SELECT c.candidate_json,s.source_json FROM pr_agent_harness.evolution_candidates c
       JOIN pr_agent_harness.evolution_proposal_sources s
         ON s.tenant_id=c.tenant_id AND s.proposal_run_id=c.proposal_run_id AND s.content_purged_at IS NULL
       JOIN pr_agent_harness.agent_runs r
         ON r.tenant_id=c.tenant_id AND r.id=c.proposal_run_id
          AND r.run_type='evolution.propose.v1' AND r.status='succeeded'
       WHERE c.tenant_id=$1 AND c.id=$2 AND c.dataset_id=$3 AND c.created_by_actor_type=$4
         AND c.created_by_actor_id=$5 AND c.content_purged_at IS NULL`,
      [input.principal.tenantId, request.candidateId, request.datasetId,
        input.principal.actorType, input.principal.subjectId]);
    if (!row.rows[0]) throw new RunControlError("CANDIDATE_NOT_FOUND", 404, "Evolution candidate was not found");
    const source = evolutionProposalSourceSchema.parse(row.rows[0].source_json);
    return { candidate: evolutionCandidateSchema.parse(row.rows[0].candidate_json),
      baseline: { schemaVersion: 1 as const, prompt_text: source.baselinePromptText,
        tool_description_text: source.baselineToolDescriptionText } };
  });
  const { provider, model } = resolveModelConfiguration();
  const policy = getModelExecutionPolicy(provider, model);
  const base = await runtimeVersionManifest(policy);
  const baselineManifest = withReviewTextVersions(base, frozen.baseline);
  const candidateManifest = withReviewTextVersions(base, frozen.candidate);
  if (baselineManifest.modelVersionHash !== candidateManifest.modelVersionHash
      || baselineManifest.runtimeVersionHash !== candidateManifest.runtimeVersionHash) {
    throw new Error("Evaluation variants must share model and runtime versions");
  }
  const baselineHashes = reviewTextHashes(frozen.baseline);
  return new EvaluationStore(input.db).admit(input.principal, { ...request, commandKey: input.commandKey,
    requestHash: fingerprint(request), baselineComponentHash: baselineHashes.contentHash,
    candidateComponentHash: reviewTextHashes(frozen.candidate).contentHash,
    baselinePromptHash: baselineHashes.promptHash, baselineToolHash: baselineHashes.toolHash,
    modelConfigHash: fingerprint(policy), baselineManifest, candidateManifest });
}

export async function buildReplayRunCreationInput(binding: PublicationBinding, result: PendingReplayResult): Promise<CreateRunInput> {
  if (binding.id !== result.integrationId) throw new Error("Replay result binding mismatch");
  const { provider, model } = resolveModelConfiguration();
  const policy = getModelExecutionPolicy(provider, model);
  const base = await runtimeVersionManifest(policy);
  const reviewText = result.variant === "baseline"
    ? evolutionCandidateSchema.parse(result.baselineText) : evolutionCandidateSchema.parse(result.candidateText);
  const manifest = withReviewTextVersions(base, reviewText);
  if (manifest.workflowVersionHash !== result.expectedWorkflowHash || manifest.promptVersionHash !== result.expectedPromptHash
      || manifest.modelVersionHash !== result.expectedModelHash || manifest.toolVersionHash !== result.expectedToolHash
      || manifest.policyVersionHash !== result.expectedPolicyHash || manifest.runtimeVersionHash !== result.expectedRuntimeHash
      || reviewTextHashes(reviewText).contentHash !== result.componentHash) {
    throw new ReplayAdmissionManifestDriftError();
  }
  const replayInput: ReplayRunInput = { schemaVersion: 1, workflow: "eval.replay.v1",
    evaluationId: result.evaluationId, resultId: result.id, datasetId: result.datasetId, caseId: result.caseId,
    candidateId: result.candidateId, variant: result.variant, repetition: result.repetition,
    samplingMode: "unseeded", attemptIdentityHash: result.attemptIdentityHash, fixtureHash: result.fixtureHash,
    labelSetId: result.labelSetId, labelSetHash: result.labelSetHash, componentHash: result.componentHash,
    verifierHash: REPLAY_VERIFIER_HASH };
  return { tenantId: binding.tenantId, integrationId: binding.id, actorType: "system", actorId: "evaluation-coordinator",
    createScope: `eval.replay.v1:${result.evaluationId}`, createKey: result.id, requestHash: fingerprint(replayInput),
    runType: "eval.replay.v1", baseSha: result.baseSha, headSha: result.headSha, ...manifest,
    input: replayInput, authorityGeneration: binding.generation,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    runtimeConfig: { ...AGENT_RUNTIME_CONFIG, modelPolicy: policy, deepBudget: freezeDeepBudget(policy.runLimits), reviewText },
    limits: { maxRunMs: AGENT_RUNTIME_CONFIG.maxRunMs, maxJobAttempts: AGENT_RUNTIME_CONFIG.maxJobAttempts,
      maxStepAttempts: AGENT_RUNTIME_CONFIG.maxStepAttempts, model: policy.runLimits },
    admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId: binding.tenantId, runId, policy }) };
}
