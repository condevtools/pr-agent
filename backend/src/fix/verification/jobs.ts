import type { Pool, PoolClient } from "pg";

import type { FixProposal, VerificationJobInput, VerificationResult } from "../contracts.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import { assertRunLease } from "../../agent-runtime/execution/store.js";
import { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";

export interface VerificationJobLease extends VerificationJobInput {
  id: string;
  owner: string;
  epoch: number;
  attempt: number;
  leaseExpiresAt: string;
  deadlineAt: string;
  proposal: FixProposal;
}

interface ClaimRow {
  id: string; tenant_id: string; integration_id: string; run_id: string; proposal_id: string;
  proposal_hash: string; source_bundle_ref: string; source_bundle_hash: string; policy_hash: string;
  verifier_capability_hash: string; verification_input_hash: string; trusted_command_hash: string; dependency_lock_hash: string;
  dependency_lock_path: string; sandbox_policy_hash: string; image_digest: string;
  claimed_run_epoch: string; lease_epoch: string; lease_expires_at: Date; attempt_count: number;
  deadline_at: Date; proposal_json: FixProposal;
}

export class PgFixVerifierJobStore {
  constructor(private readonly pool: Pool, private readonly leaseSeconds = 60) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error("verifier lease must be 5-300 seconds");
    }
  }

  async claim(owner: string, verifierCapabilityHash: string): Promise<VerificationJobLease | undefined> {
    if (!owner || owner.length > 200) throw new Error("invalid verifier owner");
    if (!/^[a-f0-9]{64}$/.test(verifierCapabilityHash)) throw new Error("invalid verifier capability hash");
    const result = await this.pool.query<ClaimRow>(
      "SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)",
      [owner, this.leaseSeconds, verifierCapabilityHash]);
    const row = result.rows[0];
    if (!row) return undefined;
    validateClaim(row);
    return { id: row.id, tenantId: row.tenant_id, integrationId: row.integration_id,
      runId: row.run_id, proposalId: row.proposal_id, proposalHash: row.proposal_hash,
      sourceBundleRef: row.source_bundle_ref, sourceBundleHash: row.source_bundle_hash,
      policyHash: row.policy_hash, verifierCapabilityHash: row.verifier_capability_hash,
      verificationInputHash: row.verification_input_hash,
      trustedCommandHash: row.trusted_command_hash, dependencyLockHash: row.dependency_lock_hash,
      dependencyLockPath: row.dependency_lock_path,
      sandboxPolicyHash: row.sandbox_policy_hash, imageDigest: row.image_digest,
      claimedRunEpoch: Number(row.claimed_run_epoch), owner, epoch: Number(row.lease_epoch),
      attempt: row.attempt_count, leaseExpiresAt: row.lease_expires_at.toISOString(),
      deadlineAt: row.deadline_at.toISOString(), proposal: row.proposal_json };
  }

  async databaseNow(): Promise<Date> {
    const result = await this.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    if (!result.rows[0]?.now) throw new Error("verifier database clock is unavailable");
    return result.rows[0].now;
  }

  async heartbeat(lease: VerificationJobLease): Promise<void> {
    const result = await this.pool.query<{ heartbeat_verification_job: boolean }>(
      "SELECT pr_agent_harness.heartbeat_verification_job($1,$2,$3,$4,$5)",
      [lease.tenantId, lease.id, lease.owner, lease.epoch, this.leaseSeconds]);
    if (!result.rows[0]?.heartbeat_verification_job) throw new VerificationJobLeaseLostError(lease.id);
  }

  async complete(lease: VerificationJobLease, result: VerificationResult): Promise<void> {
    if (result.proposalHash !== lease.proposalHash || result.policyHash !== lease.policyHash
        || result.imageDigest !== lease.imageDigest) throw new Error("verification result scope mismatch");
    const hash = fingerprint(result);
    const identityHash = verificationResultIdentityHash(hash, lease.verificationInputHash, lease.verifierCapabilityHash);
    const completed = await this.pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
      [lease.tenantId, lease.id, lease.owner, lease.epoch, JSON.stringify(result), hash,
        lease.verificationInputHash, lease.verifierCapabilityHash, identityHash]);
    if (!completed.rows[0]?.complete_verification_job) throw new VerificationJobLeaseLostError(lease.id);
  }

  async fail(lease: VerificationJobLease, errorCode: string, retryDelaySeconds = 5): Promise<"queued" | "failed"> {
    const result = await this.pool.query<{ fail_verification_job: "queued" | "failed" | null }>(
      "SELECT pr_agent_harness.fail_verification_job($1,$2,$3,$4,$5,$6)",
      [lease.tenantId, lease.id, lease.owner, lease.epoch, errorCode.slice(0, 200), retryDelaySeconds]);
    const status = result.rows[0]?.fail_verification_job;
    if (status !== "queued" && status !== "failed") throw new VerificationJobLeaseLostError(lease.id);
    return status;
  }

  async relinquish(lease: VerificationJobLease): Promise<void> {
    const result = await this.pool.query<{ relinquish_verification_job: boolean }>(
      "SELECT pr_agent_harness.relinquish_verification_job($1,$2,$3,$4)",
      [lease.tenantId, lease.id, lease.owner, lease.epoch]);
    if (!result.rows[0]?.relinquish_verification_job) throw new VerificationJobLeaseLostError(lease.id);
  }
}

