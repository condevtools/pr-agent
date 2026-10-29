import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { HarnessDatabase } from "../harness/postgres/database.js";
import { requireRunPermission, RunControlError, type RunPrincipal } from "../harness/run-control-contracts.js";
import { fingerprint, type RunVersionManifest } from "../harness/versions.js";
import { canPromoteCanary, computeCanaryMetrics, type CanaryObservation } from "./canary-metrics.js";
import { evaluateOfflineReleaseGates, EvolutionReleaseGateError } from "./release-gates.js";
import { evolutionReleasePolicy, evolutionReleasePolicyHash } from "./release-policy.js";
import type { EvolutionReleaseAssignment, EvolutionReleaseQualification, EvolutionReleaseRequest,
  QualifyCandidateInput, ReleaseDecisionInput, ReleaseRequestInput, ReleaseRollbackInput } from "./release-contracts.js";

export class EvolutionReleaseError extends RunControlError {
  constructor(code: string, status: number, message: string) { super(code, status, message); }
}
interface AssignmentRow { tenant_id: string; integration_id: string; state: EvolutionReleaseAssignment["state"];
  routing: EvolutionReleaseAssignment["routing"]; candidate_id: string | null; qualification_id: string | null;
  version: string; fraction_bps: number; salt: string; activated_at: Date | null; promoted_at: Date | null;
  updated_at: Date; canary_ready?: boolean }
interface RequestRow { id: string; tenant_id: string; integration_id: string; target: ReleaseRequestInput["target"];
  candidate_id: string; qualification_id: string; expected_assignment_version: string; candidate_bps: number;
  maker_actor_type: "user"; maker_actor_id: string; command_key: string; request_hash: string;
  status: EvolutionReleaseRequest["status"]; expires_at: Date; created_at: Date; expired?: boolean;
  revoke_command_key?: string | null; revoke_request_hash?: string | null }

export class PgEvolutionReleaseStore {
  constructor(private readonly db: HarnessDatabase) {}

