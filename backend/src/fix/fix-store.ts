import type { PoolClient } from "pg";

import type {
  ConsumeFixApprovalInput,
  CreateFixPublishRun,
  CreateFixRelevanceAttestationInput,
  CreateFixApprovalInput,
  DecideFixApprovalInput,
  EnqueueVerificationJob,
  FixApprovalReceipt,
  FixArtifact,
  FixProposal,
  FixRelevanceAttestation,
  FixSource,
  FixStore as FixStorePort,
  VerificationResult,
} from "./contracts.js";
import { isFixDifferentialEligible } from "./verification-gate.js";
import { RuntimeDatabase } from "../agent-runtime/postgres/database.js";
import { assertRunLease } from "../agent-runtime/execution/store.js";
import type { RunLease } from "../agent-runtime/runs/contracts.js";
import { fingerprint } from "../agent-runtime/versions.js";
import { verificationResultSchema } from "./fix-input.js";
import type { RunPrincipal } from "../agent-runtime/runs/control-contracts.js";
import { requireRunPermission, runNotFound } from "../agent-runtime/runs/control-contracts.js";
import { redactRepositoryText } from "../integrations/shared/repository-read-tools.js";

export class FixStoreError extends Error {
  constructor(readonly code: string) { super(`fix store rejected operation: ${code}`); this.name = "FixStoreError"; }
}

export class PgFixStore implements FixStorePort {
  constructor(private readonly db: RuntimeDatabase, private readonly enqueueJob?: EnqueueVerificationJob) {}

