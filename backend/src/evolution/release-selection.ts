import type { PoolClient } from "pg";

import { BASELINE_REVIEW_TEXT, reviewTextHashes, withReviewTextVersions } from "../agents/text-components.js";
import { evolutionCandidateSchema, evolutionProposalSourceSchema, type EvolutionCandidateV1 } from "./candidate-contracts.js";
import type { EvolutionReleaseRouting, EvolutionReleaseState } from "./release-contracts.js";
import { evolutionReleasePolicy, evolutionReleasePolicyHash } from "./release-policy.js";
import { REPLAY_VERIFIER_HASH } from "./replay-contracts.js";
import type { PublicationBinding } from "../agent-runtime/authority/publication-authority.js";
import type { ReviewRunInput } from "../review/intake/run-input.js";
import { fingerprint, type RunVersionManifest } from "../agent-runtime/versions.js";

export type DeepReleaseSelectionKind = "baseline" | "control" | "candidate";

export interface DeepReleaseSelectionRecord {
  tenantId: string; integrationId: string; assignmentVersion: number; routing: EvolutionReleaseRouting;
  selection: DeepReleaseSelectionKind; bucket: number; candidateId?: string; qualificationId?: string;
  releaseReceiptId?: string;
  reviewText: EvolutionCandidateV1; reviewTextHash: string; promptHash: string; toolHash: string; selectionHash: string;
}

export interface ResolvedDeepReleaseSelection {
  reviewText: EvolutionCandidateV1; manifest: RunVersionManifest;
  releaseSelection: Readonly<Record<string, unknown>>; record: DeepReleaseSelectionRecord;
}

interface SelectionRow {
  state: EvolutionReleaseState; routing: EvolutionReleaseRouting; version: string;
  candidate_id: string | null; qualification_id: string | null; fraction_bps: number; salt: string;
  release_receipt_id: string | null;
  release_receipt_evidence: Record<string, unknown> | null; release_receipt_evidence_hash: string | null;
  qualification_policy_hash: string | null; qualification_policy: Record<string, unknown> | null;
  qualification_evidence_hash: string | null;
  qualification_evidence: Record<string, unknown> | null;
  candidate_json: unknown; candidate_hash: string | null; source_json: unknown;
  proposal_run_id: string | null;
  validation_runtime_hash: string | null; holdout_runtime_hash: string | null;
  validation_model_hash: string | null; holdout_model_hash: string | null;
}