  async qualify(principal: RunPrincipal, input: QualifyCandidateInput, currentManifest: RunVersionManifest): Promise<EvolutionReleaseQualification> {
    requireRunPermission(principal, "evolution:release:qualify");
    const policy = evolutionReleasePolicy();
    if (!policy.activationEnabled) throw releaseError("EVOLUTION_RELEASE_DISABLED", 409, "Evolution release activation is disabled");
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockScope(client, principal, "exclusive");
      try {
        const requestHash = fingerprint({ candidateId: input.candidateId, datasetId: input.datasetId,
          validationEvaluationId: input.validationEvaluationId, holdoutEvaluationId: input.holdoutEvaluationId });
        const replay = await client.query<QualificationRow>(`SELECT * FROM pr_agent_harness.evolution_release_qualifications
          WHERE tenant_id=$1 AND integration_id=$2 AND created_by_actor_type=$3 AND created_by_actor_id=$4 AND command_key=$5`,
        [principal.tenantId, principal.integrationId, principal.actorType, principal.subjectId, input.commandKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== requestHash) throw releaseError("RELEASE_QUALIFICATION_CONFLICT", 409, "Qualification key was reused");
          return mapQualification(replay.rows[0]);
        }
        const evidence = await evaluateOfflineReleaseGates(client, { tenantId: principal.tenantId,
          integrationId: principal.integrationId, candidateId: input.candidateId, datasetId: input.datasetId,
          validationEvaluationId: input.validationEvaluationId, holdoutEvaluationId: input.holdoutEvaluationId,
          policy, currentManifest });
        const policyHash = evolutionReleasePolicyHash(policy); const evidenceHash = fingerprint(evidence);
        const id = randomUUID(); const inserted = await client.query<QualificationRow>(
          `INSERT INTO pr_agent_harness.evolution_release_qualifications
             (id,tenant_id,integration_id,candidate_id,dataset_id,dataset_version,validation_evaluation_id,
              holdout_evaluation_id,policy_json,policy_hash,evidence_json,evidence_hash,created_by_actor_type,created_by_actor_id,
              command_key,request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,$16) RETURNING *`,
          [id, principal.tenantId, principal.integrationId, input.candidateId, input.datasetId,
            evidence.datasetVersion, input.validationEvaluationId, input.holdoutEvaluationId, JSON.stringify(policy),
            policyHash, JSON.stringify(evidence), evidenceHash, principal.actorType, principal.subjectId,
            input.commandKey, requestHash]);
        return mapQualification(inserted.rows[0]!);
      } catch (error) {
        if (error instanceof EvolutionReleaseGateError) throw releaseError(error.code, 409, error.message);
        throw error;
      }
    });
  }

  async request(principal: RunPrincipal, input: ReleaseRequestInput, currentManifest: RunVersionManifest): Promise<EvolutionReleaseRequest> {
    requireRunPermission(principal, "evolution:release:request"); requireUser(principal);
    const policy = evolutionReleasePolicy();
    if (!policy.activationEnabled) throw releaseError("EVOLUTION_RELEASE_DISABLED", 409, "Evolution release activation is disabled");
    const requestHash = fingerprint(input);
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockScope(client, principal, "exclusive");
      const duplicate = await client.query<RequestRow>(
        `SELECT * FROM pr_agent_harness.evolution_release_requests WHERE tenant_id=$1 AND integration_id=$2
           AND maker_actor_id=$3 AND command_key=$4`,
        [principal.tenantId, principal.integrationId, principal.subjectId, input.commandKey]);
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) throw releaseError("RELEASE_REQUEST_CONFLICT", 409, "Idempotency key was reused");
        return mapRequest(duplicate.rows[0]);
      }
      await assertQualificationFresh(client, principal, input.candidateId, input.qualificationId, currentManifest, policy);
      const assignment = await selectAssignment(client, principal, true);
      if ((assignment ? Number(assignment.version) : 0) !== input.expectedVersion) throw releaseError("RELEASE_VERSION_CONFLICT", 409, "Release assignment version changed");
      assertTargetState(input.target, assignment);
      if (input.target !== "shadow" && (assignment?.candidate_id !== input.candidateId
          || assignment.qualification_id !== input.qualificationId)) {
        throw releaseError("RELEASE_IDENTITY_CHANGED", 409, "Escalation must preserve the qualified candidate identity");
      }
      const id = randomUUID(); const candidateBps = input.target === "canary" ? input.candidateBps : 10_000;
      const row = await client.query<RequestRow>(
        `INSERT INTO pr_agent_harness.evolution_release_requests
           (id,tenant_id,integration_id,target,candidate_id,qualification_id,expected_assignment_version,candidate_bps,
            maker_actor_type,maker_actor_id,command_key,request_hash,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',$9,$10,$11,clock_timestamp()+interval '24 hours') RETURNING *`,
        [id, principal.tenantId, principal.integrationId, input.target, input.candidateId, input.qualificationId,
          input.expectedVersion, candidateBps, principal.subjectId, input.commandKey, requestHash]);
      return mapRequest(row.rows[0]!);
    });
  }

  async approve(principal: RunPrincipal, input: ReleaseDecisionInput, currentManifest: RunVersionManifest): Promise<EvolutionReleaseAssignment> {
    requireRunPermission(principal, "evolution:release:approve"); requireUser(principal);
    const policy = evolutionReleasePolicy();
    if (!policy.activationEnabled) throw releaseError("EVOLUTION_RELEASE_DISABLED", 409, "Evolution release activation is disabled");
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockScope(client, principal, "exclusive");
      const request = await lockRequest(client, principal, input.requestId);
      if (request.maker_actor_id === principal.subjectId) throw releaseError("MAKER_CHECKER_REQUIRED", 409, "Release checker must differ from maker");
      const decisionHash = fingerprint(input);
      const existing = await client.query<{ request_hash: string; after_json: ReturnType<typeof assignmentSnapshot> | null;
        receipt_created_at: Date | null; evidence_json: Record<string, unknown> | null; evidence_hash: string | null }>(
        `SELECT d.request_hash,rr.after_json,rr.created_at AS receipt_created_at,rr.evidence_json,rr.evidence_hash
         FROM pr_agent_harness.evolution_release_decisions d
         LEFT JOIN pr_agent_harness.evolution_release_receipts rr
           ON rr.tenant_id=d.tenant_id AND rr.request_id=d.request_id
         WHERE d.tenant_id=$1 AND d.integration_id=$2 AND d.checker_actor_id=$3 AND d.command_key=$4`,
        [principal.tenantId, principal.integrationId, principal.subjectId, input.commandKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== decisionHash) throw releaseError("RELEASE_DECISION_CONFLICT", 409, "Decision key was reused");
        if (existing.rows[0].after_json && existing.rows[0].receipt_created_at) {
          if (!existing.rows[0].evidence_json || fingerprint(existing.rows[0].evidence_json) !== existing.rows[0].evidence_hash) {
            throw releaseError("RELEASE_RECEIPT_INVALID", 409, "Release receipt evidence hash is invalid");
          }
          return assignmentFromSnapshot(principal, existing.rows[0].after_json, existing.rows[0].receipt_created_at);
        }
        return mapAssignment(await selectAssignment(client, principal, false) ?? baselineAssignment(principal));
      }
      if (request.status !== "open" || request.expired) throw releaseError("RELEASE_REQUEST_EXPIRED", 409, "Release request is not open");
      const assignment = await selectAssignment(client, principal, true);
      if ((assignment ? Number(assignment.version) : 0) !== Number(request.expected_assignment_version)) {
        throw releaseError("RELEASE_VERSION_CONFLICT", 409, "Release assignment version changed");
      }
      const qualification = await assertQualificationFresh(client, principal, request.candidate_id,
        request.qualification_id, currentManifest, policy);
      await client.query(
        `INSERT INTO pr_agent_harness.evolution_release_decisions
           (tenant_id,integration_id,request_id,decision,checker_actor_type,checker_actor_id,command_key,request_hash)
         VALUES ($1,$2,$3,$4,'user',$5,$6,$7)`,
        [principal.tenantId, principal.integrationId, request.id, input.decision, principal.subjectId, input.commandKey, decisionHash]);
      if (input.decision === "reject") {
        await client.query(`UPDATE pr_agent_harness.evolution_release_requests SET status='rejected',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, request.id]);
        return mapAssignment(assignment ?? baselineAssignment(principal));
      }
      let metrics: ReturnType<typeof computeCanaryMetrics> | undefined;
      if (request.target === "promote") {
        if (!assignment?.canary_ready) {
          throw releaseError("CANARY_WINDOW_INCOMPLETE", 409, "Canary window has not completed");
        }
        metrics = await loadCanaryMetrics(client, principal, Number(assignment.version));
        if (!canPromoteCanary(metrics)) throw releaseError("CANARY_GATE_FAILED", 409, "Canary metrics do not permit promotion");
      }
      const before = assignment ? assignmentSnapshot(assignment) : assignmentSnapshot(baselineAssignment(principal));
      const nextVersion = (assignment ? Number(assignment.version) : 0) + 1;
      const next = transition(request, nextVersion, assignment);
      const updated = assignment
        ? await client.query<AssignmentRow>(`UPDATE pr_agent_harness.evolution_release_assignments SET
            state=$3,routing=$4,candidate_id=$5,qualification_id=$6,version=$7,fraction_bps=$8,
            activated_at=$9,promoted_at=$10,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND integration_id=$2 AND version=$11 RETURNING *`,
          [principal.tenantId, principal.integrationId, next.state, next.routing, request.candidate_id,
            request.qualification_id, nextVersion, next.fractionBps, next.activatedAt, next.promotedAt, Number(assignment.version)])
        : await client.query<AssignmentRow>(`INSERT INTO pr_agent_harness.evolution_release_assignments
            (tenant_id,integration_id,state,routing,candidate_id,qualification_id,version,fraction_bps,salt,activated_at,promoted_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [principal.tenantId, principal.integrationId, next.state, next.routing, request.candidate_id,
            request.qualification_id, nextVersion, next.fractionBps, fingerprint(randomUUID()), next.activatedAt, next.promotedAt]);
      if (!updated.rows[0]) throw releaseError("RELEASE_VERSION_CONFLICT", 409, "Release assignment changed concurrently");
      await client.query(`UPDATE pr_agent_harness.evolution_release_requests SET status='consumed',consumed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, request.id]);
      await insertReceipt(client, principal, request, before, assignmentSnapshot(updated.rows[0]), {
        schemaVersion: 1, qualification: qualification.evidence,
        qualificationEvidenceHash: qualification.evidenceHash, policyHash: qualification.policyHash,
        canaryMetrics: metrics ?? null,
      }, input.commandKey, decisionHash);
      return mapAssignment(updated.rows[0]);
    });
  }

  async revoke(principal: RunPrincipal, requestId: string, commandKey: string): Promise<EvolutionReleaseRequest> {
    requireRunPermission(principal, "evolution:release:revoke"); requireUser(principal);
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockScope(client, principal, "exclusive"); const row = await lockRequest(client, principal, requestId);
      if (row.maker_actor_id !== principal.subjectId) throw releaseError("RELEASE_REQUEST_NOT_FOUND", 404, "Release request was not found");
      const requestHash = fingerprint({ requestId });
      if (row.status === "revoked") {
        if (row.revoke_command_key !== commandKey || row.revoke_request_hash !== requestHash) {
          throw releaseError("RELEASE_REVOKE_CONFLICT", 409, "Revocation idempotency key was reused");
        }
        return mapRequest(row);
      }
      if (row.status !== "open") throw releaseError("RELEASE_REQUEST_CONSUMED", 409, "Release request is no longer revocable");
      await client.query(`UPDATE pr_agent_harness.evolution_release_requests SET status='revoked',revoke_command_key=$3,
        revoke_request_hash=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, requestId, commandKey, requestHash]);
      return mapRequest({ ...row, status: "revoked", revoke_command_key: commandKey, revoke_request_hash: requestHash });
    });
  }

  async rollback(principal: RunPrincipal, input: ReleaseRollbackInput): Promise<EvolutionReleaseAssignment> {
    requireRunPermission(principal, "evolution:release:rollback");
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockScope(client, principal, "exclusive");
      const requestHash = fingerprint({ expectedVersion: input.expectedVersion, reason: input.reason });
      const replay = await client.query<{ request_hash: string; after_json: ReturnType<typeof assignmentSnapshot>;
        created_at: Date; evidence_json: Record<string, unknown>; evidence_hash: string }>(
        `SELECT request_hash,after_json,created_at,evidence_json,evidence_hash FROM pr_agent_harness.evolution_release_receipts
         WHERE tenant_id=$1 AND integration_id=$2 AND actor_type=$3 AND actor_id=$4 AND command_key=$5`,
        [principal.tenantId, principal.integrationId, principal.actorType, principal.subjectId, input.commandKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw releaseError("RELEASE_ROLLBACK_CONFLICT", 409, "Rollback key was reused");
        if (fingerprint(replay.rows[0].evidence_json) !== replay.rows[0].evidence_hash) {
          throw releaseError("RELEASE_RECEIPT_INVALID", 409, "Release receipt evidence hash is invalid");
        }
        return assignmentFromSnapshot(principal, replay.rows[0].after_json, replay.rows[0].created_at);
      }
      const assignment = requireAssignment(await selectAssignment(client, principal, true));
      if (Number(assignment.version) !== input.expectedVersion) throw releaseError("RELEASE_VERSION_CONFLICT", 409, "Release assignment version changed");
      const nextVersion = input.expectedVersion + 1; const before = assignmentSnapshot(assignment);
      const updated = await client.query<AssignmentRow>(`UPDATE pr_agent_harness.evolution_release_assignments SET
        state='rolled_back',routing='off',candidate_id=NULL,qualification_id=NULL,version=$3,fraction_bps=0,
        activated_at=NULL,promoted_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND integration_id=$2 AND version=$4 RETURNING *`,
      [principal.tenantId, principal.integrationId, nextVersion, input.expectedVersion]);
      if (!updated.rows[0]) throw releaseError("RELEASE_VERSION_CONFLICT", 409, "Release assignment changed concurrently");
      const rollbackEvidence = { schemaVersion: 1, rollback: { expectedVersion: input.expectedVersion, reason: input.reason } };
      await client.query(`INSERT INTO pr_agent_harness.evolution_release_receipts
        (tenant_id,integration_id,kind,assignment_version,before_json,after_json,evidence_json,evidence_hash,actor_type,actor_id,command_key,request_hash)
        VALUES ($1,$2,'rollback',$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)`, [principal.tenantId, principal.integrationId,
        nextVersion, JSON.stringify(before), JSON.stringify(assignmentSnapshot(updated.rows[0])), JSON.stringify(rollbackEvidence),
        fingerprint(rollbackEvidence), principal.actorType, principal.subjectId, input.commandKey, requestHash]);
      return mapAssignment(updated.rows[0]);
    });
  }

  async read(principal: RunPrincipal): Promise<EvolutionReleaseAssignment> {
    requireRunPermission(principal, "evolution:release:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockScope(client, principal, "shared");
      return mapAssignment(await selectAssignment(client, principal, false) ?? baselineAssignment(principal));
    });
  }
}

