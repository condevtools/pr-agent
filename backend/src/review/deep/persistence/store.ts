import type { PoolClient } from "pg";

import type {
  CriticDecision,
  DeepReviewArtifact,
  DeepReviewStore as DeepReviewStorePort,
  EvidenceRecord,
  FindingCandidate,
  GateDecision,
} from "../contracts.js";
import { RuntimeDatabase } from "../../../agent-runtime/postgres/database.js";
import { assertRunLease } from "../../../agent-runtime/execution/store.js";
import type { RunPrincipal } from "../../../agent-runtime/runs/control-contracts.js";
import { requireRunPermission, runNotFound } from "../../../agent-runtime/runs/control-contracts.js";
import type { RunLease } from "../../../agent-runtime/runs/contracts.js";
import { fingerprint } from "../../../agent-runtime/versions.js";
import { redactRepositoryText } from "../../../repository/content-safety/repository-content.js";

interface SuccessfulStepRow {
  step_id: string;
  step_kind: string;
  output_value: unknown;
  attempt_id: string;
  tool_call_id: string | null;
  tool_name: string | null;
  request_hash: string | null;
}

export class DeepReviewStore implements DeepReviewStorePort {
  constructor(private readonly db: RuntimeDatabase) {}

  async loadArtifact(lease: RunLease): Promise<DeepReviewArtifact | undefined> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const run = await selectRunScope(client, lease);
      const result = await client.query<{
        artifact_json: DeepReviewArtifact; content_hash: string; content_purged_at: Date | null;
      }>(
        `SELECT artifact_json,content_hash,content_purged_at
         FROM pr_agent_harness.review_artifacts
         WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND head_sha=$4`,
        [lease.tenantId, lease.integrationId, lease.runId, lease.headSha],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      if (row.content_purged_at || fingerprint(row.artifact_json) !== row.content_hash) {
        throw new DeepReviewEvidenceError("artifact_recovery_invalid");
      }
      const identity = row.artifact_json.identity;
      if (identity.tenantId !== lease.tenantId || identity.integrationId !== lease.integrationId
          || identity.runId !== lease.runId || identity.platform !== run.platform
          || identity.repository !== run.repository || identity.baseSha !== lease.baseSha
          || identity.headSha !== lease.headSha || row.artifact_json.workflowId !== "review.deep.v1"
          || row.artifact_json.publicationMode !== "shadow") {
        throw new DeepReviewEvidenceError("artifact_scope_mismatch");
      }
      return row.artifact_json;
    });
  }

  async registerEvidence(lease: RunLease, stepKey: string, record: EvidenceRecord): Promise<void> {
    requireHash(record.id, "evidence id");
    requireHash(record.contentHash, "evidence content hash");
    if (record.status !== "succeeded" || record.runId !== lease.runId || record.headSha !== lease.headSha) {
      throw new DeepReviewEvidenceError("evidence_scope_mismatch");
    }
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const run = await selectRunScope(client, lease);
      const step = await successfulStep(client, lease, stepKey);
      if (step.step_kind !== "tool" || !step.tool_call_id || !step.tool_name || !step.request_hash) {
        throw new DeepReviewEvidenceError("evidence_step_not_successful_tool");
      }
      assertAuthoritativeOutput(step.output_value, record);
      const requestHash = (record as EvidenceRecord & { requestHash?: unknown }).requestHash;
      if (requestHash !== step.request_hash) throw new DeepReviewEvidenceError("evidence_request_mismatch");
      const location = { path: record.path, startLine: record.startLine, endLine: record.endLine };
      const expectedId = fingerprint({ tenantId: lease.tenantId, integrationId: lease.integrationId,
        runId: lease.runId, platform: run.platform, repository: run.repository,
        baseSha: lease.baseSha, headSha: lease.headSha,
        toolName: step.tool_name, requestHash, contentHash: record.contentHash, location });
      if (record.id !== expectedId) throw new DeepReviewEvidenceError("evidence_identity_invalid");
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.evidence_records
           (id,tenant_id,integration_id,run_id,step_id,step_attempt_id,tool_call_id,
            repository,head_sha,evidence_kind,tool_name,request_hash,content_hash,path,
            start_line,end_line,summary,truncated,result_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
         ON CONFLICT (tenant_id,id) DO NOTHING RETURNING id`,
        [record.id, lease.tenantId, lease.integrationId, lease.runId, step.step_id, step.attempt_id,
          step.tool_call_id, run.repository, lease.headSha, record.kind, step.tool_name,
          step.request_hash, record.contentHash, record.path ?? null, record.startLine ?? null,
          record.endLine ?? null, record.summary, record.truncated, JSON.stringify(record)],
      );
      if (!inserted.rowCount) await assertImmutableRecord(client, "evidence_records", lease.tenantId, record.id, record);
    });
  }

  async registerCandidates(lease: RunLease, stepKey: string, records: readonly FindingCandidate[]): Promise<void> {
    await this.registerStepRecords(lease, stepKey, "coordination", records, async (client, stepId, record) => {
      requireHash(record.id, "candidate id");
      const hash = fingerprint(record);
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.finding_candidates
           (id,tenant_id,integration_id,run_id,step_id,source_role,head_sha,content_hash,record_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (tenant_id,run_id,id) DO NOTHING RETURNING id`,
        [record.id, lease.tenantId, lease.integrationId, lease.runId, stepId,
          record.sourceRole, lease.headSha, hash, JSON.stringify(record)],
      );
      if (!inserted.rowCount) await assertImmutableRecord(client, "finding_candidates", lease.tenantId,
        record.id, record, lease.runId);
    });
  }

  async registerDecisions(
    lease: RunLease,
    stepKey: string,
    stage: "critic" | "gate",
    records: readonly CriticDecision[] | readonly GateDecision[],
  ): Promise<void> {
    await this.registerStepRecords<CriticDecision | GateDecision>(lease, stepKey,
      stage === "critic" ? "coordination" : "verification",
      records as readonly (CriticDecision | GateDecision)[],
      async (client, stepId, record) => {
        const candidateId = record.candidateId;
        requireHash(candidateId, "decision candidate id");
        const candidate = await client.query(
          `SELECT 1 FROM pr_agent_harness.finding_candidates
           WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND head_sha=$4 AND content_purged_at IS NULL`,
          [lease.tenantId, lease.runId, candidateId, lease.headSha],
        );
        if (!candidate.rowCount) throw new DeepReviewEvidenceError("decision_candidate_missing");
        const id = fingerprint({ tenantId: lease.tenantId, integrationId: lease.integrationId,
          runId: lease.runId, headSha: lease.headSha, stage, record });
        const hash = fingerprint(record);
        const inserted = await client.query(
          `INSERT INTO pr_agent_harness.finding_decisions
             (id,tenant_id,integration_id,run_id,step_id,candidate_id,stage,head_sha,content_hash,record_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT (tenant_id,id) DO NOTHING RETURNING id`,
          [id, lease.tenantId, lease.integrationId, lease.runId, stepId, candidateId,
            stage, lease.headSha, hash, JSON.stringify(record)],
        );
        if (!inserted.rowCount) await assertImmutableRecord(client, "finding_decisions", lease.tenantId, id, record);
      });
  }

  async loadUsableEvidence(lease: RunLease, ids: readonly string[]): Promise<Map<string, EvidenceRecord>> {
    if (ids.length > 500 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
      throw new DeepReviewEvidenceError("evidence_ids_invalid");
    }
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      await selectRunScope(client, lease);
      const result = await client.query<{ id: string; result_json: EvidenceRecord }>(
        `SELECT e.id,e.result_json
         FROM pr_agent_harness.evidence_records e
         JOIN pr_agent_harness.agent_steps s
           ON s.tenant_id=e.tenant_id AND s.run_id=e.run_id AND s.id=e.step_id
         JOIN pr_agent_harness.step_attempts a
           ON a.tenant_id=e.tenant_id AND a.run_id=e.run_id AND a.id=e.step_attempt_id
         JOIN pr_agent_harness.tool_calls t
           ON t.tenant_id=e.tenant_id AND t.run_id=e.run_id AND t.id=e.tool_call_id
         WHERE e.tenant_id=$1 AND e.integration_id=$2 AND e.run_id=$3 AND e.head_sha=$4
           AND e.id=ANY($5::text[]) AND e.content_purged_at IS NULL
           AND s.status='succeeded' AND a.status='succeeded' AND t.status='succeeded'`,
        [lease.tenantId, lease.integrationId, lease.runId, lease.headSha, [...new Set(ids)]],
      );
      return new Map(result.rows.map((row) => [row.id, row.result_json]));
    });
  }

  async saveArtifact(lease: RunLease, artifact: DeepReviewArtifact): Promise<void> {
    if (artifact.workflowId !== "review.deep.v1" || artifact.publicationMode !== "shadow"
        || artifact.identity.tenantId !== lease.tenantId || artifact.identity.integrationId !== lease.integrationId
        || artifact.identity.runId !== lease.runId || artifact.identity.baseSha !== lease.baseSha
        || artifact.identity.headSha !== lease.headSha) {
      throw new DeepReviewEvidenceError("artifact_scope_mismatch");
    }
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const run = await selectRunScope(client, lease);
      if (artifact.identity.repository !== run.repository) throw new DeepReviewEvidenceError("artifact_scope_mismatch");
      await assertArtifactLedgerComplete(client, lease, artifact);
      const hash = fingerprint(artifact);
      const id = fingerprint({ tenantId: lease.tenantId, integrationId: lease.integrationId,
        runId: lease.runId, repository: run.repository, baseSha: lease.baseSha,
        headSha: lease.headSha, workflowVersionHash: lease.workflowVersionHash, hash });
      const inserted = await client.query(
        `INSERT INTO pr_agent_harness.review_artifacts
           (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (tenant_id,run_id) DO NOTHING RETURNING id`,
        [id, lease.tenantId, lease.integrationId, lease.runId, artifact.workflowId,
          artifact.publicationMode, lease.headSha, hash, JSON.stringify(artifact)],
      );
      if (!inserted.rowCount) await assertImmutableArtifact(client, lease, hash);
    });
  }

  async readArtifact(principal: RunPrincipal, runId: string, options: { raw?: boolean } = {}): Promise<Record<string, unknown>> {
    requireRunPermission(principal, options.raw ? "runs:trace" : "runs:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      const result = await client.query<{ artifact_json: DeepReviewArtifact; content_hash: string; content_purged_at: Date | null }>(
        `SELECT a.artifact_json,a.content_hash,a.content_purged_at
         FROM pr_agent_harness.review_artifacts a
         JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=a.tenant_id AND r.integration_id=a.integration_id AND r.id=a.run_id
         JOIN pr_agent_harness.integration_bindings b
           ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
         WHERE a.tenant_id=$1 AND a.integration_id=$2 AND a.run_id=$3`,
        [principal.tenantId, principal.integrationId, runId],
      );
      const row = result.rows[0];
      if (!row) throw runNotFound();
      if (row.content_purged_at) return { runId, contentHash: row.content_hash, contentPurged: true };
      if (options.raw) return row.artifact_json as unknown as Record<string, unknown>;
      const accepted = new Set(row.artifact_json.gateDecisions
        .filter((item) => item.accepted).map((item) => item.candidateId));
      return { runId, workflowId: row.artifact_json.workflowId,
        publicationMode: row.artifact_json.publicationMode,
        analysisStatus: row.artifact_json.analysisStatus, verdict: row.artifact_json.verdict,
        sourceCoverage: row.artifact_json.sourceCoverage, contentHash: row.content_hash,
        findings: row.artifact_json.candidates.filter((item) => accepted.has(item.id)).map((item) => ({
          id: item.id, sourceRole: item.sourceRole, severity: item.severity,
          title: redactRepositoryText(item.title).slice(0, 300),
          body: redactRepositoryText(item.body).slice(0, 4_000), location: item.location,
          evidenceIds: item.evidenceIds,
        })), coverage: row.artifact_json.coverage };
    });
  }

  private async registerStepRecords<T>(
    lease: RunLease,
    stepKey: string,
    expectedKind: string,
    records: readonly T[],
    insert: (client: PoolClient, stepId: string, record: T) => Promise<void>,
  ): Promise<void> {
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      await selectRunScope(client, lease);
      const step = await successfulStep(client, lease, stepKey);
      if (step.step_kind !== expectedKind) throw new DeepReviewEvidenceError("ledger_step_kind_mismatch");
      assertAuthoritativeOutput(step.output_value, records);
      for (const record of records) await insert(client, step.step_id, record);
    });
  }
}