  async registerSource(lease: RunLease, source: FixSource): Promise<void> {
    assertSourceLease(lease, source);
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const accepted = await client.query<{ gate_decision_id: string; candidate_json: unknown; platform: string; repository: string }>(
        `SELECT d.id AS gate_decision_id,c.record_json AS candidate_json,b.platform,b.repository
         FROM pr_agent_harness.agent_runs sr
         JOIN pr_agent_harness.integration_bindings b ON b.tenant_id=sr.tenant_id AND b.id=sr.integration_id
         JOIN pr_agent_harness.finding_candidates c ON c.tenant_id=sr.tenant_id AND c.run_id=sr.id AND c.id=$4 AND c.content_purged_at IS NULL
         JOIN pr_agent_harness.finding_decisions d ON d.tenant_id=c.tenant_id AND d.run_id=c.run_id AND d.candidate_id=c.id
           AND d.stage='gate' AND d.content_purged_at IS NULL AND d.record_json->>'accepted'='true'
         JOIN pr_agent_harness.review_artifacts a ON a.tenant_id=sr.tenant_id AND a.run_id=sr.id AND a.content_purged_at IS NULL
         WHERE sr.tenant_id=$1 AND sr.integration_id=$2 AND sr.id=$3 AND sr.run_type='review.deep.v1'
           AND sr.status='succeeded' AND sr.base_sha=$5 AND sr.head_sha=$6`,
        [lease.tenantId, lease.integrationId, source.sourceReviewRunId, source.findingId, source.baseSha, source.headSha],
      );
      const row = accepted.rows[0];
      if (!row || row.platform !== source.platform || row.repository !== source.repository) {
        throw new FixStoreError("source_finding_not_accepted");
      }
      // Candidate projections contain role/evidence fields; compare the trusted source projection explicitly.
      if (!candidateMatchesSource(row.candidate_json, source)) throw new FixStoreError("source_finding_not_accepted");
      const contentHash = fingerprint(source);
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.fix_run_sources
           (tenant_id,integration_id,run_id,source_review_run_id,finding_id,repository,base_sha,head_sha,
            source_bundle_ref,source_bundle_hash,allowed_paths_json,source_json,content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
         ON CONFLICT (tenant_id,run_id) DO NOTHING RETURNING run_id`,
        [lease.tenantId, lease.integrationId, lease.runId, source.sourceReviewRunId, source.findingId,
          source.repository, source.baseSha, source.headSha, source.sourceBundleRef, source.sourceBundleHash,
          JSON.stringify(source.allowedPaths), JSON.stringify(source), contentHash],
      );
      if (!inserted.rowCount) await assertImmutable(client, "fix_run_sources", lease.tenantId, lease.runId, contentHash);
      await client.query(
        `INSERT INTO pr_agent_harness.fix_run_findings
           (tenant_id,run_id,source_review_run_id,finding_id,gate_decision_id,finding_hash)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,run_id,finding_id) DO NOTHING`,
        [lease.tenantId, lease.runId, source.sourceReviewRunId, source.findingId, row!.gate_decision_id, fingerprint(source.finding)],
      );
    });
  }

  async registerProposal(lease: RunLease, stepKey: string, proposal: FixProposal): Promise<void> {
    assertProposalLease(lease, proposal);
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const step = await successfulStep(client, lease, stepKey, "verification");
      if (fingerprint(step.output) !== fingerprint(proposal)) throw new FixStoreError("proposal_step_output_mismatch");
      const contentHash = fingerprint(proposal);
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.fix_proposals
           (id,tenant_id,integration_id,run_id,source_review_run_id,finding_id,revision,repository,base_sha,head_sha,
            source_bundle_ref,source_bundle_hash,code_patch,test_patch,code_patch_hash,test_patch_hash,proposal_hash,
            policy_id,policy_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,publisher_policy_hash,
            qualification_status,proposal_json,content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28)
         ON CONFLICT (tenant_id,run_id,revision) DO NOTHING RETURNING id`,
        [proposal.id, lease.tenantId, lease.integrationId, lease.runId, proposal.sourceReviewRunId, proposal.findingId,
          proposal.revision, proposal.repository, proposal.baseSha, proposal.headSha, proposal.sourceBundleRef,
          proposal.sourceBundleHash, proposal.codePatch, proposal.testPatch, proposal.codePatchHash, proposal.testPatchHash,
          proposal.proposalHash, proposal.policyId, proposal.policyHash, proposal.trustedCommandHash, proposal.dependencyLockPath,
          proposal.dependencyLockHash, proposal.sandboxPolicyHash, proposal.imageDigest, proposal.publisherPolicyHash,
          proposal.qualificationStatus, JSON.stringify(proposal), contentHash],
      );
      if (!inserted.rowCount) await assertProposalImmutable(client, proposal, contentHash);
      if (this.enqueueJob) await this.enqueueJob(client, {
        tenantId: lease.tenantId, integrationId: lease.integrationId, runId: lease.runId,
        proposalId: proposal.id, proposalHash: proposal.proposalHash,
        sourceBundleRef: proposal.sourceBundleRef, sourceBundleHash: proposal.sourceBundleHash, policyHash: proposal.policyHash,
        verificationInputHash: fingerprint({ proposalHash: proposal.proposalHash,
          sourceBundleHash: proposal.sourceBundleHash, policyHash: proposal.policyHash,
          trustedCommandHash: proposal.trustedCommandHash, dependencyLockPath: proposal.dependencyLockPath,
          dependencyLockHash: proposal.dependencyLockHash,
          sandboxPolicyHash: proposal.sandboxPolicyHash }),
        trustedCommandHash: proposal.trustedCommandHash, dependencyLockPath: proposal.dependencyLockPath,
        dependencyLockHash: proposal.dependencyLockHash,
        sandboxPolicyHash: proposal.sandboxPolicyHash,
        imageDigest: proposal.imageDigest, claimedRunEpoch: lease.epoch,
      });
    });
  }

  async loadVerification(lease: RunLease, proposalId: string): Promise<VerificationResult | undefined> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const result = await client.query<{ result_json: VerificationResult; result_hash: string }>(
        `SELECT result_json,result_hash FROM pr_agent_harness.fix_verifications
         WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND proposal_id=$4 AND content_purged_at IS NULL`,
        [lease.tenantId, lease.integrationId, lease.runId, proposalId],
      );
      const row = result.rows[0];
      if (row && fingerprint(row.result_json) !== row.result_hash) throw new FixStoreError("verification_hash_mismatch");
      return row?.result_json;
    });
  }

  async registerVerification(
    lease: RunLease,
    stepKey: string,
    proposal: FixProposal,
    verification: VerificationResult,
  ): Promise<void> {
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const step = await successfulStep(client, lease, stepKey, "verification");
      if (fingerprint(step.output) !== fingerprint(verification)) throw new FixStoreError("verification_step_output_mismatch");
      const selected = await client.query<{
        job_id: string; result_json: unknown; result_hash: string; job_proposal_hash: string; job_policy_hash: string;
        proposal_hash: string; policy_hash: string; image_digest: string;
      }>(
        `SELECT j.id AS job_id,j.result_json,j.result_hash,j.proposal_hash AS job_proposal_hash,
                j.policy_hash AS job_policy_hash,p.proposal_hash,p.policy_hash,p.image_digest
         FROM pr_agent_harness.verification_jobs j
         JOIN pr_agent_harness.fix_proposals p
           ON p.tenant_id=j.tenant_id AND p.run_id=j.run_id AND p.id=j.proposal_id
         WHERE j.tenant_id=$1 AND j.integration_id=$2 AND j.run_id=$3 AND j.proposal_id=$4
           AND j.status='succeeded' AND p.content_purged_at IS NULL`,
        [lease.tenantId, lease.integrationId, lease.runId, proposal.id],
      );
      const row = selected.rows[0];
      if (!row) throw new FixStoreError("verification_job_not_completed");
      const result = verificationResultSchema.parse(row.result_json);
      if (fingerprint(result) !== fingerprint(verification)) throw new FixStoreError("verification_job_output_mismatch");
      if (fingerprint(result) !== row.result_hash || result.proposalHash !== row.proposal_hash
          || result.proposalHash !== row.job_proposal_hash || result.policyHash !== row.policy_hash
          || result.policyHash !== row.job_policy_hash || result.imageDigest !== row.image_digest) {
        throw new FixStoreError("verification_result_scope_mismatch");
      }
      const proven = result.outcome === "verified" && result.relevance === "verified"
        && result.relevanceAttestation?.testPatchHash === proposal.testPatchHash
        && /^[a-f0-9]{64}$/.test(result.relevanceAttestation.attestationHash)
        && isFixDifferentialEligible(result);
      const verdict = proven ? "proven" : result.outcome === "failed" ? "failed" : "suggestion_only";
      const id = fingerprint({ tenantId: lease.tenantId, runId: lease.runId, proposalId: proposal.id, resultHash: row.result_hash });
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.fix_verifications
           (id,tenant_id,integration_id,run_id,proposal_id,verification_job_id,verdict,proposal_hash,policy_hash,result_hash,result_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (tenant_id,run_id,proposal_id) DO NOTHING RETURNING id`,
        [id, lease.tenantId, lease.integrationId, lease.runId, proposal.id, row.job_id, verdict,
          row.proposal_hash, row.policy_hash, row.result_hash, JSON.stringify(result)],
      );
      if (!inserted.rowCount) {
        const existing = await client.query<{ result_hash: string }>(
          `SELECT result_hash FROM pr_agent_harness.fix_verifications WHERE tenant_id=$1 AND run_id=$2 AND proposal_id=$3`,
          [lease.tenantId, lease.runId, proposal.id]);
        if (existing.rows[0]?.result_hash !== row.result_hash) throw new FixStoreError("verification_immutable_conflict");
      }
    });
  }

  async loadArtifact(lease: RunLease): Promise<FixArtifact | undefined> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const result = await client.query<{ artifact_json: FixArtifact; content_hash: string }>(
        `SELECT artifact_json,content_hash FROM pr_agent_harness.fix_artifacts
         WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND content_purged_at IS NULL`,
        [lease.tenantId, lease.integrationId, lease.runId],
      );
      const row = result.rows[0];
      if (row && fingerprint(row.artifact_json) !== row.content_hash) throw new FixStoreError("artifact_hash_mismatch");
      return row?.artifact_json;
    });
  }

  async saveArtifact(lease: RunLease, artifact: FixArtifact): Promise<void> {
    if (artifact.workflowId !== "fix.propose.v1" || artifact.source.runId !== lease.runId) throw new FixStoreError("artifact_scope_mismatch");
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const contentHash = fingerprint(artifact);
      const id = fingerprint({ tenantId: lease.tenantId, runId: lease.runId, contentHash });
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.fix_artifacts (id,tenant_id,integration_id,run_id,content_hash,artifact_json)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (tenant_id,run_id) DO NOTHING RETURNING id`,
        [id, lease.tenantId, lease.integrationId, lease.runId, contentHash, JSON.stringify(artifact)],
      );
      if (!inserted.rowCount) await assertImmutable(client, "fix_artifacts", lease.tenantId, lease.runId, contentHash);
    });
  }

  async readArtifact(principal: RunPrincipal, runId: string, options: { raw?: boolean } = {}): Promise<Record<string, unknown>> {
    requireRunPermission(principal, options.raw ? "runs:trace" : "runs:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      const selected = await client.query<{ artifact_json: FixArtifact; content_hash: string; content_purged_at: Date | null }>(
        `SELECT a.artifact_json,a.content_hash,a.content_purged_at
         FROM pr_agent_harness.fix_artifacts a
         JOIN pr_agent_harness.agent_runs r ON r.tenant_id=a.tenant_id AND r.integration_id=a.integration_id AND r.id=a.run_id
         JOIN pr_agent_harness.integration_bindings b ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
         WHERE a.tenant_id=$1 AND a.integration_id=$2 AND a.run_id=$3`,
        [principal.tenantId, principal.integrationId, runId]);
      const row = selected.rows[0];
      if (!row) throw runNotFound();
      if (row.content_purged_at) return { runId, contentHash: row.content_hash, contentPurged: true };
      if (fingerprint(row.artifact_json) !== row.content_hash) throw new FixStoreError("artifact_hash_mismatch");
      if (options.raw) return row.artifact_json as unknown as Record<string, unknown>;
      const artifact = row.artifact_json;
      return { runId, workflowId: artifact.workflowId, publicationMode: artifact.publicationMode,
        outcome: artifact.outcome, reasonCodes: artifact.reasonCodes, contentHash: row.content_hash,
        source: { sourceReviewRunId: artifact.source.sourceReviewRunId, findingId: artifact.source.findingId,
          repository: artifact.source.repository, headSha: artifact.source.headSha,
          finding: { title: redactRepositoryText(artifact.source.finding.title).slice(0, 300),
            path: artifact.source.finding.path, startLine: artifact.source.finding.startLine,
            endLine: artifact.source.finding.endLine } },
        proposal: artifact.proposal ? { id: artifact.proposal.id, revision: artifact.proposal.revision,
          proposalHash: artifact.proposal.proposalHash, codePatchHash: artifact.proposal.codePatchHash,
          testPatchHash: artifact.proposal.testPatchHash, qualificationStatus: artifact.proposal.qualificationStatus } : undefined,
        verification: artifact.verification ? { outcome: artifact.verification.outcome,
          reasonCodes: artifact.verification.reasonCodes, relevance: artifact.verification.relevance,
          verificationResultHash: fingerprint(artifact.verification) } : undefined };
    });
  }

  async createApproval(input: CreateFixApprovalInput): Promise<FixApprovalReceipt> {
    return this.db.transaction(input.tenantId, async (client) => createApprovalInTransaction(client, input));
  }

  async revokeApproval(input: DecideFixApprovalInput): Promise<FixApprovalReceipt> {
    return this.db.transaction(input.tenantId, async (client) => revokeApprovalInTransaction(client, input));
  }

  async attestRelevance(input: CreateFixRelevanceAttestationInput): Promise<FixRelevanceAttestation> {
    return this.db.transaction(input.tenantId, async (client) => {
      const selected = await client.query<{ created_by_actor_type: string; created_by_actor_id: string;
        proposal_hash: string; test_patch_hash: string; finding_id: string; result_hash: string; result_json: VerificationResult }>(
        `SELECT r.created_by_actor_type,r.created_by_actor_id,p.proposal_hash,p.test_patch_hash,p.finding_id,
                v.result_hash,v.result_json
         FROM pr_agent_harness.agent_runs r
         JOIN pr_agent_harness.fix_proposals p ON p.tenant_id=r.tenant_id AND p.run_id=r.id AND p.id=$4
         JOIN pr_agent_harness.fix_verifications v ON v.tenant_id=p.tenant_id AND v.run_id=p.run_id AND v.proposal_id=p.id
         WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3 AND r.run_type='fix.propose.v1'
           AND r.status='succeeded' AND p.content_purged_at IS NULL AND v.content_purged_at IS NULL FOR SHARE OF r`,
        [input.tenantId, input.integrationId, input.proposalRunId, input.proposalId]);
      const row = selected.rows[0];
      if (!row || row.proposal_hash !== input.proposalHash || row.test_patch_hash !== input.testPatchHash
          || row.finding_id !== input.findingId || row.result_hash !== input.verificationResultHash) {
        throw new FixStoreError("relevance_attestation_scope_mismatch");
      }
      if (row.created_by_actor_type === input.actor.type && row.created_by_actor_id === input.actor.id) {
        throw new FixStoreError("maker_checker_violation");
      }
      const verification = verificationResultSchema.parse(row.result_json);
      if (!isFixDifferentialEligible(verification)) {
        throw new FixStoreError("differential_verification_not_eligible");
      }
      const requestHash = fingerprint({ proposalRunId: input.proposalRunId, proposalId: input.proposalId,
        proposalHash: input.proposalHash, testPatchHash: input.testPatchHash, findingId: input.findingId,
        verificationResultHash: input.verificationResultHash, rubricVersion: input.rubricVersion, reason: input.reason,
        commandKey: input.commandKey });
      const attestationHash = fingerprint({ requestHash, actor: input.actor });
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO pr_agent_harness.fix_relevance_attestations
           (tenant_id,integration_id,proposal_run_id,proposal_id,command_key,request_hash,proposal_hash,
            test_patch_hash,finding_id,verification_result_hash,rubric_version,reason,actor_type,actor_id,attestation_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (tenant_id,proposal_run_id,command_key) DO NOTHING RETURNING id,created_at`,
        [input.tenantId, input.integrationId, input.proposalRunId, input.proposalId, input.commandKey, requestHash,
          input.proposalHash, input.testPatchHash, input.findingId, input.verificationResultHash,
          input.rubricVersion, input.reason, input.actor.type, input.actor.id, attestationHash]);
      let id = inserted.rows[0]?.id; let createdAt = inserted.rows[0]?.created_at;
      if (!id) {
        const existing = await client.query<{ id: string; request_hash: string; attestation_hash: string; created_at: Date }>(
          `SELECT id,request_hash,attestation_hash,created_at FROM pr_agent_harness.fix_relevance_attestations
           WHERE tenant_id=$1 AND proposal_run_id=$2 AND command_key=$3`,
          [input.tenantId, input.proposalRunId, input.commandKey]);
        if (!existing.rows[0] || existing.rows[0].request_hash !== requestHash
            || existing.rows[0].attestation_hash !== attestationHash) throw new FixStoreError("relevance_command_conflict");
        ({ id, created_at: createdAt } = existing.rows[0]);
      }
      return { id: id!, proposalRunId: input.proposalRunId, proposalId: input.proposalId,
        proposalHash: input.proposalHash, testPatchHash: input.testPatchHash, findingId: input.findingId,
        verificationResultHash: input.verificationResultHash, rubricVersion: input.rubricVersion,
        reason: input.reason, actor: input.actor, attestationHash, createdAt: createdAt!.toISOString() };
    });
  }
}

export async function createApprovalInTransaction(client: PoolClient, input: CreateFixApprovalInput): Promise<FixApprovalReceipt> {
  const intentHash = fingerprint(input.intent);
  await client.query(
    `SELECT id FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
    [input.tenantId, input.integrationId, input.proposalRunId]);
  await client.query(
    `UPDATE pr_agent_harness.fix_approval_requests SET status='expired',version=version+1
     WHERE tenant_id=$1 AND proposal_run_id=$2 AND status IN ('open','approved')
       AND expires_at<=clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_consumptions c
         WHERE c.tenant_id=fix_approval_requests.tenant_id AND c.approval_id=fix_approval_requests.id)`,
    [input.tenantId, input.proposalRunId]);
  const duplicate = await client.query<{ id: string; intent_hash: string; status: FixApprovalReceipt["status"];
    version: string; expires_at: Date }>(
    `SELECT id,intent_hash,status,version,expires_at FROM pr_agent_harness.fix_approval_requests
     WHERE tenant_id=$1 AND proposal_run_id=$2 AND command_key=$3`,
    [input.tenantId, input.proposalRunId, input.commandKey]);
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].intent_hash !== intentHash) throw new FixStoreError("approval_command_conflict");
    return receipt(duplicate.rows[0].id, intentHash, duplicate.rows[0].status,
      duplicate.rows[0].version, duplicate.rows[0].expires_at);
  }
  const active = await client.query(
    `SELECT 1 FROM pr_agent_harness.fix_approval_requests
     WHERE tenant_id=$1 AND proposal_run_id=$2 AND proposal_id=$3 AND status IN ('open','approved','consumed')`,
    [input.tenantId, input.proposalRunId, input.proposalId]);
  if (active.rowCount) throw new FixStoreError("approval_already_active");
  const relevance = await client.query<{ test_patch_hash: string; attestation_hash: string }>(
    `SELECT test_patch_hash,attestation_hash FROM pr_agent_harness.fix_relevance_attestations
     WHERE tenant_id=$1 AND integration_id=$2 AND proposal_run_id=$3 AND proposal_id=$4`,
    [input.tenantId, input.integrationId, input.proposalRunId, input.proposalId]);
  const relevanceRow = relevance.rows[0];
  if (!relevanceRow || fingerprint({ kind: "human", testPatchHash: relevanceRow.test_patch_hash,
    attestationHash: relevanceRow.attestation_hash }) !== input.intent.relevanceAttestationHash) {
    throw new FixStoreError("relevance_attestation_scope_mismatch");
  }
  const verification = await client.query<{ result_hash: string; result_json: unknown }>(
    `SELECT result_hash,result_json FROM pr_agent_harness.fix_verifications
     WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND proposal_id=$4 AND content_purged_at IS NULL`,
    [input.tenantId, input.integrationId, input.proposalRunId, input.proposalId]);
  const verificationRow = verification.rows[0];
  if (!verificationRow || verificationRow.result_hash !== input.intent.verificationResultHash
      || !isFixDifferentialEligible(verificationResultSchema.parse(verificationRow.result_json))) {
    throw new FixStoreError("differential_verification_not_eligible");
  }
  const result = await client.query<{ id: string; status: FixApprovalReceipt["status"]; version: string; expires_at: Date; intent_hash: string }>(
    `INSERT INTO pr_agent_harness.fix_approval_requests
       (tenant_id,integration_id,proposal_run_id,proposal_id,command_key,generation,
        intent_hash,intent_json,maker_actor_type,maker_actor_id,expires_at)
     SELECT $1,$2,$3,$4,$23,
       COALESCE((SELECT max(generation)+1 FROM pr_agent_harness.fix_approval_requests WHERE tenant_id=$1 AND proposal_run_id=$3),1),
       $5,$6::jsonb,$7,$8,clock_timestamp()+make_interval(secs=>$9::integer)
     FROM pr_agent_harness.fix_proposals p
     JOIN pr_agent_harness.fix_verifications v ON v.tenant_id=p.tenant_id AND v.run_id=p.run_id AND v.proposal_id=p.id
     JOIN pr_agent_harness.fix_relevance_attestations fra
       ON fra.tenant_id=p.tenant_id AND fra.integration_id=p.integration_id AND fra.proposal_run_id=p.run_id AND fra.proposal_id=p.id
     JOIN pr_agent_harness.agent_runs r ON r.tenant_id=p.tenant_id AND r.integration_id=p.integration_id AND r.id=p.run_id
     WHERE p.tenant_id=$1 AND p.integration_id=$2 AND p.run_id=$3 AND p.id=$4
       AND p.qualification_status='verified' AND v.verdict IN ('proven','suggestion_only')
       AND fra.test_patch_hash=p.test_patch_hash AND fra.verification_result_hash=v.result_hash
       AND p.content_purged_at IS NULL AND v.content_purged_at IS NULL
       AND r.status='succeeded' AND r.run_type='fix.propose.v1'
       AND r.created_by_actor_type=$7 AND r.created_by_actor_id=$8
       AND $9::integer BETWEEN 300 AND 86400
       AND p.proposal_hash=$10 AND p.head_sha=$11 AND p.policy_hash=$12 AND p.publisher_policy_hash=$13
       AND p.source_review_run_id=$14 AND p.finding_id=$15 AND p.source_bundle_hash=$16
       AND p.code_patch_hash=$17 AND p.test_patch_hash=$18 AND p.trusted_command_hash=$19
       AND p.dependency_lock_hash=$20 AND p.sandbox_policy_hash=$21 AND v.result_hash=$22
     ON CONFLICT (tenant_id,proposal_run_id,command_key) DO NOTHING
     RETURNING id,status,version,expires_at,intent_hash`,
    [input.tenantId, input.integrationId, input.proposalRunId, input.proposalId, intentHash, JSON.stringify(input.intent),
      input.maker.type, input.maker.id, input.ttlSeconds, input.intent.proposalHash, input.intent.headSha,
      input.intent.policyHash, input.intent.publisherPolicyHash, input.intent.sourceReviewRunId, input.intent.findingId,
      input.intent.sourceBundleHash, input.intent.codePatchHash, input.intent.testPatchHash, input.intent.trustedCommandHash,
      input.intent.dependencyLockHash, input.intent.sandboxPolicyHash, input.intent.verificationResultHash,
      input.commandKey],
  );
  const row = result.rows[0];
  if (!row) throw new FixStoreError("approval_not_qualified");
  if (row.intent_hash !== intentHash) throw new FixStoreError("approval_intent_conflict");
  return receipt(row.id, intentHash, row.status, row.version, row.expires_at);
}

