import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import type { DeepReviewArtifact } from "../agents/contracts.js";
import { evolutionProposalSourceSchema, type EvolutionCandidateV1, type EvolutionProposalSource } from "./candidate-contracts.js";
import type { DatasetFixtureV1 } from "./dataset-contracts.js";
import { validateDatasetFixture } from "./dataset-fixture.js";
import { scoreReplayArtifact } from "./replay-scorer.js";
import { EVALUATION_SCHEDULING_POLICY, EVALUATION_SCHEDULING_POLICY_HASH, REPLAY_VERIFIER_HASH,
  type EvaluationReceipt, type EvaluationSplit, type EvaluationVariant,
  type ReplayRunInput, type ReplayScoreV1 } from "./replay-contracts.js";
import { RuntimeDatabase } from "../agent-runtime/postgres/database.js";
import type { CreateRunInput } from "../agent-runtime/postgres/run-store.js";
import { createRunInTransaction } from "../agent-runtime/postgres/run-store.js";
import type { RunPrincipal } from "../agent-runtime/runs/control-contracts.js";
import { requireRunPermission, RunControlError } from "../agent-runtime/runs/control-contracts.js";
import { fingerprint, type RunVersionManifest } from "../agent-runtime/versions.js";

interface EvalRow {
  id: string; dataset_id: string; candidate_id: string; split: EvaluationSplit;
  status: EvaluationReceipt["status"]; version: string; planned_result_count: number;
  completed_result_count: number; failed_result_count: number; manifest_hash: string;
  metrics_json: Record<string, unknown> | null; created_at: Date; completed_at: Date | null;
}

export interface EvaluationLease { tenantId: string; evaluationId: string; owner: string; epoch: number }
export interface PendingReplayResult {
  id: string; evaluationId: string; datasetId: string; caseId: string; integrationId: string;
  candidateId: string; variant: EvaluationVariant; repetition: number; attemptIdentityHash: string;
  fixtureHash: string; labelSetId: string; labelSetHash: string; componentHash: string;
  expectedModelHash: string; expectedRuntimeHash: string; baseSha: string; headSha: string;
  expectedWorkflowHash: string; expectedPromptHash: string; expectedToolHash: string; expectedPolicyHash: string;
  baselineText: EvolutionCandidateV1; candidateText: EvolutionCandidateV1;
}