interface QualificationRow { id: string; tenant_id: string; integration_id: string; candidate_id: string; dataset_id: string;
  policy_hash: string; evidence_hash: string; evidence_json: EvolutionReleaseQualification["evidence"];
  created_by_actor_type: "user" | "service"; created_by_actor_id: string; command_key: string;
  request_hash: string; created_at: Date }
function mapQualification(row: QualificationRow): EvolutionReleaseQualification { return { id: row.id, tenantId: row.tenant_id,
  integrationId: row.integration_id, candidateId: row.candidate_id, datasetId: row.dataset_id, policyHash: row.policy_hash,
  evidenceHash: row.evidence_hash, evidence: row.evidence_json,
  createdBy: { type: row.created_by_actor_type, id: row.created_by_actor_id }, createdAt: row.created_at.toISOString() }; }
function mapAssignment(row: AssignmentRow): EvolutionReleaseAssignment { return { tenantId: row.tenant_id,
  integrationId: row.integration_id, state: row.state, routing: row.routing, version: Number(row.version),
  ...(row.candidate_id ? { candidateId: row.candidate_id } : {}), ...(row.qualification_id ? { qualificationId: row.qualification_id } : {}),
  candidateBps: row.fraction_bps, routingSalt: row.salt, ...(row.activated_at ? { activatedAt: row.activated_at.toISOString() } : {}),
  ...(row.promoted_at ? { promotedAt: row.promoted_at.toISOString() } : {}), updatedAt: row.updated_at.toISOString() }; }