async function successfulStep(client: PoolClient, lease: RunLease, stepKey: string): Promise<SuccessfulStepRow> {
  const result = await client.query<SuccessfulStepRow>(
    `SELECT s.id AS step_id,s.step_kind,s.output_json->'value' AS output_value,
            a.id AS attempt_id,t.id AS tool_call_id,t.tool_name,t.request_hash
     FROM pr_agent_harness.agent_steps s
     JOIN pr_agent_harness.step_attempts a
       ON a.tenant_id=s.tenant_id AND a.run_id=s.run_id AND a.step_id=s.id AND a.status='succeeded'
     LEFT JOIN pr_agent_harness.tool_calls t
       ON t.tenant_id=a.tenant_id AND t.run_id=a.run_id AND t.step_attempt_id=a.id AND t.status='succeeded'
     WHERE s.tenant_id=$1 AND s.run_id=$2 AND s.step_key=$3 AND s.status='succeeded'
     ORDER BY a.attempt_number DESC LIMIT 1`,
    [lease.tenantId, lease.runId, stepKey],
  );
  if (!result.rows[0]) throw new DeepReviewEvidenceError("ledger_step_not_succeeded");
  return result.rows[0];
}

async function selectRunScope(client: PoolClient, lease: RunLease): Promise<{ repository: string; platform: "github" | "gitlab" }> {
  const result = await client.query<{ repository: string; platform: "github" | "gitlab" }>(
    `SELECT b.repository,b.platform FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.integration_bindings b ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
     WHERE r.tenant_id=$1 AND r.id=$2 AND r.integration_id=$3 AND r.base_sha=$4 AND r.head_sha=$5
       AND r.workflow_version_hash=$6 AND r.prompt_version_hash=$7 AND r.model_version_hash=$8
       AND r.tool_version_hash=$9 AND r.policy_version_hash=$10 AND r.runtime_version_hash=$11`,
    [lease.tenantId, lease.runId, lease.integrationId, lease.baseSha, lease.headSha,
      lease.workflowVersionHash, lease.promptVersionHash, lease.modelVersionHash,
      lease.toolVersionHash, lease.policyVersionHash, lease.runtimeVersionHash],
  );
  if (!result.rows[0]) throw new DeepReviewEvidenceError("run_scope_mismatch");
  return result.rows[0];
}

