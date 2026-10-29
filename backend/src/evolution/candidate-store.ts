import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { reviewTextHashes } from "../review/strategy/text-components.js";
import type { RunLease } from "../agent-runtime/runs/contracts.js";
import { RuntimeDatabase } from "../agent-runtime/postgres/database.js";
import { assertRunLease } from "../agent-runtime/execution/store.js";
import { requireRunPermission, RunControlError, type RunPrincipal } from "../agent-runtime/runs/control-contracts.js";
import { fingerprint } from "../agent-runtime/versions.js";
import {
  type EvolutionCandidateRecord,
  evolutionProposalSourceSchema, type EvolutionProposalSource,
} from "./candidate-contracts.js";
import { reviewStrategyTextSchema, type ReviewStrategyText } from "../review/strategy/contracts.js";

export class EvolutionCandidateError extends RunControlError {
  constructor(code: string, status: number, message: string) { super(code, status, message); }
}
export class PgEvolutionCandidateStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async loadSource(lease: RunLease): Promise<EvolutionProposalSource> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const row = await selectSource(client, lease.tenantId, lease.runId);
      if (!row || row.source_hash !== sourceHash(row.source_json)) {
        throw new EvolutionCandidateError("EVOLUTION_SOURCE_UNAVAILABLE", 409, "Frozen proposal source is unavailable");
      }
      return row.source_json;
    });
  }

  async saveCandidate(lease: RunLease, stepKey: string, raw: unknown, modelConfigHash: string): Promise<EvolutionCandidateRecord> {
    const candidate = reviewStrategyTextSchema.parse(raw); const candidateHash = fingerprint(candidate);
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "share" });
      const source = await selectSource(client, lease.tenantId, lease.runId);
      if (!source || source.source_hash !== sourceHash(source.source_json)) {
        throw new EvolutionCandidateError("EVOLUTION_SOURCE_UNAVAILABLE", 409, "Frozen proposal source is unavailable");
      }
      const step = await client.query<{ id: string; output: unknown }>(
        `SELECT id,output_json->'value' AS output FROM pr_agent_harness.agent_steps
         WHERE tenant_id=$1 AND run_id=$2 AND step_key=$3 AND step_kind='model' AND status='succeeded'`,
        [lease.tenantId, lease.runId, stepKey]);
      if (!step.rows[0] || fingerprint(step.rows[0].output) !== candidateHash) {
        throw new EvolutionCandidateError("EVOLUTION_STEP_MISMATCH", 409, "Candidate model step is not durably completed");
      }
      const id = randomUUID();
      const provenance = { schemaVersion: 1, proposalRunId: lease.runId, modelStepId: step.rows[0].id,
        sourceHash: source.source_hash, workflowVersionHash: lease.workflowVersionHash,
        promptVersionHash: lease.promptVersionHash, modelVersionHash: lease.modelVersionHash,
        runtimeVersionHash: lease.runtimeVersionHash };
      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO pr_agent_harness.evolution_candidates
           (id,tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,candidate_json,candidate_hash,
            baseline_prompt_hash,baseline_tool_hash,model_config_hash,source_hash,provenance_json,
            created_by_actor_type,created_by_actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
         ON CONFLICT (tenant_id,proposal_run_id) DO NOTHING RETURNING created_at`,
        [id, lease.tenantId, lease.runId, source.source_json.datasetId, source.source_json.datasetVersion,
          source.source_json.datasetManifestHash, JSON.stringify(candidate), candidateHash,
          source.source_json.baselinePromptHash, source.source_json.baselineToolHash, modelConfigHash,
          source.source_hash, JSON.stringify(provenance), source.created_by_actor_type, source.created_by_actor_id]);
      if (!inserted.rows[0]) {
        const existing = await selectCandidateByRun(client, lease.tenantId, lease.runId);
        if (!existing || existing.candidate_hash !== candidateHash || existing.model_config_hash !== modelConfigHash) {
          throw new EvolutionCandidateError("EVOLUTION_CANDIDATE_CONFLICT", 409, "Proposal Run already produced a different candidate");
        }
        return mapCandidate(existing);
      }
      return mapCandidate({ id, tenant_id: lease.tenantId, proposal_run_id: lease.runId,
        dataset_id: source.source_json.datasetId, dataset_version: String(source.source_json.datasetVersion),
        dataset_manifest_hash: source.source_json.datasetManifestHash, status: "research_draft", candidate_json: candidate,
        candidate_hash: candidateHash, baseline_prompt_hash: source.source_json.baselinePromptHash,
        baseline_tool_hash: source.source_json.baselineToolHash, model_config_hash: modelConfigHash,
        created_by_actor_type: source.created_by_actor_type, created_by_actor_id: source.created_by_actor_id,
        created_at: inserted.rows[0].created_at });
    });
  }

  async read(principal: RunPrincipal, candidateId: string): Promise<EvolutionCandidateRecord> {
    requireRunPermission(principal, "evaluations:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      const result = await client.query<CandidateRow>(
        `SELECT c.* FROM pr_agent_harness.evolution_candidates c
         JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=c.tenant_id AND r.id=c.proposal_run_id
          AND r.run_type='evolution.propose.v1' AND r.input_json->>'workflow'='evolution.propose.v1'
          AND r.status='succeeded'
         WHERE c.tenant_id=$1 AND (c.id=$2 OR c.proposal_run_id=$2)
           AND c.created_by_actor_type=$3 AND c.created_by_actor_id=$4
           AND c.content_purged_at IS NULL`,
        [principal.tenantId, candidateId, principal.actorType, principal.subjectId]);
      if (!result.rows[0]) throw new EvolutionCandidateError("CANDIDATE_NOT_FOUND", 404, "Evolution candidate was not found");
      return mapCandidate(result.rows[0]);
    });
  }
}

export async function insertEvolutionProposalSource(client: PoolClient, input: {
  tenantId: string; proposalRunId: string; source: EvolutionProposalSource;
  actorType: "user" | "service"; actorId: string;
}): Promise<void> {
  if (input.source.sourceHash !== sourceHash(input.source)) {
    throw new EvolutionCandidateError("EVOLUTION_SOURCE_HASH_INVALID", 409, "Proposal source hash is invalid");
  }
  const inserted = await client.query(
    `INSERT INTO pr_agent_harness.evolution_proposal_sources
       (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
        baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT (tenant_id,proposal_run_id) DO NOTHING RETURNING proposal_run_id`,
    [input.tenantId, input.proposalRunId, input.source.datasetId, input.source.datasetVersion,
      input.source.datasetManifestHash, input.source.baselinePromptHash, input.source.baselineToolHash,
      input.source.sourceHash, JSON.stringify(input.source), input.actorType, input.actorId]);
  if (!inserted.rowCount) {
    const existing = await selectSource(client, input.tenantId, input.proposalRunId);
    if (!existing || existing.source_hash !== input.source.sourceHash) {
      throw new EvolutionCandidateError("EVOLUTION_SOURCE_CONFLICT", 409, "Proposal source changed during admission");
    }
  }
}

function sourceHash(source: EvolutionProposalSource): string {
  const baseline = reviewTextHashes({ schemaVersion: 1, prompt_text: source.baselinePromptText,
    tool_description_text: source.baselineToolDescriptionText });
  if (baseline.promptHash !== source.baselinePromptHash || baseline.toolHash !== source.baselineToolHash) return "";
  const { sourceHash: _stored, ...content } = source;
  return fingerprint(content);
}

interface SourceRow {
  source_hash: string; source_json: EvolutionProposalSource;
  created_by_actor_type: "user" | "service"; created_by_actor_id: string;
}
interface CandidateRow {
  id: string; tenant_id: string; proposal_run_id: string; dataset_id: string; dataset_version: string;
  dataset_manifest_hash: string; status: "research_draft"; candidate_json: ReviewStrategyText; candidate_hash: string;
  baseline_prompt_hash: string; baseline_tool_hash: string; model_config_hash: string;
  created_by_actor_type: "user" | "service"; created_by_actor_id: string; created_at: Date;
}

async function selectSource(client: PoolClient, tenantId: string, runId: string): Promise<SourceRow | undefined> {
  const row = (await client.query<SourceRow>(
    `SELECT source_hash,source_json,created_by_actor_type,created_by_actor_id
     FROM pr_agent_harness.evolution_proposal_sources
     WHERE tenant_id=$1 AND proposal_run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId])).rows[0];
  return row ? { ...row, source_json: evolutionProposalSourceSchema.parse(row.source_json) } : undefined;
}