function mapRequest(row: RequestRow): EvolutionReleaseRequest { return { id: row.id, target: row.target,
  candidateId: row.candidate_id, qualificationId: row.qualification_id, expectedVersion: Number(row.expected_assignment_version),
  candidateBps: row.candidate_bps, status: row.status, makerId: row.maker_actor_id, requestHash: row.request_hash,
  expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString() }; }
async function lockScope(client: PoolClient, principal: RunPrincipal, mode: "shared" | "exclusive") {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,1830))", [principal.tenantId]);
  const fn = mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
  await client.query(`SELECT ${fn}(hashtextextended($1::text,2001))`, [`${principal.tenantId}:${principal.integrationId}`]);
  const binding = await client.query(`SELECT 1 FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2`,
    [principal.tenantId, principal.integrationId]);
  if (!binding.rowCount) throw releaseError("RELEASE_SCOPE_NOT_FOUND", 404, "Release scope was not found");
}
async function selectAssignment(client: PoolClient, principal: RunPrincipal, lock: boolean): Promise<AssignmentRow | undefined> {
  return (await client.query<AssignmentRow>(`SELECT *,activated_at<=clock_timestamp()-interval '24 hours' AS canary_ready
    FROM pr_agent_harness.evolution_release_assignments
    WHERE tenant_id=$1 AND integration_id=$2${lock ? " FOR UPDATE" : ""}`, [principal.tenantId, principal.integrationId])).rows[0];
}
async function lockRequest(client: PoolClient, principal: RunPrincipal, id: string): Promise<RequestRow> {
  const row = (await client.query<RequestRow>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM pr_agent_harness.evolution_release_requests
    WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`, [principal.tenantId, principal.integrationId, id])).rows[0];
  if (!row) throw releaseError("RELEASE_REQUEST_NOT_FOUND", 404, "Release request was not found"); return row;
}
async function assertQualificationFresh(client: PoolClient, principal: RunPrincipal, candidateId: string, id: string,
  currentManifest: RunVersionManifest, policy: ReturnType<typeof evolutionReleasePolicy>): Promise<{
    evidenceHash: string; evidence: EvolutionReleaseQualification["evidence"]; policyHash: string }> {
  const found = await client.query<QualificationRow>(`SELECT * FROM pr_agent_harness.evolution_release_qualifications
    WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND candidate_id=$4`, [principal.tenantId, principal.integrationId, id, candidateId]);
  if (!found.rowCount) throw releaseError("RELEASE_QUALIFICATION_NOT_FOUND", 404, "Release qualification was not found");
  const row = found.rows[0]!;
  if (row.policy_hash !== evolutionReleasePolicyHash(policy)) {
    throw releaseError("RELEASE_QUALIFICATION_STALE", 409, "Release qualification policy is stale");
  }
  try {
    const evidence = await evaluateOfflineReleaseGates(client, { tenantId: principal.tenantId,
      integrationId: principal.integrationId, candidateId, datasetId: row.dataset_id,
      validationEvaluationId: row.evidence_json.validationEvaluationId,
      holdoutEvaluationId: row.evidence_json.holdoutEvaluationId, policy, currentManifest });
    if (fingerprint(evidence) !== row.evidence_hash) {
      throw releaseError("RELEASE_QUALIFICATION_STALE", 409, "Release qualification evidence changed");
    }
  } catch (error) {
    if (error instanceof EvolutionReleaseError) throw error;
    if (error instanceof EvolutionReleaseGateError) throw releaseError("RELEASE_QUALIFICATION_STALE", 409, error.message);
    throw error;
  }
  return { evidenceHash: row.evidence_hash, evidence: row.evidence_json, policyHash: row.policy_hash };
}
function assertTargetState(target: ReleaseRequestInput["target"], assignment?: AssignmentRow): void {
  if ((target === "shadow" && assignment && assignment.routing !== "off")
      || (target === "canary" && assignment?.routing !== "shadow")
      || (target === "promote" && assignment?.routing !== "canary")) {
    throw releaseError("RELEASE_TRANSITION_INVALID", 409, "Release transition is invalid");
  }
}
function transition(request: RequestRow, version: number, previous?: AssignmentRow) {
  if (request.target === "shadow") return { state: "evaluated_experimental", routing: "shadow", fractionBps: 10_000,
    activatedAt: new Date(), promotedAt: null } as const;
  if (request.target === "canary") return { state: "approved_canary", routing: "canary", fractionBps: request.candidate_bps,
    activatedAt: new Date(), promotedAt: null } as const;
  return { state: "promoted", routing: "full", fractionBps: 10_000,
    activatedAt: previous?.activated_at ?? new Date(), promotedAt: new Date(), version } as const;
}
function baselineAssignment(principal: RunPrincipal): AssignmentRow { return { tenant_id: principal.tenantId,
  integration_id: principal.integrationId, state: "rolled_back", routing: "off", candidate_id: null,
  qualification_id: null, version: "0", fraction_bps: 0, salt: fingerprint("baseline"), activated_at: null,
  promoted_at: null, updated_at: new Date(0) }; }
function assignmentSnapshot(row: AssignmentRow) { return { state: row.state, routing: row.routing,
  candidateId: row.candidate_id, qualificationId: row.qualification_id, version: Number(row.version),
  candidateBps: row.fraction_bps, routingSalt: row.salt,
  activatedAt: row.activated_at?.toISOString() ?? null, promotedAt: row.promoted_at?.toISOString() ?? null }; }
function assignmentFromSnapshot(principal: RunPrincipal, value: ReturnType<typeof assignmentSnapshot>, createdAt: Date): EvolutionReleaseAssignment {
  return { tenantId: principal.tenantId, integrationId: principal.integrationId, state: value.state,
    routing: value.routing, version: value.version, ...(value.candidateId ? { candidateId: value.candidateId } : {}),
    ...(value.qualificationId ? { qualificationId: value.qualificationId } : {}), candidateBps: value.candidateBps,
    routingSalt: value.routingSalt, ...(value.activatedAt ? { activatedAt: value.activatedAt } : {}),
    ...(value.promotedAt ? { promotedAt: value.promotedAt } : {}), updatedAt: createdAt.toISOString() };
}
async function insertReceipt(client: PoolClient, principal: RunPrincipal, request: RequestRow,
  before: unknown, after: unknown, evidence: Record<string, unknown>, commandKey: string, requestHash: string): Promise<void> {
  await client.query(`INSERT INTO pr_agent_harness.evolution_release_receipts
    (tenant_id,integration_id,request_id,kind,assignment_version,before_json,after_json,evidence_json,evidence_hash,actor_type,actor_id,command_key,request_hash)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`, [principal.tenantId, principal.integrationId,
    request.id, request.target, Number(request.expected_assignment_version) + 1, JSON.stringify(before), JSON.stringify(after),
    JSON.stringify(evidence), fingerprint(evidence), principal.actorType, principal.subjectId, commandKey, requestHash]);
}
async function loadCanaryMetrics(client: PoolClient, principal: RunPrincipal, version: number) {
  const rows = await client.query<{ selection: "control" | "candidate"; status: CanaryObservation["status"];
    analysis_status: CanaryObservation["analysisStatus"] | null; cost_micros: string | null; latency_ms: string | null;
    publication_unknown: boolean }>(`SELECT a.selection,r.status,art.artifact_json->>'analysisStatus' analysis_status,
      (SELECT CASE WHEN count(m.id)>0 AND count(u.id) FILTER
         (WHERE m.status='succeeded' AND u.measurement_status='actual')=count(m.id)
         THEN sum(u.cost_micros)::text END FROM pr_agent_harness.model_calls m
         LEFT JOIN pr_agent_harness.usage_records u ON u.tenant_id=m.tenant_id AND u.model_call_id=m.id
         WHERE m.tenant_id=r.tenant_id AND m.run_id=r.id) cost_micros,
      extract(epoch FROM (r.finished_at-(SELECT min(ev.created_at) FROM pr_agent_harness.run_events ev
        WHERE ev.tenant_id=r.tenant_id AND ev.run_id=r.id AND ev.event_type='run.claimed')))*1000 latency_ms,
      EXISTS(SELECT 1 FROM pr_agent_harness.run_publication_batches l JOIN pr_agent_harness.publication_batch_operations bo
        ON bo.tenant_id=l.tenant_id AND bo.batch_id=l.batch_id JOIN pr_agent_harness.repository_operations o
        ON o.tenant_id=bo.tenant_id AND o.business_operation_id=bo.business_operation_id
        WHERE l.tenant_id=r.tenant_id AND l.run_id=r.id
          AND o.status IN ('prepared','in_flight','unknown','manual_review')) publication_unknown
    FROM pr_agent_harness.evolution_run_assignments a JOIN pr_agent_harness.evolution_release_receipts rr
      ON rr.tenant_id=a.tenant_id AND rr.integration_id=a.integration_id
     AND rr.id=a.release_receipt_id AND rr.assignment_version=a.assignment_version
    JOIN pr_agent_harness.agent_runs r
      ON r.tenant_id=a.tenant_id AND r.integration_id=a.integration_id AND r.id=a.run_id
    LEFT JOIN pr_agent_harness.review_artifacts art ON art.tenant_id=r.tenant_id AND art.run_id=r.id
    WHERE a.tenant_id=$1 AND a.integration_id=$2 AND a.assignment_version=$3 AND a.selection IN ('control','candidate')`,
  [principal.tenantId, principal.integrationId, version]);
  return computeCanaryMetrics(rows.rows.map((row) => ({ selection: row.selection, status: row.status,
    ...(row.analysis_status ? { analysisStatus: row.analysis_status } : {}),
    ...(row.cost_micros === null ? {} : { costMicros: Number(row.cost_micros) }),
    ...(row.latency_ms === null ? {} : { latencyMs: Number(row.latency_ms) }), publicationUnknown: row.publication_unknown })));
}
function requireAssignment(row: AssignmentRow | undefined): AssignmentRow {
  if (!row) throw releaseError("RELEASE_ASSIGNMENT_NOT_FOUND", 404, "Release assignment was not found"); return row;
}
function requireUser(principal: RunPrincipal): void {
  if (principal.actorType !== "user") throw releaseError("HUMAN_APPROVAL_REQUIRED", 403, "A human actor is required");
}
function releaseError(code: string, status: number, message: string): EvolutionReleaseError {
  return new EvolutionReleaseError(code, status, message);
}
