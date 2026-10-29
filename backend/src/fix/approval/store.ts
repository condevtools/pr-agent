import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import type { VerificationResult } from "../contracts.js";
import { FixStoreError } from "../errors.js";
import { verificationResultSchema } from "../proposal/input.js";
import { isFixDifferentialEligible } from "../verification/gate.js";
import type {
  ConsumeFixApprovalInput,
  CreateFixApprovalInput,
  CreateFixPublishRun,
  CreateFixRelevanceAttestationInput,
  DecideFixApprovalInput,
  FixApprovalReceipt,
  FixRelevanceAttestation,
} from "./contracts.js";

export class PgFixApprovalStore {
  constructor(private readonly db: RuntimeDatabase) {}

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

function receipt(id: string, intentHash: string, status: FixApprovalReceipt["status"], version: string | number, expiresAt: Date): FixApprovalReceipt {
  return { approvalId: id, intentHash, status, version: Number(version), expiresAt: expiresAt.toISOString() };
}
