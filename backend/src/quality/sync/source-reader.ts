import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { requireRunPermission, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import type { DatasetFixtureV1, DatasetStorePort } from "../../evolution/datasets/contracts.js";
import { PgEvolutionDatasetStore } from "../../evolution/datasets/store.js";
import type { EvaluationSplit, ReplayScoreV1 } from "../../evolution/evaluations/contracts.js";
import { PgEvolutionEvaluationStore } from "../../evolution/evaluations/store.js";

const MAX_EXPORT_ROWS = 500;

export class QualityExportSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QualityExportSourceError";
  }
}

export interface DatasetExportCase {
  caseId: string;
  sourceRunId: string;
  fixtureHash: string;
  labelSetId: string;
  labelSetHash: string;
  labelSet: Record<string, unknown>;
  ordinal: number;
  fixture: DatasetFixtureV1;
}

export interface DatasetExportSource {
  datasetId: string;
  datasetName: string;
  datasetVersion: number;
  manifestHash: string;
  split: "development" | "validation";
  counts: { development: number; validation: number; holdout: number };
  cases: DatasetExportCase[];
}

export interface EvaluationExportResult {
  resultId: string;
  childRunId: string;
  caseId: string;
  variant: "baseline" | "candidate";
  repetition: number;
  fixtureHash: string;
  labelSetHash: string;
  scoreHash: string;
  score: ReplayScoreV1;
  expectedHashes: {
    workflow: string;
    prompt: string;
    model: string;
    tool: string;
    policy: string;
    runtime: string;
    verifier: string;
  };
}

export interface EvaluationExportSource {
  evaluationId: string;
  manifestHash: string;
  datasetId: string;
  datasetManifestHash: string;
  datasetVersion: number;
  split: EvaluationSplit;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  counts: { planned: number; completed: number; failed: number; scored: number };
  aggregateMetrics?: Record<string, unknown>;
  results: EvaluationExportResult[];
}

export interface AnnotationRunSource {
  sourceRunId: string;
  runAttemptCount: number;
}

export interface QualitySourceReaderPort {
  readDataset(principal: RunPrincipal, input: { datasetId: string; split: "development" | "validation";
    expectedManifestHash: string }): Promise<DatasetExportSource>;
  readEvaluation(principal: RunPrincipal, input: { evaluationId: string;
    expectedManifestHash: string }): Promise<EvaluationExportSource>;
  readAnnotationRun(principal: RunPrincipal, sourceRunId: string): Promise<AnnotationRunSource>;
}

interface EvaluationReaderPort {
  read(principal: RunPrincipal, evaluationId: string): Promise<{ manifestHash: string }>;
}

interface DatasetCaseRow {
  id: string;
  integration_id: string;
  source_run_id: string;
  fixture_hash: string;
  label_set_id: string;
  label_set_hash: string;
  label_set_json: Record<string, unknown>;
  ordinal: number;
  content_purged_at: Date | null;
  label_active: boolean;
  label_content_purged_at: Date | null;
  current_label_set_hash: string;
}

interface EvaluationRow {
  id: string;
  dataset_id: string;
  split: EvaluationSplit;
  status: EvaluationExportSource["status"];
  manifest_hash: string;
  planned_result_count: number;
  completed_result_count: number;
  failed_result_count: number;
  metrics_json: Record<string, unknown> | null;
  dataset_manifest_hash: string;
  dataset_version: string;
  dataset_status: string;
  dataset_content_purged_at: Date | null;
}

interface EvaluationResultRow {
  id: string;
  child_run_id: string | null;
  case_id: string;
  integration_id: string;
  variant: "baseline" | "candidate";
  repetition: number;
  fixture_hash: string;
  current_fixture_hash: string;
  label_set_hash: string;
  current_label_set_hash: string;
  label_active: boolean;
  label_content_purged_at: Date | null;
  case_content_purged_at: Date | null;
  case_split: EvaluationSplit;
  child_integration_id: string | null;
  score_json: ReplayScoreV1;
  score_hash: string;
  expected_workflow_hash: string;
  expected_prompt_hash: string;
  expected_model_hash: string;
  expected_tool_hash: string;
  expected_policy_hash: string;
  expected_runtime_hash: string;
  expected_verifier_hash: string;
}

export class QualitySourceReader implements QualitySourceReaderPort {
  private readonly datasets: DatasetStorePort;
  private readonly evaluations: EvaluationReaderPort;

  constructor(private readonly db: RuntimeDatabase, datasets?: DatasetStorePort, evaluations?: EvaluationReaderPort) {
    this.datasets = datasets ?? new PgEvolutionDatasetStore(db);
    this.evaluations = evaluations ?? new PgEvolutionEvaluationStore(db);
  }