export async function revokeApprovalInTransaction(client: PoolClient, input: DecideFixApprovalInput): Promise<FixApprovalReceipt> {
  const request = await lockApproval(client, input);
  const duplicate = await duplicateDecision(client, input, "revoke");
  if (duplicate) return receipt(request.id, request.intent_hash, request.status, request.version, request.expires_at);
  if (request.status === "consumed") throw new FixStoreError("approval_already_consumed");
  if (request.status !== "approved" || request.version !== input.expectedVersion) throw new FixStoreError("approval_cas_conflict");
  await client.query(
    `UPDATE pr_agent_harness.fix_approval_requests SET status='revoked',version=version+1,revoked_at=clock_timestamp()
     WHERE tenant_id=$1 AND id=$2`, [input.tenantId, input.approvalId]);
  await insertDecision(client, input, request.proposal_run_id, "revoke", request.approved_publish_run_id);
  return receipt(request.id, request.intent_hash, "revoked", request.version + 1, request.expires_at);
}

export async function approveFixApprovalInTransaction(
  client: PoolClient,
  input: DecideFixApprovalInput,
  createPublishRun: CreateFixPublishRun,
): Promise<FixApprovalReceipt & { publishRunId: string }> {
  const request = await lockApproval(client, input);
  const duplicate = await duplicateDecision(client, input, "approve");
  if (duplicate) {
    if (!request.approved_publish_run_id) throw new FixStoreError("approval_decision_corrupt");
    return { ...receipt(request.id, request.intent_hash, request.status, request.version, request.expires_at),
      publishRunId: request.approved_publish_run_id };
  }
  if (request.status !== "open" || request.version !== input.expectedVersion || !request.unexpired) {
    throw new FixStoreError("approval_cas_conflict");
  }
  const maker = await client.query<{ maker_actor_type: string; maker_actor_id: string; status: string }>(
    `SELECT a.maker_actor_type,a.maker_actor_id,r.status
     FROM pr_agent_harness.fix_approval_requests a
     JOIN pr_agent_harness.agent_runs r ON r.tenant_id=a.tenant_id AND r.id=a.proposal_run_id
     WHERE a.tenant_id=$1 AND a.id=$2 FOR SHARE OF r`, [input.tenantId, input.approvalId]);
  if (!maker.rows[0] || maker.rows[0].status !== "succeeded"
      || (maker.rows[0].maker_actor_type === input.actor.type && maker.rows[0].maker_actor_id === input.actor.id)) {
    throw new FixStoreError("maker_checker_violation");
  }
  const publishRunId = await createPublishRun(client, {
    proposalRunId: request.proposal_run_id, approvalId: request.id, intentHash: request.intent_hash,
  });
  const updated = await client.query(
    `UPDATE pr_agent_harness.fix_approval_requests
     SET status='approved',version=version+1,approved_at=clock_timestamp(),approved_publish_run_id=$3
     WHERE tenant_id=$1 AND id=$2 AND status='open' AND version=$4 AND expires_at>clock_timestamp()`,
    [input.tenantId, input.approvalId, publishRunId, input.expectedVersion]);
  if (updated.rowCount !== 1) throw new FixStoreError("approval_cas_conflict");
  await insertDecision(client, input, request.proposal_run_id, "approve", publishRunId);
  return { ...receipt(request.id, request.intent_hash, "approved", request.version + 1, request.expires_at), publishRunId };
}

