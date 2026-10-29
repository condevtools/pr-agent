import type { PoolClient } from "pg";

import { BASELINE_REVIEW_TEXT, reviewTextHashes, withReviewTextVersions } from "../../review/strategy/text-components.js";
import { fingerprint, type RunVersionManifest } from "../../agent-runtime/versions.js";
import { reviewStrategyTextSchema } from "../../review/strategy/contracts.js";
import { REPLAY_VERIFIER_HASH } from "../evaluations/contracts.js";
import type { EvolutionReleasePolicyV1, OfflineQualificationEvidenceV1 } from "./contracts.js";

export class EvolutionReleaseGateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "EvolutionReleaseGateError"; }
}
interface MetricSide { total: number; succeeded: number; meanSeverityWeightedF1: number; p50CostMicros: number;
  safetyRegressions: number; highFalsePositives: number; highFalseNegatives: number; incompleteAnalyses: number }
interface Metrics { schemaVersion: number; repetitions: number; completeMatrix: boolean; comparable: boolean;
  providerModelVersions: string[]; unavailableUsageMeasurements: number; missingModelCallResults: number;
  pendingExternalCostResults: number; manifestDriftResults: number; missingLatencyMeasurements: number;
  failedResults: number; baseline: MetricSide; candidate: MetricSide }