  async readDataset(principal: RunPrincipal, input: { datasetId: string; split: "development" | "validation";
    expectedManifestHash: string }): Promise<DatasetExportSource> {
    requireRunPermission(principal, "evaluations:read");
    if (input.split !== "development" && input.split !== "validation") {
      throw new QualityExportSourceError("QUALITY_HOLDOUT_EXPORT_FORBIDDEN");
    }
    const dataset = await this.datasets.read(principal, input.datasetId);
    if (dataset.status !== "frozen" || !dataset.manifestHash || dataset.manifestHash !== input.expectedManifestHash
        || dataset.contentPurgedAt) {
      throw new QualityExportSourceError("QUALITY_DATASET_SOURCE_CHANGED");
    }
    const rows = await this.db.transaction(principal.tenantId, async (client) => client.query<DatasetCaseRow>(
      `SELECT c.id,c.integration_id,c.source_run_id,c.fixture_hash,c.label_set_id,c.label_set_hash,
              c.label_set_json,c.ordinal,c.content_purged_at,l.active AS label_active,
              l.content_purged_at AS label_content_purged_at,l.label_set_hash AS current_label_set_hash
       FROM pr_agent_harness.eval_cases c
       JOIN pr_agent_harness.trusted_review_label_sets l
         ON l.tenant_id=c.tenant_id AND l.id=c.label_set_id AND l.integration_id=c.integration_id
            AND l.source_run_id=c.source_run_id
       WHERE c.tenant_id=$1 AND c.dataset_id=$2 AND c.split=$3
       ORDER BY c.ordinal,c.id LIMIT $4`,
      [principal.tenantId, input.datasetId, input.split, MAX_EXPORT_ROWS + 1],
    ));
    if (rows.rows.length > MAX_EXPORT_ROWS) throw new QualityExportSourceError("QUALITY_DATASET_EXPORT_LIMIT");
    if (rows.rows.some((row) => row.integration_id !== principal.integrationId)) {
      throw new QualityExportSourceError("QUALITY_CROSS_BINDING_SOURCE");
    }
    if (rows.rows.some((row) => row.content_purged_at || !row.label_active || row.label_content_purged_at
        || row.current_label_set_hash !== row.label_set_hash)) {
      throw new QualityExportSourceError("QUALITY_DATASET_SOURCE_CHANGED");
    }
    const cases: DatasetExportCase[] = [];
    for (const row of rows.rows) {
      const fixture = await this.datasets.readFixture(principal, input.datasetId, row.id);
      if (fixture.fixtureHash !== row.fixture_hash || fixture.sourceRunId !== row.source_run_id) {
        throw new QualityExportSourceError("QUALITY_DATASET_SOURCE_CHANGED");
      }
      cases.push({ caseId: row.id, sourceRunId: row.source_run_id, fixtureHash: row.fixture_hash,
        labelSetId: row.label_set_id, labelSetHash: row.label_set_hash, labelSet: row.label_set_json,
        ordinal: row.ordinal, fixture });
    }
    return { datasetId: dataset.id, datasetName: dataset.name, datasetVersion: dataset.version,
      manifestHash: dataset.manifestHash, split: input.split,
      counts: { development: dataset.developmentCount, validation: dataset.validationCount,
        holdout: dataset.holdoutCount }, cases };
  }