export class EvaluationStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async admit(principal: RunPrincipal, input: { datasetId: string; candidateId: string; split: EvaluationSplit;
    commandKey: string; requestHash: string; baselineComponentHash: string; candidateComponentHash: string;
    baselinePromptHash: string; baselineToolHash: string; modelConfigHash: string;
    baselineManifest: RunVersionManifest; candidateManifest: RunVersionManifest }): Promise<EvaluationReceipt> {
    requireRunPermission(principal, "evaluations:create");
    if (input.split === "holdout") requireRunPermission(principal, "evaluations:holdout");
    return this.db.transaction(principal.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,1830))", [principal.tenantId]);
      const duplicate = await client.query<EvalRow & { request_hash: string }>(
        `SELECT * FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND curator_actor_type=$2
           AND curator_actor_id=$3 AND command_key=$4`,
        [principal.tenantId, principal.actorType, principal.subjectId, input.commandKey]);
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== input.requestHash) throw replayError("EVALUATION_CONFLICT", 409, "Idempotency key was reused");
        return mapEvaluation(duplicate.rows[0]);
      }
      const candidate = (await client.query<{ dataset_version: string; dataset_manifest_hash: string;
        candidate_hash: string; candidate_json: EvolutionCandidateV1; expected_cases: number }>(
        `SELECT c.dataset_version,c.dataset_manifest_hash,c.candidate_hash,c.candidate_json,
           CASE $6::text WHEN 'development' THEN d.dev_count WHEN 'validation' THEN d.validation_count ELSE d.holdout_count END AS expected_cases
         FROM pr_agent_harness.evolution_candidates c
         JOIN pr_agent_harness.evolution_proposal_sources s
           ON s.tenant_id=c.tenant_id AND s.proposal_run_id=c.proposal_run_id AND s.content_purged_at IS NULL
         JOIN pr_agent_harness.agent_runs pr
           ON pr.tenant_id=c.tenant_id AND pr.id=c.proposal_run_id
            AND pr.run_type='evolution.propose.v1' AND pr.status='succeeded'
         JOIN pr_agent_harness.eval_datasets d
           ON d.tenant_id=c.tenant_id AND d.id=c.dataset_id AND d.version=c.dataset_version
              AND d.manifest_hash=c.dataset_manifest_hash
         WHERE c.tenant_id=$1 AND c.id=$2 AND c.dataset_id=$3 AND c.status='research_draft'
           AND c.created_by_actor_type=$4 AND c.created_by_actor_id=$5 AND c.content_purged_at IS NULL
           AND c.baseline_prompt_hash=$7 AND c.baseline_tool_hash=$8 AND c.model_config_hash=$9
           AND d.status='frozen' AND d.curator_actor_type=$4 AND d.curator_actor_id=$5 AND d.content_purged_at IS NULL`,
        [principal.tenantId, input.candidateId, input.datasetId, principal.actorType, principal.subjectId,
          input.split, input.baselinePromptHash, input.baselineToolHash, input.modelConfigHash])).rows[0];
      if (!candidate) throw replayError("EVALUATION_SOURCE_NOT_FOUND", 404, "Frozen dataset or candidate was not found");
      if (fingerprint(candidate.candidate_json) !== candidate.candidate_hash) {
        throw replayError("EVALUATION_SOURCE_CHANGED", 409, "Candidate content hash is invalid");
      }
      const cases = await client.query<{ id: string; integration_id: string; fixture_hash: string;
        label_set_id: string; label_set_hash: string }>(
        `SELECT c.id,c.integration_id,c.fixture_hash,c.label_set_id,c.label_set_hash
         FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.eval_fixtures f
           ON f.tenant_id=c.tenant_id AND f.id=c.fixture_id AND f.content_purged_at IS NULL
         JOIN pr_agent_harness.trusted_review_label_sets l
           ON l.tenant_id=c.tenant_id AND l.id=c.label_set_id AND l.active AND l.content_purged_at IS NULL
              AND l.label_set_hash=c.label_set_hash
         WHERE c.tenant_id=$1 AND c.dataset_id=$2 AND c.split=$3 AND c.content_purged_at IS NULL
         ORDER BY c.ordinal,c.id`, [principal.tenantId, input.datasetId, input.split]);
      if (!cases.rowCount) throw replayError("EVALUATION_SPLIT_EMPTY", 409, "Requested dataset split is empty");
      if (cases.rowCount > EVALUATION_SCHEDULING_POLICY.maxCasesPerSplit) {
        throw replayError("EVALUATION_SPLIT_TOO_LARGE", 409, "Requested dataset split exceeds the replay case limit");
      }
      if (cases.rowCount !== candidate.expected_cases) {
        throw replayError("EVALUATION_SOURCE_CHANGED", 409, "Dataset split contains unavailable cases or labels");
      }
      const manifestHash = fingerprint({ schemaVersion: 1, datasetId: input.datasetId,
        datasetVersion: Number(candidate.dataset_version), datasetManifestHash: candidate.dataset_manifest_hash,
        candidateId: input.candidateId, candidateHash: candidate.candidate_hash, split: input.split,
        repetitions: 3, baselineComponentHash: input.baselineComponentHash,
        samplingMode: "unseeded", candidateComponentHash: input.candidateComponentHash,
        baselineManifest: input.baselineManifest, candidateManifest: input.candidateManifest,
        verifierHash: REPLAY_VERIFIER_HASH, schedulingPolicy: EVALUATION_SCHEDULING_POLICY,
        schedulingPolicyHash: EVALUATION_SCHEDULING_POLICY_HASH, cases: cases.rows });
      const id = randomUUID(); const planned = cases.rowCount * 6;
      const deadlineMs = Math.max(EVALUATION_SCHEDULING_POLICY.minimumDeadlineMs,
        Math.ceil(planned * EVALUATION_SCHEDULING_POLICY.maxChildRunMs
          / EVALUATION_SCHEDULING_POLICY.maxConcurrentChildrenPerIntegration)
          + EVALUATION_SCHEDULING_POLICY.deadlineBufferMs);
      const inserted = await client.query<EvalRow>(
        `INSERT INTO pr_agent_harness.eval_runs
           (id,tenant_id,dataset_id,candidate_id,curator_actor_type,curator_actor_id,split,command_key,request_hash,
            repetitions,manifest_hash,baseline_component_hash,candidate_component_hash,model_version_hash,
            runtime_version_hash,scheduling_policy_json,scheduling_policy_hash,total_result_count,planned_result_count,deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,3,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$17,
           clock_timestamp()+make_interval(secs=>$18))
         RETURNING *`, [id, principal.tenantId, input.datasetId, input.candidateId, principal.actorType,
          principal.subjectId, input.split, input.commandKey, input.requestHash, manifestHash,
          input.baselineComponentHash, input.candidateComponentHash, input.baselineManifest.modelVersionHash,
          input.baselineManifest.runtimeVersionHash, JSON.stringify(EVALUATION_SCHEDULING_POLICY),
          EVALUATION_SCHEDULING_POLICY_HASH, planned, Math.ceil(deadlineMs / 1000)]);
      const results: Array<Record<string, unknown>> = [];
      for (const row of cases.rows) for (const variant of ["baseline", "candidate"] as const) {
        const expected = variant === "baseline" ? input.baselineManifest : input.candidateManifest;
        for (let repetition = 1; repetition <= 3; repetition += 1) results.push({ case_id: row.id,
          integration_id: row.integration_id, variant, repetition,
          seed_hash: fingerprint({ evaluationId: id, caseId: row.id, variant, repetition, samplingMode: "unseeded" }),
          fixture_hash: row.fixture_hash, label_set_id: row.label_set_id, label_set_hash: row.label_set_hash,
          component_hash: variant === "baseline" ? input.baselineComponentHash : input.candidateComponentHash,
          expected_workflow_hash: expected.workflowVersionHash, expected_prompt_hash: expected.promptVersionHash,
          expected_model_hash: expected.modelVersionHash, expected_tool_hash: expected.toolVersionHash,
          expected_policy_hash: expected.policyVersionHash, expected_runtime_hash: expected.runtimeVersionHash,
          expected_verifier_hash: REPLAY_VERIFIER_HASH });
      }
      await client.query(
        `INSERT INTO pr_agent_harness.eval_results
           (tenant_id,eval_run_id,dataset_id,case_id,integration_id,variant,repetition,seed_hash,fixture_hash,
            label_set_id,label_set_hash,component_hash,expected_workflow_hash,expected_prompt_hash,
            expected_model_hash,expected_tool_hash,expected_policy_hash,expected_runtime_hash,expected_verifier_hash)
         SELECT $1,$2,$3,x.case_id,x.integration_id,x.variant,x.repetition,x.seed_hash,x.fixture_hash,
           x.label_set_id,x.label_set_hash,x.component_hash,x.expected_workflow_hash,x.expected_prompt_hash,
           x.expected_model_hash,x.expected_tool_hash,x.expected_policy_hash,x.expected_runtime_hash,x.expected_verifier_hash
         FROM jsonb_to_recordset($4::jsonb) AS x(case_id uuid,integration_id uuid,variant text,repetition integer,
           seed_hash text,fixture_hash text,label_set_id uuid,label_set_hash text,component_hash text,
           expected_workflow_hash text,expected_prompt_hash text,expected_model_hash text,expected_tool_hash text,
           expected_policy_hash text,expected_runtime_hash text,expected_verifier_hash text)`,
        [principal.tenantId, id, input.datasetId, JSON.stringify(results)]);
      return mapEvaluation(inserted.rows[0]!);
    });
  }

  async read(principal: RunPrincipal, evaluationId: string): Promise<EvaluationReceipt> {
    requireRunPermission(principal, "evaluations:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      const row = (await client.query<EvalRow>(
        `SELECT * FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2
          AND curator_actor_type=$3 AND curator_actor_id=$4`,
        [principal.tenantId, evaluationId, principal.actorType, principal.subjectId])).rows[0];
      if (!row) throw replayError("EVALUATION_NOT_FOUND", 404, "Evaluation was not found");
      if (row.split === "holdout") requireRunPermission(principal, "evaluations:holdout");
      return mapEvaluation(row);
    });
  }

  async claim(tenantId: string, integrationId: string, owner: string, ttlSeconds = 60): Promise<EvaluationLease | undefined> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
      throw replayError("EVALUATION_LEASE_TTL_INVALID", 400, "Evaluation lease TTL must be between 1 and 300 seconds");
    }
    return this.db.transaction(tenantId, async (client) => {
      await expireEvaluations(client, tenantId);
      const selected = await client.query<{ id: string }>(
        `SELECT e.id FROM pr_agent_harness.eval_runs e
         WHERE e.tenant_id=$1 AND e.status IN ('queued','running') AND e.available_at<=clock_timestamp()
           AND e.deadline_at>clock_timestamp() AND (e.lease_expires_at IS NULL OR e.lease_expires_at<=clock_timestamp())
           AND EXISTS (SELECT 1 FROM pr_agent_harness.eval_results x WHERE x.tenant_id=e.tenant_id
             AND x.eval_run_id=e.id AND x.integration_id=$2 AND x.status IN ('pending','queued','running'))
         ORDER BY e.created_at,e.id FOR UPDATE SKIP LOCKED LIMIT 1`, [tenantId, integrationId]);
      if (!selected.rows[0]) return undefined;
      const claimed = await client.query<{ lease_epoch: string }>(
        `UPDATE pr_agent_harness.eval_runs SET status='running',lease_owner=$3,lease_epoch=lease_epoch+1,
           lease_expires_at=clock_timestamp()+make_interval(secs=>$4),heartbeat_at=clock_timestamp(),
           version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING lease_epoch`,
        [tenantId, selected.rows[0].id, owner, ttlSeconds]);
      return { tenantId, evaluationId: selected.rows[0].id, owner, epoch: Number(claimed.rows[0]!.lease_epoch) };
    });
  }

  async nextPending(lease: EvaluationLease, integrationId: string): Promise<PendingReplayResult | undefined> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertEvaluationLease(client, lease);
      const row = (await client.query<{
        id: string; evaluationId: string; datasetId: string; caseId: string; integrationId: string;
        candidateId: string; variant: EvaluationVariant; repetition: number; attemptIdentityHash: string;
        fixtureHash: string; labelSetId: string; labelSetHash: string; componentHash: string;
        expectedWorkflowHash: string; expectedPromptHash: string; expectedModelHash: string;
        expectedToolHash: string; expectedPolicyHash: string; expectedRuntimeHash: string;
        baseSha: string; headSha: string;
        candidate_text: EvolutionCandidateV1; source_json: EvolutionProposalSource;
        scheduling_policy_json: typeof EVALUATION_SCHEDULING_POLICY; scheduling_policy_hash: string;
      }>(
        `SELECT x.id,x.eval_run_id AS "evaluationId",x.dataset_id AS "datasetId",x.case_id AS "caseId",
                x.integration_id AS "integrationId",e.candidate_id AS "candidateId",x.variant,x.repetition,
                x.seed_hash AS "attemptIdentityHash",x.fixture_hash AS "fixtureHash",x.label_set_id AS "labelSetId",
                x.label_set_hash AS "labelSetHash",x.component_hash AS "componentHash",
                x.expected_workflow_hash AS "expectedWorkflowHash",x.expected_prompt_hash AS "expectedPromptHash",
                x.expected_model_hash AS "expectedModelHash",x.expected_tool_hash AS "expectedToolHash",
                x.expected_policy_hash AS "expectedPolicyHash",x.expected_runtime_hash AS "expectedRuntimeHash",
                r.base_sha AS "baseSha",r.head_sha AS "headSha",c.candidate_json AS candidate_text,
                ps.source_json,e.scheduling_policy_json,e.scheduling_policy_hash
         FROM pr_agent_harness.eval_results x JOIN pr_agent_harness.eval_runs e
           ON e.tenant_id=x.tenant_id AND e.id=x.eval_run_id
         JOIN pr_agent_harness.eval_cases ec ON ec.tenant_id=x.tenant_id AND ec.dataset_id=x.dataset_id AND ec.id=x.case_id
         JOIN pr_agent_harness.agent_runs r ON r.tenant_id=ec.tenant_id AND r.integration_id=ec.integration_id AND r.id=ec.source_run_id
         JOIN pr_agent_harness.evolution_candidates c ON c.tenant_id=e.tenant_id AND c.id=e.candidate_id
         JOIN pr_agent_harness.evolution_proposal_sources ps
           ON ps.tenant_id=c.tenant_id AND ps.proposal_run_id=c.proposal_run_id AND ps.content_purged_at IS NULL
         JOIN pr_agent_harness.agent_runs pr
           ON pr.tenant_id=c.tenant_id AND pr.id=c.proposal_run_id
            AND pr.run_type='evolution.propose.v1' AND pr.status='succeeded'
         WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND x.integration_id=$3 AND x.status='pending'
           AND (SELECT count(*) FROM pr_agent_harness.eval_results active
             WHERE active.tenant_id=x.tenant_id AND active.integration_id=x.integration_id
               AND active.status IN ('queued','running'))
             < (e.scheduling_policy_json->>'maxConcurrentChildrenPerIntegration')::integer
         ORDER BY x.case_id,x.variant,x.repetition LIMIT 1`, [lease.tenantId, lease.evaluationId, integrationId])).rows[0];
      if (!row) return undefined;
      if (fingerprint(row.scheduling_policy_json) !== row.scheduling_policy_hash
          || row.scheduling_policy_json.schemaVersion !== 1
          || !Number.isInteger(row.scheduling_policy_json.maxConcurrentChildrenPerIntegration)
          || row.scheduling_policy_json.maxConcurrentChildrenPerIntegration < 1
          || row.scheduling_policy_json.maxConcurrentChildrenPerIntegration > 16) {
        throw replayError("EVALUATION_POLICY_INVALID", 409, "Frozen evaluation scheduling policy is invalid");
      }
      const source = evolutionProposalSourceSchema.parse(row.source_json);
      return { ...row, candidateText: row.candidate_text,
        baselineText: { schemaVersion: 1, prompt_text: source.baselinePromptText,
          tool_description_text: source.baselineToolDescriptionText } };
    });
  }

  async attachChild(lease: EvaluationLease, result: PendingReplayResult, creation: CreateRunInput): Promise<string | undefined> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertEvaluationLease(client, lease);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,1901))",
        [`${lease.tenantId}:${result.integrationId}`]);
      const capacity = (await client.query<{ maximum: number; active: string }>(
        `SELECT (e.scheduling_policy_json->>'maxConcurrentChildrenPerIntegration')::integer AS maximum,
                (SELECT count(*) FROM pr_agent_harness.eval_results active
                  WHERE active.tenant_id=x.tenant_id AND active.integration_id=x.integration_id
                    AND active.status IN ('queued','running')) AS active
         FROM pr_agent_harness.eval_results x JOIN pr_agent_harness.eval_runs e
           ON e.tenant_id=x.tenant_id AND e.id=x.eval_run_id
         WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND x.id=$3 AND x.integration_id=$4 AND x.status='pending'`,
        [lease.tenantId, lease.evaluationId, result.id, result.integrationId])).rows[0];
      if (!capacity) throw replayError("EVALUATION_RESULT_CONFLICT", 409, "Replay result changed concurrently");
      if (Number(capacity.active) >= capacity.maximum) return undefined;
      const child = await createRunInTransaction(client, creation);
      const updated = await client.query(
        `UPDATE pr_agent_harness.eval_results SET child_run_id=$4,status='queued',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND eval_run_id=$2 AND id=$3 AND status='pending'`,
        [lease.tenantId, lease.evaluationId, result.id, child.id]);
      if (updated.rowCount !== 1) throw replayError("EVALUATION_RESULT_CONFLICT", 409, "Replay result changed concurrently");
      return child.id;
    });
  }

  async failAdmissionManifest(lease: EvaluationLease, resultId: string): Promise<number> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertEvaluationLease(client, lease);
      const belongs = await client.query(
        `SELECT 1 FROM pr_agent_harness.eval_results
         WHERE tenant_id=$1 AND eval_run_id=$2 AND id=$3 AND status='pending'`,
        [lease.tenantId, lease.evaluationId, resultId]);
      if (!belongs.rowCount) return 0;
      const usage = JSON.stringify({ inputTokens: 0, outputTokens: 0, costMicros: 0, modelCallCount: 0,
        unavailableMeasurements: 0, providerModelVersions: [], missingProviderModelVersions: 0,
        costMeasurement: "not_dispatched" });
      const updated = await client.query(
        `UPDATE pr_agent_harness.eval_results SET status='failed',error_code='admission_manifest_drift',
           usage_json=$3::jsonb,completed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND eval_run_id=$2 AND status='pending'`,
        [lease.tenantId, lease.evaluationId, usage]);
      return updated.rowCount ?? 0;
    });
  }

  async observeChildren(lease: EvaluationLease, integrationId: string): Promise<number> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertEvaluationLease(client, lease);
      const rows = await client.query<{ id: string; child_run_id: string; status: string; finished_at: Date | null;
        started_at: Date | null; workflow_version_hash: string; prompt_version_hash: string; model_version_hash: string;
        tool_version_hash: string; policy_version_hash: string; runtime_version_hash: string;
        expected_workflow_hash: string; expected_prompt_hash: string; expected_model_hash: string;
        expected_tool_hash: string; expected_policy_hash: string; expected_runtime_hash: string;
        expected_verifier_hash: string }>(
        `SELECT x.id,x.child_run_id,r.status,r.finished_at,
                (SELECT min(ev.created_at) FROM pr_agent_harness.run_events ev
                  WHERE ev.tenant_id=r.tenant_id AND ev.run_id=r.id AND ev.event_type='run.claimed') AS started_at,
                r.workflow_version_hash,r.prompt_version_hash,
                r.model_version_hash,r.tool_version_hash,r.policy_version_hash,r.runtime_version_hash,
                x.expected_workflow_hash,x.expected_prompt_hash,x.expected_model_hash,x.expected_tool_hash,
                x.expected_policy_hash,x.expected_runtime_hash,x.expected_verifier_hash
         FROM pr_agent_harness.eval_results x JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=x.tenant_id AND r.integration_id=x.integration_id AND r.id=x.child_run_id
         WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND x.integration_id=$3 AND x.status IN ('queued','running')
           AND r.status IN ('succeeded','failed','cancelled') FOR UPDATE OF x`,
        [lease.tenantId, lease.evaluationId, integrationId]);
      for (const row of rows.rows) await settleResult(client, lease, row);
      return rows.rowCount ?? 0;
    });
  }

  async releaseAndFinalize(lease: EvaluationLease): Promise<void> {
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertEvaluationLease(client, lease);
      const counts = (await client.query<{ total: string; terminal: string; failed: string }>(
        `SELECT count(*) AS total,count(*) FILTER (WHERE status IN ('succeeded','failed','cancelled')) AS terminal,
                count(*) FILTER (WHERE status IN ('failed','cancelled')) AS failed
         FROM pr_agent_harness.eval_results WHERE tenant_id=$1 AND eval_run_id=$2`,
        [lease.tenantId, lease.evaluationId])).rows[0]!;
      const total = Number(counts.total); const terminal = Number(counts.terminal); const failed = Number(counts.failed);
      if (terminal === total) {
        const metrics = await aggregateMetrics(client, lease);
        await client.query(
          `UPDATE pr_agent_harness.eval_runs SET status='succeeded',completed_result_count=$3,failed_result_count=$4,
             metrics_json=$5::jsonb,metrics_hash=$6,completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,
             version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
          [lease.tenantId, lease.evaluationId, terminal, failed, JSON.stringify(metrics), fingerprint(metrics)]);
      } else await client.query(
        `UPDATE pr_agent_harness.eval_runs SET status='queued',completed_result_count=$3,failed_result_count=$4,
           lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 second',
           version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
        [lease.tenantId, lease.evaluationId, terminal, failed]);
    });
  }

  async loadReplayFixture(lease: { tenantId: string; runId: string; integrationId: string }, input: ReplayRunInput): Promise<DatasetFixtureV1> {
    return this.db.transaction(lease.tenantId, (client) => loadReplayFixture(client, lease, input));
  }
}