export async function resolveDeepReleaseSelection(client: PoolClient, input: {
  binding: PublicationBinding; reviewInput: ReviewRunInput; baseManifest: RunVersionManifest;
}): Promise<ResolvedDeepReleaseSelection> {
  const reviewInput = input.reviewInput;
  assertReviewScope(input.binding, reviewInput);
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,1830))", [input.binding.tenantId]);
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,2001))",
    [`${input.binding.tenantId}:${input.binding.id}`]);
  const row = (await client.query<SelectionRow>(
    `SELECT a.state,a.routing,a.version,a.candidate_id,a.qualification_id,a.fraction_bps,a.salt,
            rr.id AS release_receipt_id,rr.evidence_json AS release_receipt_evidence,
            rr.evidence_hash AS release_receipt_evidence_hash,
            q.policy_hash AS qualification_policy_hash,q.policy_json AS qualification_policy,
            q.evidence_hash AS qualification_evidence_hash,
            q.evidence_json AS qualification_evidence,
            c.candidate_json,c.candidate_hash,ps.source_json,pr.id AS proposal_run_id,
            v.runtime_version_hash AS validation_runtime_hash,h.runtime_version_hash AS holdout_runtime_hash,
            v.model_version_hash AS validation_model_hash,h.model_version_hash AS holdout_model_hash
     FROM pr_agent_harness.evolution_release_assignments a
     LEFT JOIN pr_agent_harness.evolution_release_qualifications q
       ON q.tenant_id=a.tenant_id AND q.integration_id=a.integration_id AND q.id=a.qualification_id
     LEFT JOIN pr_agent_harness.evolution_candidates c
       ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.content_purged_at IS NULL
     LEFT JOIN pr_agent_harness.evolution_proposal_sources ps
       ON ps.tenant_id=c.tenant_id AND ps.proposal_run_id=c.proposal_run_id AND ps.content_purged_at IS NULL
     LEFT JOIN pr_agent_harness.agent_runs pr
       ON pr.tenant_id=c.tenant_id AND pr.id=c.proposal_run_id
        AND pr.run_type='evolution.propose.v1' AND pr.status='succeeded'
     LEFT JOIN pr_agent_harness.eval_runs v
       ON v.tenant_id=q.tenant_id AND v.id=q.validation_evaluation_id AND v.status='succeeded'
     LEFT JOIN pr_agent_harness.eval_runs h
       ON h.tenant_id=q.tenant_id AND h.id=q.holdout_evaluation_id AND h.status='succeeded'
     LEFT JOIN pr_agent_harness.evolution_release_receipts rr
       ON rr.tenant_id=a.tenant_id AND rr.integration_id=a.integration_id AND rr.assignment_version=a.version
     WHERE a.tenant_id=$1 AND a.integration_id=$2 FOR SHARE OF a`, [input.binding.tenantId, input.binding.id])).rows[0];
  const policy = evolutionReleasePolicy();
  if (!row || !policy.activationEnabled || row.routing === "off" || row.state === "rolled_back") {
    return baselineSelection({ ...input, input: reviewInput }, row ? Number(row.version) : 0, row?.routing ?? "off",
      !row ? "no_assignment" : !policy.activationEnabled ? "activation_disabled" : "routing_off", row?.salt);
  }
  const qualified = validateQualifiedSelection(row, input.baseManifest, evolutionReleasePolicyHash(policy));
  if (!qualified || !await qualificationPinsCurrent(client, input.binding.tenantId,
    row.qualification_id!, input.baseManifest,
    qualified.baseline, qualified.candidate)) {
    return baselineSelection({ ...input, input: reviewInput }, Number(row.version), row.routing, "qualification_stale", row.salt);
  }
  const bucket = releaseBucket({ tenantId: input.binding.tenantId, integrationId: input.binding.id,
    sourceKey: reviewInput.source.key, headSha: reviewInput.revision.headSha,
    assignmentVersion: Number(row.version), routingSalt: row.salt });
  let selection: DeepReleaseSelectionKind;
  if (row.routing === "shadow") selection = "candidate";
  else if (row.routing === "full") selection = "candidate";
  else if (row.routing === "canary") selection = bucket < row.fraction_bps ? "candidate" : "control";
  else return baselineSelection({ ...input, input: reviewInput }, Number(row.version), row.routing, "unsupported_routing", row.salt);
  const reviewText = selection === "candidate" ? qualified.candidate : qualified.baseline;
  return selected(input, { assignmentVersion: Number(row.version), routing: row.routing, selection, bucket,
    candidateId: row.candidate_id!, qualificationId: row.qualification_id!,
    releaseReceiptId: row.release_receipt_id!, reviewText });
}