export async function evaluateOfflineReleaseGates(client: PoolClient, input: { tenantId: string; integrationId: string;
  candidateId: string; datasetId: string; validationEvaluationId: string; holdoutEvaluationId: string;
  policy: EvolutionReleasePolicyV1; currentManifest: RunVersionManifest }): Promise<OfflineQualificationEvidenceV1> {
  const candidate = (await client.query<{ candidate_hash: string; candidate_json: unknown; dataset_version: string;
    dataset_manifest_hash: string; baseline_prompt_hash: string; baseline_tool_hash: string }>(
    `SELECT c.candidate_hash,c.candidate_json,c.dataset_version,c.dataset_manifest_hash,c.baseline_prompt_hash,c.baseline_tool_hash
     FROM pr_agent_harness.evolution_candidates c JOIN pr_agent_harness.agent_runs r
       ON r.tenant_id=c.tenant_id AND r.id=c.proposal_run_id
      AND r.run_type='evolution.propose.v1' AND r.input_json->>'workflow'='evolution.propose.v1' AND r.status='succeeded'
     WHERE c.tenant_id=$1 AND c.id=$2 AND c.dataset_id=$3 AND c.content_purged_at IS NULL`,
    [input.tenantId, input.candidateId, input.datasetId])).rows[0];
  if (!candidate) fail("RELEASE_CANDIDATE_INELIGIBLE", "Candidate is not an eligible succeeded proposal");
  const candidateText = reviewStrategyTextSchema.parse(candidate.candidate_json);
  if (fingerprint(candidateText) !== candidate.candidate_hash) fail("RELEASE_CANDIDATE_CHANGED", "Candidate hash is invalid");
  const base = reviewTextHashes(BASELINE_REVIEW_TEXT);
  if (candidate.baseline_prompt_hash !== base.promptHash || candidate.baseline_tool_hash !== base.toolHash) {
    fail("RELEASE_BASELINE_STALE", "Candidate was not proposed against the current product baseline");
  }
  const dataset = (await client.query<{ version: string; manifest_hash: string; case_count: number;
    validation_count: number; holdout_count: number; repositories: string;
    high_cases: string; medium_cases: string; low_cases: string; typescript_cases: string; javascript_cases: string;
    stale_labels: string; cross_split_repositories: string }>(
    `SELECT d.version,d.manifest_hash,d.case_count,d.validation_count,d.holdout_count,count(DISTINCT c.repository)::text repositories,
       count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.label_set_json->'expectedFindings') f WHERE f->>'severity'='high'))::text high_cases,
       count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.label_set_json->'expectedFindings') f WHERE f->>'severity'='medium'))::text medium_cases,
       count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.label_set_json->'expectedFindings') f WHERE f->>'severity'='low'))::text low_cases,
       count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM pr_agent_harness.eval_fixture_files f WHERE f.tenant_id=c.tenant_id AND f.fixture_id=c.fixture_id AND f.content_purged_at IS NULL AND f.path~*'\\.(ts|tsx)$' AND f.path!~*'\\.d\\.ts$'))::text typescript_cases,
       count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM pr_agent_harness.eval_fixture_files f WHERE f.tenant_id=c.tenant_id AND f.fixture_id=c.fixture_id AND f.content_purged_at IS NULL AND f.path~*'\\.(js|jsx)$'))::text javascript_cases,
       count(*) FILTER (WHERE NOT l.active OR l.content_purged_at IS NOT NULL OR l.label_set_hash<>c.label_set_hash)::text stale_labels,
       (SELECT count(*) FROM (SELECT repository FROM pr_agent_harness.eval_cases x WHERE x.tenant_id=d.tenant_id AND x.dataset_id=d.id AND x.content_purged_at IS NULL GROUP BY repository HAVING count(DISTINCT split)>1) q)::text cross_split_repositories
     FROM pr_agent_harness.eval_datasets d JOIN pr_agent_harness.eval_cases c ON c.tenant_id=d.tenant_id AND c.dataset_id=d.id AND c.content_purged_at IS NULL
     JOIN pr_agent_harness.trusted_review_label_sets l ON l.tenant_id=c.tenant_id AND l.id=c.label_set_id
     WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='frozen' AND d.content_purged_at IS NULL AND d.version=$3 AND d.manifest_hash=$4
     GROUP BY d.tenant_id,d.id,d.version,d.manifest_hash,d.case_count,d.validation_count,d.holdout_count`,
    [input.tenantId, input.datasetId, candidate.dataset_version, candidate.dataset_manifest_hash])).rows[0];
  if (!dataset) fail("RELEASE_DATASET_INELIGIBLE", "Frozen candidate dataset is unavailable");
  const severity = { high: Number(dataset.high_cases), medium: Number(dataset.medium_cases), low: Number(dataset.low_cases) };
  const languages = { typescript: Number(dataset.typescript_cases), javascript: Number(dataset.javascript_cases) };
  if (dataset.case_count < input.policy.minimumCases || Number(dataset.repositories) < input.policy.minimumRepositories
      || Object.values(severity).some((v) => v < input.policy.minimumSeverityCases)
      || Object.values(languages).some((v) => v < input.policy.minimumLanguageCases)
      || Number(dataset.stale_labels) || Number(dataset.cross_split_repositories)) {
    fail("RELEASE_DATASET_GATE_FAILED", "Dataset size, coverage, label, or split-isolation gate failed");
  }
  const baselineManifest = withReviewTextVersions(input.currentManifest, BASELINE_REVIEW_TEXT);
  const candidateManifest = withReviewTextVersions(input.currentManifest, candidateText);
  const validation = await loadEvaluation(client, input, input.validationEvaluationId, "validation",
    dataset.validation_count, baselineManifest, candidateManifest);
  const holdout = await loadEvaluation(client, input, input.holdoutEvaluationId, "holdout",
    dataset.holdout_count, baselineManifest, candidateManifest);
  assertMetrics(validation.metrics, input.policy, "validation"); assertMetrics(holdout.metrics, input.policy, "holdout");
  if (fingerprint(validation.metrics.providerModelVersions) !== fingerprint(holdout.metrics.providerModelVersions)
      || validation.baselineComponentHash !== holdout.baselineComponentHash
      || validation.candidateComponentHash !== holdout.candidateComponentHash) {
    fail("RELEASE_EVALUATION_MISMATCH", "Evaluation component or provider versions differ across splits");
  }
  return { schemaVersion: 1, candidateId: input.candidateId, candidateHash: candidate.candidate_hash,
    datasetId: input.datasetId, datasetVersion: Number(dataset.version), datasetManifestHash: dataset.manifest_hash,
    validationEvaluationId: input.validationEvaluationId, holdoutEvaluationId: input.holdoutEvaluationId,
    repositories: Number(dataset.repositories), cases: dataset.case_count, severityCases: severity, languageCases: languages,
    validationMetricsHash: validation.metricsHash, holdoutMetricsHash: holdout.metricsHash,
    baselineComponentHash: validation.baselineComponentHash, candidateComponentHash: validation.candidateComponentHash,
    providerModelVersions: [...validation.metrics.providerModelVersions].sort(), policyHash: fingerprint(input.policy) };
}