async function expireEvaluations(client: PoolClient, tenantId: string): Promise<void> {
  const expired = await client.query<{ id: string }>(
    `SELECT id FROM pr_agent_harness.eval_runs
     WHERE tenant_id=$1 AND status IN ('queued','running') AND deadline_at<=clock_timestamp()
     ORDER BY deadline_at,id FOR UPDATE SKIP LOCKED LIMIT 100`, [tenantId]);
  for (const evaluation of expired.rows) {
    await client.query(
      `UPDATE pr_agent_harness.agent_runs r SET cancel_requested_at=COALESCE(r.cancel_requested_at,clock_timestamp()),
         updated_at=clock_timestamp()
       FROM pr_agent_harness.eval_results x
       WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND x.child_run_id=r.id AND r.tenant_id=x.tenant_id
         AND r.status IN ('queued','running','retry_wait')`, [tenantId, evaluation.id]);
    const notDispatchedUsage = JSON.stringify({ inputTokens: 0, outputTokens: 0, costMicros: 0, modelCallCount: 0,
      unavailableMeasurements: 0, providerModelVersions: [], missingProviderModelVersions: 0,
      costMeasurement: "not_dispatched" });
    await client.query(
      `UPDATE pr_agent_harness.eval_results SET status='cancelled',error_code='evaluation_deadline_exceeded',
         usage_json=$3::jsonb,completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND eval_run_id=$2 AND child_run_id IS NULL
         AND status NOT IN ('succeeded','failed','cancelled')`, [tenantId, evaluation.id, notDispatchedUsage]);
    const pending = await client.query<{ id: string; child_run_id: string; child_status: string | null }>(
      `SELECT x.id,x.child_run_id,r.status AS child_status
       FROM pr_agent_harness.eval_results x LEFT JOIN pr_agent_harness.agent_runs r
         ON r.tenant_id=x.tenant_id AND r.integration_id=x.integration_id AND r.id=x.child_run_id
       WHERE x.tenant_id=$1 AND x.eval_run_id=$2
         AND x.child_run_id IS NOT NULL AND x.status NOT IN ('succeeded','failed','cancelled')
       FOR UPDATE OF x`, [tenantId, evaluation.id]);
    for (const result of pending.rows) {
      const usage = await readRunUsage(client, tenantId, result.child_run_id);
      const costPending = !["succeeded", "failed", "cancelled"].includes(result.child_status ?? "");
      await client.query(
        `UPDATE pr_agent_harness.eval_results SET status='cancelled',error_code='evaluation_deadline_exceeded',
           usage_json=$4::jsonb,completed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND eval_run_id=$2 AND id=$3`,
        [tenantId, evaluation.id, result.id, JSON.stringify({ ...usage,
          ...(costPending ? { pendingExternalCost: true } : {}) })]);
    }
    const counts = (await client.query<{ total: string; failed: string }>(
      `SELECT count(*) AS total,count(*) FILTER (WHERE status IN ('failed','cancelled')) AS failed
       FROM pr_agent_harness.eval_results WHERE tenant_id=$1 AND eval_run_id=$2`,
      [tenantId, evaluation.id])).rows[0]!;
    const metrics = await aggregateMetrics(client, { tenantId, evaluationId: evaluation.id, owner: "deadline", epoch: 0 });
    await client.query(
      `UPDATE pr_agent_harness.eval_runs SET status='failed',error_code='evaluation_deadline_exceeded',
         completed_result_count=$3,failed_result_count=$4,metrics_json=$5::jsonb,metrics_hash=$6,
         completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,version=version+1,
         updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, evaluation.id, Number(counts.total), Number(counts.failed), JSON.stringify(metrics), fingerprint(metrics)]);
  }
}

async function assertEvaluationLease(client: PoolClient, lease: EvaluationLease): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2 AND status='running'
       AND lease_owner=$3 AND lease_epoch=$4 AND lease_expires_at>clock_timestamp()
       AND deadline_at>clock_timestamp() FOR UPDATE`,
    [lease.tenantId, lease.evaluationId, lease.owner, lease.epoch]);
  if (!result.rowCount) throw replayError("EVALUATION_LEASE_LOST", 409, "Evaluation lease was lost");
}

async function settleResult(client: PoolClient, lease: EvaluationLease, row: {
  id: string; child_run_id: string; status: string; finished_at: Date | null; started_at: Date | null;
  workflow_version_hash: string; prompt_version_hash: string; model_version_hash: string;
  tool_version_hash: string; policy_version_hash: string; runtime_version_hash: string;
  expected_workflow_hash: string; expected_prompt_hash: string; expected_model_hash: string;
  expected_tool_hash: string; expected_policy_hash: string; expected_runtime_hash: string;
  expected_verifier_hash: string;
}): Promise<void> {
  const latency = row.finished_at && row.started_at
    ? Math.max(0, row.finished_at.getTime() - row.started_at.getTime()) : null;
  if (row.status !== "succeeded") {
    await terminalResult(client, lease, row.id, row.child_run_id,
      row.status === "cancelled" ? "cancelled" : "failed", `child_${row.status}`, latency);
    return;
  }
  if (row.workflow_version_hash !== row.expected_workflow_hash || row.prompt_version_hash !== row.expected_prompt_hash
      || row.model_version_hash !== row.expected_model_hash || row.tool_version_hash !== row.expected_tool_hash
      || row.policy_version_hash !== row.expected_policy_hash || row.runtime_version_hash !== row.expected_runtime_hash
      || row.expected_verifier_hash !== REPLAY_VERIFIER_HASH) {
    await terminalResult(client, lease, row.id, row.child_run_id, "failed", "component_manifest_drift", latency); return;
  }
  const evidence = await client.query<{ artifact_json: DeepReviewArtifact; content_hash: string;
    label_set_json: { completeness: "complete"; expectedFindings: Array<{ path: string; startLine: number;
      endLine: number; severity: "low" | "medium" | "high" }> }; active: boolean }>(
    `SELECT a.artifact_json,a.content_hash,c.label_set_json,l.active
     FROM pr_agent_harness.review_artifacts a JOIN pr_agent_harness.eval_results x
       ON x.tenant_id=a.tenant_id AND x.child_run_id=a.run_id
     JOIN pr_agent_harness.eval_cases c ON c.tenant_id=x.tenant_id AND c.dataset_id=x.dataset_id
       AND c.id=x.case_id AND c.label_set_hash=x.label_set_hash AND c.content_purged_at IS NULL
     JOIN pr_agent_harness.trusted_review_label_sets l ON l.tenant_id=x.tenant_id AND l.id=x.label_set_id
       AND l.label_set_hash=x.label_set_hash
     WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND x.id=$3 AND a.content_purged_at IS NULL`,
    [lease.tenantId, lease.evaluationId, row.id]);
  const found = evidence.rows[0];
  if (!found?.active || found.label_set_json.completeness !== "complete") {
    await terminalResult(client, lease, row.id, row.child_run_id, "failed", "trusted_label_stale", latency); return;
  }
  const score = scoreReplayArtifact(found.artifact_json, found.label_set_json);
  const usageJson = await readRunUsage(client, lease.tenantId, row.child_run_id);
  await client.query(
    `UPDATE pr_agent_harness.eval_results SET status='succeeded',artifact_hash=$4,score_json=$5::jsonb,score_hash=$6,
       usage_json=$7::jsonb,latency_ms=$8,completed_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND eval_run_id=$2 AND id=$3`,
    [lease.tenantId, lease.evaluationId, row.id, found.content_hash, JSON.stringify(score), fingerprint(score),
      JSON.stringify(usageJson), latency]);
}

async function terminalResult(client: PoolClient, lease: EvaluationLease, id: string, childRunId: string,
  status: "failed" | "cancelled", error: string, latency: number | null): Promise<void> {
  const usage = await readRunUsage(client, lease.tenantId, childRunId);
  await client.query(
    `UPDATE pr_agent_harness.eval_results SET status=$4,error_code=$5,latency_ms=$6,usage_json=$7::jsonb,
       completed_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND eval_run_id=$2 AND id=$3`,
    [lease.tenantId, lease.evaluationId, id, status, error, latency, JSON.stringify(usage)]);
}

async function readRunUsage(client: PoolClient, tenantId: string, runId: string): Promise<Record<string, unknown>> {
  const usage = (await client.query<{ input_tokens: string; output_tokens: string; cost_micros: string;
    unavailable: string; provider_versions: string[] | null; missing_versions: string; call_count: string }>(
    `SELECT coalesce(sum(u.input_tokens),0)::text AS input_tokens,
            coalesce(sum(u.output_tokens),0)::text AS output_tokens,
            coalesce(sum(u.cost_micros),0)::text AS cost_micros,count(m.id)::text AS call_count,
            count(*) FILTER (WHERE m.status='succeeded' AND (u.model_call_id IS NULL OR u.measurement_status='unavailable'))::text AS unavailable,
            array_agg(DISTINCT m.provider_model_version) FILTER (WHERE m.provider_model_version IS NOT NULL) AS provider_versions,
            count(*) FILTER (WHERE m.status='succeeded' AND m.provider_model_version IS NULL)::text AS missing_versions
     FROM pr_agent_harness.model_calls m LEFT JOIN pr_agent_harness.usage_records u
       ON u.tenant_id=m.tenant_id AND u.model_call_id=m.id
     WHERE m.tenant_id=$1 AND m.run_id=$2`, [tenantId, runId])).rows[0]!;
  return { inputTokens: Number(usage.input_tokens), outputTokens: Number(usage.output_tokens),
    costMicros: Number(usage.cost_micros), modelCallCount: Number(usage.call_count),
    unavailableMeasurements: Number(usage.unavailable), providerModelVersions: usage.provider_versions ?? [],
    missingProviderModelVersions: Number(usage.missing_versions) };
}

async function aggregateMetrics(client: PoolClient, lease: EvaluationLease): Promise<Record<string, unknown>> {
  const rows = await client.query<{ variant: EvaluationVariant; status: string; score_json: ReplayScoreV1 | null;
    usage_json: { costMicros?: number; providerModelVersions?: string[]; missingProviderModelVersions?: number;
      unavailableMeasurements?: number; modelCallCount?: number; pendingExternalCost?: boolean } | null;
    latency_ms: number | null; error_code: string | null }>(
    `SELECT variant,status,score_json,usage_json,latency_ms,error_code FROM pr_agent_harness.eval_results
     WHERE tenant_id=$1 AND eval_run_id=$2 ORDER BY case_id,variant,repetition`, [lease.tenantId, lease.evaluationId]);
  const summarize = (variant: EvaluationVariant) => {
    const selected = rows.rows.filter((row) => row.variant === variant);
    const succeeded = selected.filter((row) => row.status === "succeeded" && row.score_json);
    const values = selected.map((row) => row.status === "succeeded" && row.score_json
      ? row.score_json.severityWeightedF1 : 0);
    const costs = selected.map((row) => Number(row.usage_json?.costMicros ?? 0));
    const latencies = selected.flatMap((row) => row.latency_ms === null ? [] : [Number(row.latency_ms)]);
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const variance = values.length ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length : 0;
    return { total: selected.length, succeeded: succeeded.length, failed: selected.length - succeeded.length,
      meanSeverityWeightedF1: mean, varianceSeverityWeightedF1: variance,
      costMicros: costs.reduce((sum, value) => sum + value, 0), p50CostMicros: quantile(costs, 0.5),
      meanLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
      p95LatencyMs: quantile(latencies, 0.95), latencyMeasurements: latencies.length,
      missingLatencyMeasurements: selected.length - latencies.length,
      safetyRegressions: succeeded.filter((row) => row.score_json!.safetyRegression).length,
      highFalsePositives: succeeded.reduce((sum, row) => sum + row.score_json!.highFalsePositives, 0),
      highFalseNegatives: succeeded.reduce((sum, row) => sum + row.score_json!.highFalseNegatives, 0),
      incompleteAnalyses: succeeded.filter((row) => row.score_json!.analysisStatus !== "complete").length };
  };
  const versions = new Set(rows.rows.flatMap((row) => row.usage_json?.providerModelVersions ?? []));
  const missing = rows.rows.reduce((sum, row) => sum + Number(row.usage_json?.missingProviderModelVersions ?? 0), 0);
  const unavailable = rows.rows.reduce((sum, row) => sum + Number(row.usage_json?.unavailableMeasurements ?? 0), 0);
  const missingCalls = rows.rows.filter((row) => Number(row.usage_json?.modelCallCount ?? 0) === 0).length;
  const pendingExternalCost = rows.rows.filter((row) => row.usage_json?.pendingExternalCost === true).length;
  const manifestDrift = rows.rows.filter((row) => row.error_code === "component_manifest_drift"
    || row.error_code === "admission_manifest_drift").length;
  const failed = rows.rows.filter((row) => row.status !== "succeeded").length;
  const missingLatency = rows.rows.filter((row) => row.latency_ms === null).length;
  return { schemaVersion: 1, repetitions: 3,
    completeMatrix: rows.rows.every((row) => ["succeeded", "failed", "cancelled"].includes(row.status)),
    comparable: versions.size === 1 && missing === 0 && unavailable === 0 && missingCalls === 0
      && pendingExternalCost === 0 && missingLatency === 0 && manifestDrift === 0 && failed === 0,
    providerModelVersions: [...versions].sort(), missingProviderModelVersions: missing,
    unavailableUsageMeasurements: unavailable, missingModelCallResults: missingCalls,
    pendingExternalCostResults: pendingExternalCost, manifestDriftResults: manifestDrift,
    missingLatencyMeasurements: missingLatency, failedResults: failed,
    baseline: summarize("baseline"), candidate: summarize("candidate") };
}

function quantile(values: readonly number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? sorted[0]!;
}

async function loadReplayFixture(client: PoolClient, lease: { tenantId: string; runId: string; integrationId: string },
  input: ReplayRunInput): Promise<DatasetFixtureV1> {
  const row = (await client.query<{ input_json: { input: Record<string, unknown>; collected: Record<string, unknown> };
    coverage_json: DatasetFixtureV1["coverage"]; ci_json: unknown; fixture_hash: string; run_id: string;
    repository: string; base_sha: string; head_sha: string; source_created_at: Date; pull_number: number;
    platform: "github" | "gitlab"; total_bytes: number }>(
    `SELECT f.input_json,f.coverage_json,f.ci_json,f.fixture_hash,f.run_id,f.repository,f.base_sha,f.head_sha,
            c.source_created_at,c.pull_number,b.platform,f.total_bytes
     FROM pr_agent_harness.eval_results x JOIN pr_agent_harness.eval_runs e
       ON e.tenant_id=x.tenant_id AND e.id=x.eval_run_id
     JOIN pr_agent_harness.eval_cases c ON c.tenant_id=x.tenant_id AND c.dataset_id=x.dataset_id AND c.id=x.case_id
     JOIN pr_agent_harness.eval_fixtures f ON f.tenant_id=c.tenant_id AND f.id=c.fixture_id
     JOIN pr_agent_harness.integration_bindings b ON b.tenant_id=f.tenant_id AND b.id=f.integration_id
     WHERE x.tenant_id=$1 AND x.id=$2 AND x.child_run_id=$3 AND x.integration_id=$4
       AND x.eval_run_id=$5 AND x.dataset_id=$6 AND x.case_id=$7 AND x.fixture_hash=$8
       AND e.candidate_id=$9 AND x.variant=$10 AND x.repetition=$11 AND x.seed_hash=$12
       AND x.component_hash=$13 AND x.label_set_id=$14 AND x.label_set_hash=$15 AND x.expected_verifier_hash=$16
       AND e.status IN ('queued','running') AND e.deadline_at>clock_timestamp()
       AND f.content_purged_at IS NULL AND c.content_purged_at IS NULL`,
    [lease.tenantId, input.resultId, lease.runId, lease.integrationId, input.evaluationId, input.datasetId,
      input.caseId, input.fixtureHash, input.candidateId, input.variant, input.repetition, input.attemptIdentityHash,
      input.componentHash, input.labelSetId, input.labelSetHash, input.verifierHash])).rows[0];
  if (!row) throw replayError("REPLAY_FIXTURE_NOT_FOUND", 409, "Frozen replay fixture did not match its child Run");
  const files = await client.query<{ path: string; kind: "source" | "manifest"; content_text: string;
    content_hash: string; size_bytes: number }>(
    `SELECT path,kind,content_text,content_hash,size_bytes FROM pr_agent_harness.eval_fixture_files
     WHERE tenant_id=$1 AND fixture_id=$2 AND content_purged_at IS NULL ORDER BY path`,
    [lease.tenantId, input.fixtureHash]);
  const fixture: DatasetFixtureV1 = { schemaVersion: 1, sourceRunId: row.run_id, platform: row.platform,
    repository: row.repository, pullNumber: row.pull_number, baseSha: row.base_sha, headSha: row.head_sha,
    sourceCreatedAt: row.source_created_at.toISOString(), input: row.input_json.input,
    collected: row.input_json.collected, coverage: row.coverage_json, ci: row.ci_json,
    files: files.rows.map((file) => ({ path: file.path, kind: file.kind, content: file.content_text,
      contentHash: file.content_hash, sizeBytes: file.size_bytes })), fixtureHash: row.fixture_hash, totalBytes: row.total_bytes };
  validateDatasetFixture(fixture, fixture);
  return fixture;
}

function mapEvaluation(row: EvalRow): EvaluationReceipt {
  return { id: row.id, datasetId: row.dataset_id, candidateId: row.candidate_id, split: row.split,
    status: row.status, version: Number(row.version), repetitions: 3, plannedResults: row.planned_result_count,
    completedResults: row.completed_result_count, failedResults: row.failed_result_count,
    manifestHash: row.manifest_hash, ...(row.metrics_json ? { metrics: row.metrics_json } : {}),
    createdAt: row.created_at.toISOString(), ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}) };
}

function replayError(code: string, status: number, message: string): RunControlError {
  return new RunControlError(code, status, message);
}