export async function consumeFixApprovalInTransaction(client: PoolClient, input: ConsumeFixApprovalInput): Promise<void> {
  const locked = await client.query<ApprovalRow>(
    `SELECT id,proposal_run_id,intent_hash,status,version,expires_at,approved_publish_run_id,
            expires_at>clock_timestamp() AS unexpired
     FROM pr_agent_harness.fix_approval_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [input.tenantId, input.approvalId],
  );
  const row = locked.rows[0];
  if (!row || row.intent_hash !== input.intentHash || row.approved_publish_run_id !== input.publishRunId) {
    throw new FixStoreError("approval_scope_mismatch");
  }
  const batch = await client.query<{ operation_set_hash: string }>(
    `SELECT operation_set_hash FROM pr_agent_harness.publication_batches
     WHERE tenant_id=$1 AND id=$2 AND seal_state='sealed'`, [input.tenantId, input.batchId]);
  if (batch.rows[0]?.operation_set_hash !== input.operationSetHash) {
    throw new FixStoreError("approval_batch_scope_mismatch");
  }
  const existing = await client.query<{ batch_id: string; operation_set_hash: string }>(
    `SELECT batch_id,operation_set_hash FROM pr_agent_harness.fix_approval_consumptions
     WHERE tenant_id=$1 AND approval_id=$2`, [input.tenantId, input.approvalId]);
  if (existing.rows[0]) {
    if (row.status !== "consumed" || existing.rows[0].batch_id !== input.batchId
        || existing.rows[0].operation_set_hash !== input.operationSetHash) {
      throw new FixStoreError("approval_consumption_conflict");
    }
    return;
  }
  if (row.status !== "approved" || !row.unexpired) throw new FixStoreError("approval_not_consumable");
  await client.query(
    `INSERT INTO pr_agent_harness.fix_approval_consumptions
       (tenant_id,proposal_run_id,approval_id,publish_run_id,batch_id,operation_set_hash,intent_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.tenantId, row.proposal_run_id, input.approvalId, input.publishRunId, input.batchId, input.operationSetHash, input.intentHash]);
  await client.query(
    `UPDATE pr_agent_harness.fix_approval_requests SET status='consumed',version=version+1,consumed_at=clock_timestamp()
     WHERE tenant_id=$1 AND id=$2`, [input.tenantId, input.approvalId]);
}