function assertAuthoritativeOutput(actual: unknown, expected: unknown): void {
  if (fingerprint(actual) !== fingerprint(expected)) throw new DeepReviewEvidenceError("ledger_output_mismatch");
}

async function assertImmutableRecord(
  client: PoolClient,
  table: "evidence_records" | "finding_candidates" | "finding_decisions",
  tenantId: string,
  id: string,
  record: unknown,
  runId?: string,
): Promise<void> {
  const column = table === "evidence_records" ? "result_json" : "record_json";
  const result = await client.query<{ value: unknown }>(
    `SELECT ${column} AS value FROM pr_agent_harness.${table}
     WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR run_id=$3)`, [tenantId, id, runId ?? null]);
  if (!result.rows[0] || fingerprint(result.rows[0].value) !== fingerprint(record)) {
    throw new DeepReviewEvidenceError("immutable_ledger_conflict");
  }
}

async function assertArtifactLedgerComplete(client: PoolClient, lease: RunLease, artifact: DeepReviewArtifact): Promise<void> {
  const candidateIds = artifact.candidates.map((item) => item.id);
  const candidates = await client.query<{ id: string; record_json: unknown }>(
    `SELECT id,record_json FROM pr_agent_harness.finding_candidates
     WHERE tenant_id=$1 AND run_id=$2 AND head_sha=$3 AND id=ANY($4::text[]) AND content_purged_at IS NULL`,
    [lease.tenantId, lease.runId, lease.headSha, candidateIds],
  );
  const decisions = await client.query<{ stage: "critic" | "gate"; candidate_id: string; record_json: unknown }>(
    `SELECT stage,candidate_id,record_json FROM pr_agent_harness.finding_decisions
     WHERE tenant_id=$1 AND run_id=$2 AND head_sha=$3 AND candidate_id=ANY($4::text[]) AND content_purged_at IS NULL`,
    [lease.tenantId, lease.runId, lease.headSha, candidateIds],
  );
  const candidateRows = new Map(candidates.rows.map((row) => [row.id, fingerprint(row.record_json)]));
  const expectedCandidates = new Map(artifact.candidates.map((record) => [record.id, fingerprint(record)]));
  const decisionRows = new Map(decisions.rows.map((row) =>
    [`${row.stage}:${row.candidate_id}`, fingerprint(row.record_json)]));
  const expectedDecisions = new Map([
    ...artifact.criticDecisions.map((record) => [`critic:${record.candidateId}`, fingerprint(record)] as const),
    ...artifact.gateDecisions.map((record) => [`gate:${record.candidateId}`, fingerprint(record)] as const),
  ]);
  if (!mapsEqual(candidateRows, expectedCandidates) || !mapsEqual(decisionRows, expectedDecisions)) {
    throw new DeepReviewEvidenceError("artifact_ledger_incomplete");
  }
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

async function assertImmutableArtifact(client: PoolClient, lease: RunLease, hash: string): Promise<void> {
  const result = await client.query<{ content_hash: string }>(
    "SELECT content_hash FROM pr_agent_harness.review_artifacts WHERE tenant_id=$1 AND run_id=$2",
    [lease.tenantId, lease.runId],
  );
  if (result.rows[0]?.content_hash !== hash) throw new DeepReviewEvidenceError("immutable_artifact_conflict");
}

function requireHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

export class DeepReviewEvidenceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DeepReviewEvidenceError"; }
}