  async readEvaluation(principal: RunPrincipal, input: { evaluationId: string;
    expectedManifestHash: string }): Promise<EvaluationExportSource> {
    requireRunPermission(principal, "evaluations:read");
    const authoritative = await this.evaluations.read(principal, input.evaluationId);
    if (authoritative.manifestHash !== input.expectedManifestHash) {
      throw new QualityExportSourceError("QUALITY_EVALUATION_SOURCE_CHANGED");
    }
    return this.db.transaction(principal.tenantId, async (client) => {
      const evaluation = (await client.query<EvaluationRow>(
        `SELECT e.id,e.dataset_id,e.split,e.status,e.manifest_hash,e.planned_result_count,
                e.completed_result_count,e.failed_result_count,e.metrics_json,
                d.manifest_hash AS dataset_manifest_hash,d.version AS dataset_version,
                d.status AS dataset_status,d.content_purged_at AS dataset_content_purged_at
         FROM pr_agent_harness.eval_runs e
         JOIN pr_agent_harness.evolution_candidates candidate
           ON candidate.tenant_id=e.tenant_id AND candidate.id=e.candidate_id
         JOIN pr_agent_harness.agent_runs proposal
           ON proposal.tenant_id=candidate.tenant_id AND proposal.id=candidate.proposal_run_id
         JOIN pr_agent_harness.eval_datasets d
           ON d.tenant_id=e.tenant_id AND d.id=e.dataset_id
         WHERE e.tenant_id=$1 AND e.id=$2 AND proposal.integration_id=$3
           AND e.curator_actor_type=$4 AND e.curator_actor_id=$5`,
        [principal.tenantId, input.evaluationId, principal.integrationId, principal.actorType, principal.subjectId],
      )).rows[0];
      if (!evaluation) throw new QualityExportSourceError("QUALITY_EVALUATION_NOT_FOUND");
      if (evaluation.manifest_hash !== input.expectedManifestHash || evaluation.dataset_status !== "frozen"
          || !evaluation.dataset_manifest_hash || evaluation.dataset_content_purged_at) {
        throw new QualityExportSourceError("QUALITY_EVALUATION_SOURCE_CHANGED");
      }
      const scored = await client.query<EvaluationResultRow>(
        `SELECT x.id,x.child_run_id,x.case_id,x.integration_id,x.variant,x.repetition,x.fixture_hash,
                c.fixture_hash AS current_fixture_hash,x.label_set_hash,
                l.label_set_hash AS current_label_set_hash,l.active AS label_active,
                l.content_purged_at AS label_content_purged_at,c.content_purged_at AS case_content_purged_at,
                c.split AS case_split,child.integration_id AS child_integration_id,x.score_json,x.score_hash,
                x.expected_workflow_hash,x.expected_prompt_hash,x.expected_model_hash,x.expected_tool_hash,
                x.expected_policy_hash,x.expected_runtime_hash,x.expected_verifier_hash
         FROM pr_agent_harness.eval_results x
         JOIN pr_agent_harness.eval_cases c
           ON c.tenant_id=x.tenant_id AND c.dataset_id=x.dataset_id AND c.id=x.case_id
         JOIN pr_agent_harness.trusted_review_label_sets l
           ON l.tenant_id=x.tenant_id AND l.id=x.label_set_id AND l.integration_id=x.integration_id
         LEFT JOIN pr_agent_harness.agent_runs child
           ON child.tenant_id=x.tenant_id AND child.id=x.child_run_id
         WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND x.status='succeeded' AND x.score_json IS NOT NULL
         ORDER BY x.case_id,x.variant,x.repetition,x.id LIMIT $3`,
        [principal.tenantId, input.evaluationId, MAX_EXPORT_ROWS + 1],
      );
      if (scored.rows.length > MAX_EXPORT_ROWS) throw new QualityExportSourceError("QUALITY_EVALUATION_EXPORT_LIMIT");
      if (scored.rows.some((row) => !row.child_run_id || row.integration_id !== principal.integrationId
          || row.child_integration_id !== principal.integrationId)) {
        throw new QualityExportSourceError("QUALITY_CROSS_BINDING_SOURCE");
      }
      if (scored.rows.some((row) => row.fixture_hash !== row.current_fixture_hash
          || row.label_set_hash !== row.current_label_set_hash || !row.label_active
          || row.label_content_purged_at || row.case_content_purged_at || row.case_split !== evaluation.split)) {
        throw new QualityExportSourceError("QUALITY_EVALUATION_SOURCE_CHANGED");
      }
      return {
        evaluationId: evaluation.id,
        manifestHash: evaluation.manifest_hash,
        datasetId: evaluation.dataset_id,
        datasetManifestHash: evaluation.dataset_manifest_hash,
        datasetVersion: Number(evaluation.dataset_version),
        split: evaluation.split,
        status: evaluation.status,
        counts: { planned: evaluation.planned_result_count, completed: evaluation.completed_result_count,
          failed: evaluation.failed_result_count, scored: scored.rows.length },
        aggregateMetrics: evaluation.metrics_json ?? undefined,
        results: scored.rows.map((row) => ({ resultId: row.id, childRunId: row.child_run_id!, caseId: row.case_id,
          variant: row.variant, repetition: row.repetition, fixtureHash: row.fixture_hash,
          labelSetHash: row.label_set_hash, scoreHash: row.score_hash, score: row.score_json,
          expectedHashes: { workflow: row.expected_workflow_hash, prompt: row.expected_prompt_hash,
            model: row.expected_model_hash, tool: row.expected_tool_hash, policy: row.expected_policy_hash,
            runtime: row.expected_runtime_hash, verifier: row.expected_verifier_hash } })),
      };
    });
  }

  async readAnnotationRun(principal: RunPrincipal, sourceRunId: string): Promise<AnnotationRunSource> {
    requireRunPermission(principal, "runs:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      const row = (await client.query<{ id: string; execution_attempt_count: number }>(
        `SELECT id,execution_attempt_count FROM pr_agent_harness.agent_runs
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='succeeded' AND content_purged_at IS NULL`,
        [principal.tenantId, principal.integrationId, sourceRunId],
      )).rows[0];
      if (!row) throw new QualityExportSourceError("QUALITY_SOURCE_RUN_NOT_FOUND");
      return { sourceRunId: row.id, runAttemptCount: row.execution_attempt_count };
    });
  }
}