export async function recordDeepReleaseSelection(client: PoolClient, runId: string,
  record: DeepReleaseSelectionRecord): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO pr_agent_harness.evolution_run_assignments
       (tenant_id,integration_id,run_id,assignment_version,routing,selection,bucket,candidate_id,qualification_id,
        release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
     ON CONFLICT (tenant_id,run_id) DO NOTHING RETURNING run_id`,
    [record.tenantId, record.integrationId, runId, record.assignmentVersion, record.routing, record.selection,
      record.bucket, record.candidateId ?? null, record.qualificationId ?? null, record.releaseReceiptId ?? null,
      JSON.stringify(record.reviewText), record.reviewTextHash, record.promptHash, record.toolHash, record.selectionHash]);
  if (inserted.rowCount) return;
  const existing = await client.query<{ selection_hash: string }>(
    `SELECT selection_hash FROM pr_agent_harness.evolution_run_assignments
     WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3`, [record.tenantId, record.integrationId, runId]);
  if (existing.rows[0]?.selection_hash !== record.selectionHash) throw new Error("Run release selection is immutable");
}

export function releaseBucket(input: { tenantId: string; integrationId: string; sourceKey: string; headSha: string;
  assignmentVersion: number; routingSalt: string }): number {
  return Number(BigInt(`0x${fingerprint(input).slice(0, 16)}`) % 10_000n);
}

function validateQualifiedSelection(row: SelectionRow, baseManifest: RunVersionManifest,
  policyHash: string): { candidate: EvolutionCandidateV1; baseline: EvolutionCandidateV1 } | undefined {
  if (!row.candidate_id || !row.qualification_id || !row.release_receipt_id
      || !row.release_receipt_evidence
      || fingerprint(row.release_receipt_evidence) !== row.release_receipt_evidence_hash
      || row.release_receipt_evidence.qualificationEvidenceHash !== row.qualification_evidence_hash
      || row.release_receipt_evidence.policyHash !== policyHash
      || !row.qualification_evidence || !row.candidate_json
      || !row.source_json || !row.candidate_hash || !row.proposal_run_id
      || row.qualification_policy_hash !== policyHash || !row.qualification_policy
      || fingerprint(row.qualification_policy) !== row.qualification_policy_hash
      || fingerprint(row.qualification_evidence) !== row.qualification_evidence_hash
      || (row.state === "evaluated_experimental") !== (row.routing === "shadow")
      || (row.state === "approved_canary") !== (row.routing === "canary")
      || (row.state === "promoted") !== (row.routing === "full")
      || row.validation_runtime_hash !== baseManifest.runtimeVersionHash
      || row.holdout_runtime_hash !== baseManifest.runtimeVersionHash
      || row.validation_model_hash !== baseManifest.modelVersionHash
      || row.holdout_model_hash !== baseManifest.modelVersionHash) return undefined;
  const candidate = evolutionCandidateSchema.parse(row.candidate_json);
  if (fingerprint(candidate) !== row.candidate_hash) return undefined;
  const source = evolutionProposalSourceSchema.parse(row.source_json);
  const baseline = evolutionCandidateSchema.parse({ schemaVersion: 1, prompt_text: source.baselinePromptText,
    tool_description_text: source.baselineToolDescriptionText });
  const currentBaseline = reviewTextHashes(BASELINE_REVIEW_TEXT);
  const frozenBaseline = reviewTextHashes(baseline);
  const evidence = row.qualification_evidence;
  if (currentBaseline.contentHash !== frozenBaseline.contentHash || evidence.candidateId !== row.candidate_id
      || evidence.baselineComponentHash !== frozenBaseline.contentHash
      || evidence.candidateComponentHash !== reviewTextHashes(candidate).contentHash) return undefined;
  return { candidate, baseline };
}

async function qualificationPinsCurrent(client: PoolClient, tenantId: string, qualificationId: string, base: RunVersionManifest,
  baseline: EvolutionCandidateV1, candidate: EvolutionCandidateV1): Promise<boolean> {
  const baselineManifest = withReviewTextVersions(base, baseline);
  const candidateManifest = withReviewTextVersions(base, candidate);
  const result = await client.query(
    `SELECT 1 FROM pr_agent_harness.evolution_release_qualifications q
     WHERE q.tenant_id=$2 AND q.id=$1
       AND EXISTS (SELECT 1 FROM pr_agent_harness.eval_results x
         WHERE x.tenant_id=q.tenant_id AND x.eval_run_id IN (q.validation_evaluation_id,q.holdout_evaluation_id))
       AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.eval_results x
         WHERE x.tenant_id=q.tenant_id AND x.eval_run_id IN (q.validation_evaluation_id,q.holdout_evaluation_id)
           AND (x.expected_workflow_hash<>$3 OR x.expected_model_hash<>$4 OR x.expected_policy_hash<>$5
             OR x.expected_runtime_hash<>$6 OR x.expected_verifier_hash<>$7
             OR (x.variant='baseline' AND (x.expected_prompt_hash<>$8 OR x.expected_tool_hash<>$9))
             OR (x.variant='candidate' AND (x.expected_prompt_hash<>$10 OR x.expected_tool_hash<>$11))))
       AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.eval_cases c
         LEFT JOIN pr_agent_harness.trusted_review_label_sets l
           ON l.tenant_id=c.tenant_id AND l.id=c.label_set_id AND l.label_set_hash=c.label_set_hash
         WHERE c.tenant_id=q.tenant_id AND c.dataset_id=q.dataset_id
           AND (c.content_purged_at IS NOT NULL OR l.id IS NULL OR NOT l.active OR l.content_purged_at IS NOT NULL))`,
    [qualificationId, tenantId, base.workflowVersionHash, base.modelVersionHash, base.policyVersionHash,
      base.runtimeVersionHash, REPLAY_VERIFIER_HASH, baselineManifest.promptVersionHash,
      baselineManifest.toolVersionHash, candidateManifest.promptVersionHash, candidateManifest.toolVersionHash]);
  return Boolean(result.rowCount);
}

function baselineSelection(input: { binding: PublicationBinding; input: ReviewRunInput; baseManifest: RunVersionManifest },
  assignmentVersion: number, routing: EvolutionReleaseRouting, reason: string, routingSalt = "baseline"): ResolvedDeepReleaseSelection {
  return selected(input, { assignmentVersion, routing, selection: "baseline", bucket: releaseBucket({
    tenantId: input.binding.tenantId, integrationId: input.binding.id, sourceKey: input.input.source.key,
    headSha: input.input.revision.headSha, assignmentVersion, routingSalt }),
  reviewText: BASELINE_REVIEW_TEXT, reason });
}

function selected(input: { binding: PublicationBinding; baseManifest: RunVersionManifest }, value: {
  assignmentVersion: number; routing: EvolutionReleaseRouting; selection: DeepReleaseSelectionKind; bucket: number;
  candidateId?: string; qualificationId?: string; reviewText: EvolutionCandidateV1; reason?: string;
  releaseReceiptId?: string;
}): ResolvedDeepReleaseSelection {
  const hashes = reviewTextHashes(value.reviewText);
  const selectionHash = fingerprint({ schemaVersion: 1, tenantId: input.binding.tenantId,
    integrationId: input.binding.id, assignmentVersion: value.assignmentVersion, routing: value.routing,
    selection: value.selection, bucket: value.bucket, candidateId: value.candidateId ?? null,
    qualificationId: value.qualificationId ?? null, releaseReceiptId: value.releaseReceiptId ?? null,
    reviewTextHash: hashes.contentHash, reason: value.reason ?? null });
  const releaseSelection = Object.freeze({ schemaVersion: 1, assignmentVersion: value.assignmentVersion,
    routing: value.routing, selection: value.selection, bucket: value.bucket, candidateId: value.candidateId ?? null,
    qualificationId: value.qualificationId ?? null, releaseReceiptId: value.releaseReceiptId ?? null,
    reviewTextHash: hashes.contentHash,
    selectionHash, reason: value.reason ?? null });
  return { reviewText: value.reviewText, manifest: withReviewTextVersions(input.baseManifest, value.reviewText),
    releaseSelection, record: { tenantId: input.binding.tenantId, integrationId: input.binding.id,
      assignmentVersion: value.assignmentVersion, routing: value.routing, selection: value.selection,
      bucket: value.bucket, ...(value.candidateId ? { candidateId: value.candidateId } : {}),
      ...(value.qualificationId ? { qualificationId: value.qualificationId } : {}), reviewText: value.reviewText,
      ...(value.releaseReceiptId ? { releaseReceiptId: value.releaseReceiptId } : {}),
      reviewTextHash: hashes.contentHash, promptHash: hashes.promptHash, toolHash: hashes.toolHash, selectionHash } };
}

function assertReviewScope(binding: PublicationBinding, input: ReviewRunInput): void {
  if (input.workflow !== "review.deep.v1" || input.platform !== binding.platform
      || input.target.origin !== binding.origin || input.target.repository !== binding.repository
      || input.target.providerRepositoryId !== binding.providerRepositoryId) {
    throw new Error("Release selection requires an exact deep-review integration scope");
  }
}
