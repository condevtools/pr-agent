import { fingerprint } from "../harness/versions.js";
import { RunCheckpointCompatibilityError, RunLeaseLostError } from "../harness/run-contracts.js";
import type {
  CoverageStatus,
  DeepReviewArtifact,
  DeepReviewSource,
  DeepWorkflowContext,
  DeepWorkflowPolicy,
  GateDecision,
  ReviewWorkflow,
} from "./contracts.js";
import { runDeepReviewCritic } from "./critic.js";
import { gateDeepReviewFindings } from "./gate.js";
import { runDeepReviewRole } from "./role-loop.js";

export function createDeepReviewWorkflow(): ReviewWorkflow {
  return {
    id: "review.deep.v1",
    publicationMode: "shadow",
    execute: executeDeepReview,
  };
}

export const deepReviewWorkflow = createDeepReviewWorkflow();

export async function executeDeepReview(
  source: DeepReviewSource,
  context: DeepWorkflowContext,
  policy: DeepWorkflowPolicy,
): Promise<DeepReviewArtifact> {
  assertFixedIdentity(source, context);
  const recovered = await context.store.loadArtifact(context.lease);
  if (recovered) return recovered;
  const settledRoles = await Promise.allSettled([
    runDeepReviewRole({ role: "security", source, context, limits: policy.roleLimits.security }),
    runDeepReviewRole({ role: "correctness", source, context, limits: policy.roleLimits.correctness }),
  ]);
  const failed = settledRoles.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  const roles = settledRoles.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof runDeepReviewRole>>>).value);
  const candidates = roles.flatMap(({ candidates: records }) => records);
  let criticFailed = false;
  const criticDecisions = await runDeepReviewCritic({
    candidates, coverage: roles.map(({ coverage }) => coverage), context, policy,
  }).catch((error: unknown) => {
    if (context.signal?.aborted || error instanceof RunLeaseLostError
        || error instanceof RunCheckpointCompatibilityError
        || (isRetryableModelError(error) && hasJobRetryRemaining(context))) throw error;
    criticFailed = true;
    return [];
  });
  const evidenceIds = [...new Set(candidates.flatMap((candidate) =>
    [...candidate.evidenceIds, ...candidate.crossFileEvidenceIds]))];
  const evidence = await context.store.loadUsableEvidence(context.lease, evidenceIds);
  const gateDecisions = await persistGateDecisions(source, context, candidates, criticDecisions, evidence);
  const analysisStatus = resolveAnalysisStatus(source, roles.map(({ coverage }) => coverage.status),
    criticFailed, gateDecisions);
  const artifact: DeepReviewArtifact = {
    workflowId: "review.deep.v1",
    publicationMode: "shadow",
    identity: source.identity,
    sourceCoverage: source.coverage,
    analysisStatus,
    verdict: analysisStatus !== "complete"
      ? "incomplete"
      : gateDecisions.some(({ accepted }) => accepted) ? "findings" : "no_findings",
    candidates,
    criticDecisions,
    gateDecisions,
    coverage: roles.map(({ coverage }) => coverage),
  };
  await context.store.saveArtifact(context.lease, artifact);
  return artifact;
}

function hasJobRetryRemaining(context: DeepWorkflowContext): boolean {
  const configured = context.lease.runtimeConfig.maxJobAttempts;
  const maximum = Number.isSafeInteger(configured) && Number(configured) > 0 ? Number(configured) : 3;
  return context.lease.jobAttempt < maximum;
}

function isRetryableModelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /\b(timeout|timed out|econnreset|socket hang up)\b/i.test(error.message);
}

async function persistGateDecisions(
  source: DeepReviewSource,
  context: DeepWorkflowContext,
  candidates: Parameters<typeof gateDeepReviewFindings>[0]["candidates"],
  criticDecisions: Parameters<typeof gateDeepReviewFindings>[0]["criticDecisions"],
  evidence: Parameters<typeof gateDeepReviewFindings>[0]["evidence"],
): Promise<GateDecision[]> {
  const decisions = gateDeepReviewFindings({ source, candidates, criticDecisions, evidence });
  const stepKey = "deep.gate";
  const saved = await context.step(stepKey, "verification",
    fingerprint({ candidates, criticDecisions, decisions }), async () => decisions);
  await context.store.registerDecisions(context.lease, stepKey, "gate", saved);
  return saved;
}

function assertFixedIdentity(source: DeepReviewSource, context: DeepWorkflowContext): void {
  const lease = context.lease;
  const identity = source.identity;
  if (identity.tenantId !== lease.tenantId || identity.integrationId !== lease.integrationId
      || identity.runId !== lease.runId || identity.baseSha !== lease.baseSha
      || identity.headSha !== lease.headSha) {
    throw new Error("Deep review identity does not match the fixed Run lease");
  }
}

function resolveAnalysisStatus(
  source: DeepReviewSource,
  roles: readonly CoverageStatus[],
  criticFailed: boolean,
  decisions: readonly GateDecision[],
): CoverageStatus {
  if (roles.every((status) => status === "failed")) return "failed";
  if (source.coverage.status !== "complete" || roles.some((status) => status !== "complete") || criticFailed) {
    return "partial";
  }
  if (decisions.some(({ reasonCode }) => incompleteReason(reasonCode))) return "partial";
  return "complete";
}

function incompleteReason(reason: GateDecision["reasonCode"]): boolean {
  return reason !== "accepted" && reason !== "critic_rejected";
}