async function selectCandidateByRun(client: PoolClient, tenantId: string, runId: string): Promise<CandidateRow | undefined> {
  return (await client.query<CandidateRow>(
    `SELECT * FROM pr_agent_harness.evolution_candidates
     WHERE tenant_id=$1 AND proposal_run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId])).rows[0];
}

function mapCandidate(row: CandidateRow): EvolutionCandidateRecord {
  const candidate = reviewStrategyTextSchema.parse(row.candidate_json);
  if (fingerprint(candidate) !== row.candidate_hash) {
    throw new EvolutionCandidateError("EVOLUTION_CANDIDATE_HASH_INVALID", 409, "Candidate content hash is invalid");
  }
  return { id: row.id, tenantId: row.tenant_id, proposalRunId: row.proposal_run_id,
    datasetId: row.dataset_id, datasetVersion: Number(row.dataset_version), datasetManifestHash: row.dataset_manifest_hash,
    status: row.status, candidate, candidateHash: row.candidate_hash, baselinePromptHash: row.baseline_prompt_hash,
    baselineToolHash: row.baseline_tool_hash, modelConfigHash: row.model_config_hash,
    createdBy: { type: row.created_by_actor_type, id: row.created_by_actor_id }, createdAt: row.created_at.toISOString() };
}