export async function enqueueVerificationJob(client: PoolClient, input: VerificationJobInput): Promise<string> {
  if (input.verificationInputHash !== verificationInputHashForJob(input, input.verifierCapabilityHash)) {
    throw new Error("verification job input hash mismatch");
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pr_agent_harness.verification_jobs
       (tenant_id,integration_id,run_id,proposal_id,proposal_hash,source_bundle_ref,source_bundle_hash,
        policy_hash,verifier_capability_hash,verification_input_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,
        sandbox_policy_hash,image_digest,claimed_run_epoch,deadline_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,r.deadline_at
     FROM pr_agent_harness.agent_runs r
     WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3
     ON CONFLICT (tenant_id,run_id,proposal_id) DO NOTHING RETURNING id`,
    [input.tenantId, input.integrationId, input.runId, input.proposalId, input.proposalHash,
      input.sourceBundleRef, input.sourceBundleHash, input.policyHash, input.verifierCapabilityHash,
      input.verificationInputHash,
      input.trustedCommandHash, input.dependencyLockPath, input.dependencyLockHash,
      input.sandboxPolicyHash, input.imageDigest, input.claimedRunEpoch],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{
    id: string; integration_id: string; proposal_hash: string; source_bundle_ref: string; source_bundle_hash: string;
    policy_hash: string; verification_input_hash: string; verifier_capability_hash: string | null;
    trusted_command_hash: string; dependency_lock_path: string; dependency_lock_hash: string;
    sandbox_policy_hash: string; image_digest: string;
  }>(
    `SELECT id,integration_id,proposal_hash,source_bundle_ref,source_bundle_hash,policy_hash,
            verification_input_hash,verifier_capability_hash,trusted_command_hash,dependency_lock_path,
            dependency_lock_hash,sandbox_policy_hash,image_digest
     FROM pr_agent_harness.verification_jobs
     WHERE tenant_id=$1 AND run_id=$2 AND proposal_id=$3`, [input.tenantId, input.runId, input.proposalId]);
  const row = existing.rows[0];
  if (!row || !row.verifier_capability_hash || row.integration_id !== input.integrationId
      || row.proposal_hash !== input.proposalHash || row.source_bundle_ref !== input.sourceBundleRef
      || row.source_bundle_hash !== input.sourceBundleHash || row.policy_hash !== input.policyHash
      || row.trusted_command_hash !== input.trustedCommandHash
      || row.dependency_lock_path !== input.dependencyLockPath
      || row.dependency_lock_hash !== input.dependencyLockHash
      || row.sandbox_policy_hash !== input.sandboxPolicyHash || row.image_digest !== input.imageDigest
      || row.verification_input_hash !== verificationInputHashForJob(input, row.verifier_capability_hash)) {
    throw new Error("verification job identity conflict");
  }
  return row.id;
}

export async function readVerificationJob(
  client: PoolClient,
  input: Pick<VerificationJobInput, "tenantId" | "integrationId" | "runId" | "proposalId">,
): Promise<{ id: string; status: string; verificationInputHash: string; verifierCapabilityHash: string;
  result?: VerificationResult; resultHash?: string; errorCode?: string } | undefined> {
  const result = await client.query<{ id: string; status: string; result_json: VerificationResult | null;
    result_hash: string | null; result_identity_hash: string | null; verifier_capability_hash: string | null;
    verification_input_hash: string;
    error_code: string | null }>(
    `SELECT id,status,result_json,result_hash,result_identity_hash,verifier_capability_hash,
            verification_input_hash,error_code
     FROM pr_agent_harness.verification_jobs
     WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND proposal_id=$4`,
    [input.tenantId, input.integrationId, input.runId, input.proposalId]);
  const row = result.rows[0];
  if (!row) return undefined;
  if (!row.verifier_capability_hash) return undefined;
  if (row.result_json && fingerprint(row.result_json) !== row.result_hash) throw new Error("verification job result hash mismatch");
  if (row.result_hash && (!row.verifier_capability_hash || row.result_identity_hash
      !== verificationResultIdentityHash(row.result_hash, row.verification_input_hash, row.verifier_capability_hash))) {
    throw new Error("verification job result identity mismatch");
  }
  return { id: row.id, status: row.status, verificationInputHash: row.verification_input_hash,
    verifierCapabilityHash: row.verifier_capability_hash, ...(row.result_json ? { result: row.result_json } : {}),
    ...(row.result_hash ? { resultHash: row.result_hash } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}

export function verificationInputHashForProposal(proposal: FixProposal, verifierCapability: string): string {
  return verificationInputHashForJob(proposal, verifierCapability);
}

function verificationInputHashForJob(
  input: Pick<VerificationJobInput, "proposalHash" | "sourceBundleHash" | "policyHash" |
    "trustedCommandHash" | "dependencyLockPath" | "dependencyLockHash" | "sandboxPolicyHash">,
  verifierCapability: string,
): string {
  return fingerprint({ proposalHash: input.proposalHash, sourceBundleHash: input.sourceBundleHash,
    policyHash: input.policyHash, trustedCommandHash: input.trustedCommandHash,
    dependencyLockPath: input.dependencyLockPath, dependencyLockHash: input.dependencyLockHash,
    sandboxPolicyHash: input.sandboxPolicyHash, verifierCapabilityHash: verifierCapability });
}

export function verificationResultIdentityHash(
  resultHash: string,
  verificationInputHash: string,
  verifierCapabilityHash: string,
): string {
  return fingerprint({ resultHash, verificationInputHash, verifierCapabilityHash });
}

/** Polls the external job while the caller owns the Run. The completed Step is promoted by PgFixStore. */
export async function waitForVerification(
  db: RuntimeDatabase,
  lease: RunLease,
  proposal: FixProposal,
  signal?: AbortSignal,
  pollMs = 500,
): Promise<VerificationResult> {
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("verification wait aborted");
    const completed = await db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const job = await readVerificationJob(client, { tenantId: lease.tenantId, integrationId: lease.integrationId,
        runId: lease.runId, proposalId: proposal.id });
      if (job && job.verificationInputHash !== verificationInputHashForProposal(proposal, job.verifierCapabilityHash)) {
        throw new Error("verification job input identity mismatch");
      }
      if (!job || job.status === "queued" || job.status === "leased") return undefined;
      if (job.status !== "succeeded" || !job.result || !job.resultHash) {
        throw new Error(`verification job failed: ${job?.errorCode ?? "unavailable"}`);
      }
      const result = job.result;
      if (result.proposalHash !== proposal.proposalHash || result.policyHash !== proposal.policyHash
          || result.imageDigest !== proposal.imageDigest) throw new Error("verification job result scope mismatch");
      return result;
    });
    if (completed) return completed;
    await abortableDelay(pollMs, signal);
  }
}

export class VerificationJobLeaseLostError extends Error {
  constructor(readonly jobId: string) { super(`verification job lease lost: ${jobId}`); this.name = "VerificationJobLeaseLostError"; }
}

function validateClaim(row: ClaimRow): void {
  const proposal = row.proposal_json;
  if (!proposal || proposal.id !== row.proposal_id || proposal.runId !== row.run_id
      || proposal.integrationId !== row.integration_id || proposal.tenantId !== row.tenant_id
      || proposal.proposalHash !== row.proposal_hash || proposal.sourceBundleRef !== row.source_bundle_ref
      || proposal.sourceBundleHash !== row.source_bundle_hash || proposal.policyHash !== row.policy_hash
      || !/^[a-f0-9]{64}$/.test(row.verifier_capability_hash)
      || proposal.trustedCommandHash !== row.trusted_command_hash
      || proposal.dependencyLockPath !== row.dependency_lock_path
      || proposal.dependencyLockHash !== row.dependency_lock_hash
      || proposal.sandboxPolicyHash !== row.sandbox_policy_hash || proposal.imageDigest !== row.image_digest) {
    throw new Error("claimed verification payload is inconsistent");
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    timer.unref();
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("verification wait aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