async function loadEvaluation(client: PoolClient, input: Parameters<typeof evaluateOfflineReleaseGates>[1], id: string,
  split: "validation" | "holdout", expectedCases: number, baseline: RunVersionManifest, candidate: RunVersionManifest) {
  const row = (await client.query<{ metrics_json: Metrics; metrics_hash: string; baseline_component_hash: string;
    candidate_component_hash: string; planned_result_count: number; cases: string; bad_pins: string }>(
    `SELECT e.metrics_json,e.metrics_hash,e.baseline_component_hash,e.candidate_component_hash,e.planned_result_count,
      count(DISTINCT x.case_id)::text cases,count(*) FILTER (WHERE x.expected_verifier_hash<>$6 OR
       (x.variant='baseline' AND (x.expected_workflow_hash,x.expected_prompt_hash,x.expected_model_hash,x.expected_tool_hash,x.expected_policy_hash,x.expected_runtime_hash)<>(($7),($8),($9),($10),($11),($12))) OR
       (x.variant='candidate' AND (x.expected_workflow_hash,x.expected_prompt_hash,x.expected_model_hash,x.expected_tool_hash,x.expected_policy_hash,x.expected_runtime_hash)<>(($13),($14),($15),($16),($17),($18))))::text bad_pins
     FROM pr_agent_harness.eval_runs e JOIN pr_agent_harness.eval_results x ON x.tenant_id=e.tenant_id AND x.eval_run_id=e.id
     WHERE e.tenant_id=$1 AND e.id=$2 AND e.dataset_id=$3 AND e.candidate_id=$4 AND e.split=$5 AND e.status='succeeded'
     GROUP BY e.id`, [input.tenantId, id, input.datasetId, input.candidateId, split, REPLAY_VERIFIER_HASH,
      baseline.workflowVersionHash, baseline.promptVersionHash, baseline.modelVersionHash, baseline.toolVersionHash, baseline.policyVersionHash, baseline.runtimeVersionHash,
      candidate.workflowVersionHash, candidate.promptVersionHash, candidate.modelVersionHash, candidate.toolVersionHash, candidate.policyVersionHash, candidate.runtimeVersionHash])).rows[0];
  if (!row || fingerprint(row.metrics_json) !== row.metrics_hash || Number(row.bad_pins)
      || Number(row.cases) !== expectedCases || row.planned_result_count !== expectedCases * 6) {
    fail("RELEASE_EVALUATION_INELIGIBLE", `${split} evaluation is incomplete or drifted`);
  }
  return { metrics: row.metrics_json, metricsHash: row.metrics_hash,
    baselineComponentHash: row.baseline_component_hash, candidateComponentHash: row.candidate_component_hash };
}
function assertMetrics(metrics: Metrics, policy: EvolutionReleasePolicyV1, split: string): void {
  const b = metrics.baseline; const c = metrics.candidate;
  if (metrics.schemaVersion !== 1 || metrics.repetitions !== 3 || !metrics.completeMatrix || !metrics.comparable
      || metrics.failedResults || metrics.manifestDriftResults || metrics.pendingExternalCostResults
      || metrics.missingModelCallResults || metrics.unavailableUsageMeasurements || metrics.missingLatencyMeasurements
      || b.total === 0 || b.succeeded !== b.total || c.succeeded !== c.total || b.meanSeverityWeightedF1 <= 0
      || c.meanSeverityWeightedF1 < b.meanSeverityWeightedF1 * policy.minimumQualityRatio
      || c.highFalsePositives || c.highFalseNegatives || c.safetyRegressions || c.incompleteAnalyses
      || b.p50CostMicros <= 0 || c.p50CostMicros > b.p50CostMicros * policy.maximumCostRatio) {
    fail("RELEASE_METRIC_GATE_FAILED", `${split} quality, safety, completeness, or cost gate failed`);
  }
}
function fail(code: string, message: string): never { throw new EvolutionReleaseGateError(code, message); }