interface ApprovalRow { id: string; proposal_run_id: string; intent_hash: string; status: FixApprovalReceipt["status"];
  version: number; expires_at: Date; approved_publish_run_id: string | null; unexpired: boolean }

async function lockApproval(client: PoolClient, input: DecideFixApprovalInput): Promise<ApprovalRow> {
  const result = await client.query<Omit<ApprovalRow, "version"> & { version: string }>(
    `SELECT id,proposal_run_id,intent_hash,status,version,expires_at,approved_publish_run_id,
            expires_at>clock_timestamp() AS unexpired
     FROM pr_agent_harness.fix_approval_requests WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
    [input.tenantId, input.integrationId, input.approvalId]);
  const row = result.rows[0];
  if (!row) throw new FixStoreError("approval_not_found");
  return { ...row, version: Number(row.version) };
}

async function duplicateDecision(client: PoolClient, input: DecideFixApprovalInput, decision: string): Promise<boolean> {
  const result = await client.query<{ request_hash: string; decision: string }>(
    `SELECT request_hash,decision FROM pr_agent_harness.fix_approval_decisions
     WHERE tenant_id=$1 AND approval_id=$2 AND command_key=$3`, [input.tenantId, input.approvalId, input.commandKey]);
  if (!result.rows[0]) return false;
  if (result.rows[0].request_hash !== input.requestHash || result.rows[0].decision !== decision) throw new FixStoreError("approval_command_conflict");
  return true;
}

async function insertDecision(client: PoolClient, input: DecideFixApprovalInput, proposalRunId: string, decision: string, publishRunId: string | null): Promise<void> {
  await client.query(
    `INSERT INTO pr_agent_harness.fix_approval_decisions
       (tenant_id,proposal_run_id,approval_id,command_key,request_hash,decision,actor_type,actor_id,publish_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.tenantId, proposalRunId, input.approvalId, input.commandKey, input.requestHash,
      decision, input.actor.type, input.actor.id, publishRunId]);
}

