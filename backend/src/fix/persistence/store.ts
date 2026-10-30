import type { PoolClient } from "pg";

import type {
  EnqueueVerificationJob,
  FixArtifact,
  FixProposal,
  FixSource,
  FixStore as FixStorePort,
  VerificationResult,
} from "../contracts.js";
import { isFixDifferentialEligible } from "../verification/gate.js";
import { FixStoreError } from "../errors.js";
import { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { assertRunLease } from "../../agent-runtime/execution/store.js";
import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import { fingerprint, verifierCapabilityHash } from "../../agent-runtime/versions.js";
import { verificationResultSchema } from "../proposal/input.js";
import type { RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { requireRunPermission, runNotFound } from "../../agent-runtime/runs/control-contracts.js";
import { redactRepositoryText } from "../../repository/content-safety/repository-content.js";
import { verificationResultIdentityHash } from "../verification/jobs.js";


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
    const verifierHash = this.enqueueJob ? await verifierCapabilityHash() : undefined;
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
          sandboxPolicyHash: proposal.sandboxPolicyHash, verifierCapabilityHash: verifierHash }),
        verifierCapabilityHash: verifierHash!,
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
        proposal_hash: string; policy_hash: string; image_digest: string; verification_input_hash: string;
        verifier_capability_hash: string | null; result_identity_hash: string | null;
      }>(
        `SELECT j.id AS job_id,j.result_json,j.result_hash,j.proposal_hash AS job_proposal_hash,
                j.policy_hash AS job_policy_hash,j.verification_input_hash,j.verifier_capability_hash,
                j.result_identity_hash,p.proposal_hash,p.policy_hash,p.image_digest
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
          || result.policyHash !== row.job_policy_hash || result.imageDigest !== row.image_digest
          || !row.verifier_capability_hash || row.result_identity_hash !== verificationResultIdentityHash(
            row.result_hash, row.verification_input_hash, row.verifier_capability_hash)) {
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