async function successfulStep(client: PoolClient, lease: RunLease, stepKey: string, kind: string): Promise<{ output: unknown }> {
  const result = await client.query<{ step_kind: string; output: unknown }>(
    `SELECT step_kind,output_json->'value' AS output FROM pr_agent_harness.agent_steps
     WHERE tenant_id=$1 AND run_id=$2 AND step_key=$3 AND status='succeeded'`, [lease.tenantId, lease.runId, stepKey]);
  if (!result.rows[0] || result.rows[0].step_kind !== kind) throw new FixStoreError("proposal_step_not_succeeded");
  return result.rows[0];
}

async function assertImmutable(client: PoolClient, table: "fix_run_sources" | "fix_artifacts", tenantId: string, runId: string, hash: string): Promise<void> {
  const result = await client.query<{ content_hash: string }>(`SELECT content_hash FROM pr_agent_harness.${table} WHERE tenant_id=$1 AND run_id=$2`, [tenantId, runId]);
  if (result.rows[0]?.content_hash !== hash) throw new FixStoreError("immutable_record_conflict");
}

async function assertProposalImmutable(client: PoolClient, proposal: FixProposal, hash: string): Promise<void> {
  const result = await client.query<{ id: string; content_hash: string }>(
    `SELECT id,content_hash FROM pr_agent_harness.fix_proposals WHERE tenant_id=$1 AND run_id=$2 AND revision=$3`,
    [proposal.tenantId, proposal.runId, proposal.revision]);
  if (result.rows[0]?.id !== proposal.id || result.rows[0]?.content_hash !== hash) throw new FixStoreError("proposal_revision_conflict");
}

function candidateMatchesSource(value: unknown, source: FixSource): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>; const location = item.location as Record<string, unknown> | undefined;
  return item.id === source.findingId && item.title === source.finding.title && item.body === source.finding.body
    && location?.path === source.finding.path && location.startLine === source.finding.startLine && location.endLine === source.finding.endLine;
}

function assertSourceLease(lease: RunLease, source: FixSource): void {
  if (source.tenantId !== lease.tenantId || source.integrationId !== lease.integrationId || source.runId !== lease.runId
      || source.baseSha !== lease.baseSha || source.headSha !== lease.headSha) throw new FixStoreError("source_scope_mismatch");
}
function assertProposalLease(lease: RunLease, proposal: FixProposal): void {
  if (proposal.tenantId !== lease.tenantId || proposal.integrationId !== lease.integrationId || proposal.runId !== lease.runId
      || proposal.baseSha !== lease.baseSha || proposal.headSha !== lease.headSha) throw new FixStoreError("proposal_scope_mismatch");
}
function receipt(id: string, intentHash: string, status: FixApprovalReceipt["status"], version: string | number, expiresAt: Date): FixApprovalReceipt {
  return { approvalId: id, intentHash, status, version: Number(version), expiresAt: expiresAt.toISOString() };
}
