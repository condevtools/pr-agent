import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { requireRunPermission, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { reviewRunInputSchema } from "../../review/intake/run-input.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import { computeLineageHash, computeShingleSignature, shingleSimilarity, validateDatasetFixture } from "./fixture.js";
import type { DatasetCaseSource, DatasetFixtureV1, DatasetMetadata, DatasetSplitPolicyV1, DatasetStorePort } from "./contracts.js";
import type { createDatasetSchema } from "./contracts.js";
import type { z } from "zod";

interface DatasetRow {
  id: string; name: string; status: "draft" | "frozen" | "retired"; version: string;
  curator_actor_type: "user" | "service"; curator_actor_id: string;
  split_policy_json: DatasetSplitPolicyV1; split_policy_hash: string; manifest_hash: string | null;
  case_count: number; dev_count: number; validation_count: number; holdout_count: number;
  frozen_at: Date | null; content_purged_at: Date | null; created_at: Date;
}

interface CaseRow {
  id: string; source_run_id: string; integration_id: string; source_artifact_hash: string;
  fixture_id: string; fixture_hash: string; label_set_id: string; label_set_hash: string;
  lineage_hash: string; shingle_hashes_json: string[]; source_created_at: Date;
  repository: string; pull_number: number;
  workflow_version_hash: string; prompt_version_hash: string; model_version_hash: string;
  tool_version_hash: string; policy_version_hash: string; runtime_version_hash: string;
  fixture_content_purged_at: Date | null; label_content_purged_at: Date | null;
  label_active: boolean; current_label_set_hash: string;
  persisted_fixture_hash: string;
}

export class PgEvolutionDatasetStore implements DatasetStorePort {
  constructor(private readonly db: RuntimeDatabase) {}

  async create(principal: RunPrincipal, input: z.infer<typeof createDatasetSchema>): Promise<DatasetMetadata> {
    requireRunPermission(principal, "evaluations:create");
    const splitPolicy: DatasetSplitPolicyV1 = { schemaVersion: 1, strategy: "repository_time_v1",
      developmentBefore: new Date(input.developmentBefore).toISOString(),
      validationBefore: new Date(input.validationBefore).toISOString(), nearDuplicateThreshold: 0.85 };
    if (new Date(splitPolicy.developmentBefore) >= new Date(splitPolicy.validationBefore)) {
      throw datasetError("INVALID_SPLIT_POLICY", 400, "Development cutoff must precede validation cutoff");
    }
    return this.db.transaction(principal.tenantId, async (client) => {
      const result = await client.query<DatasetRow>(
        `INSERT INTO pr_agent_harness.eval_datasets
           (tenant_id,name,curator_actor_type,curator_actor_id,split_policy_json,split_policy_hash)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
        [principal.tenantId, input.name.trim().normalize("NFC"), principal.actorType, principal.subjectId,
          JSON.stringify(splitPolicy), fingerprint(splitPolicy)],
      ).catch((error: { code?: string }) => {
        if (error.code === "23505") throw datasetError("DATASET_EXISTS", 409, "Dataset name already exists");
        throw error;
      });
      return mapDataset(result.rows[0]!);
    });
  }

  async loadCaseSource(principal: RunPrincipal, datasetId: string, sourceRunId: string,
    labelSetId: string): Promise<DatasetCaseSource> {
    requireRunPermission(principal, "evaluations:create");
    return this.db.transaction(principal.tenantId, async (client) => {
      await selectOwnedDataset(client, principal, datasetId, false);
      return selectCaseSource(client, principal, sourceRunId, labelSetId);
    });
  }

  async addCase(principal: RunPrincipal, datasetId: string, expectedVersion: number,
    source: DatasetCaseSource, fixture: DatasetFixtureV1): Promise<DatasetMetadata> {
    requireRunPermission(principal, "evaluations:create");
    validateDatasetFixture(source, fixture);
    const signature = computeShingleSignature(fixture.files);
    const lineageHash = computeLineageHash(source.repository, source.pullNumber);
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockTenantEvaluationData(client, principal.tenantId);
      const dataset = await selectOwnedDataset(client, principal, datasetId, true);
      if (dataset.status !== "draft" || Number(dataset.version) !== expectedVersion || dataset.content_purged_at) {
        throw datasetError("DATASET_CAS_CONFLICT", 409, "Dataset changed or is no longer mutable");
      }
      if (dataset.case_count >= 1_000) throw datasetError("DATASET_CASE_LIMIT", 409, "Dataset case limit reached");
      const authoritative = await selectCaseSource(client, principal, source.sourceRunId, source.labelSetId);
      if (fingerprint(authoritative) !== fingerprint(source)) throw datasetError("SOURCE_CHANGED", 409, "Dataset source changed");
      const databaseClock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      assertWithinPolicy(dataset.split_policy_json, source.sourceCreatedAt, databaseClock.rows[0]!.now);
      await insertFixture(client, source, fixture);
      const caseId = await client.query<{ id: string }>(
        `INSERT INTO pr_agent_harness.eval_cases
           (tenant_id,integration_id,dataset_id,source_run_id,fixture_id,label_set_id,source_artifact_hash,
            fixture_hash,label_set_hash,label_set_json,lineage_hash,shingle_hash,shingle_hashes_json,
            source_created_at,repository,pull_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16)
         RETURNING id`,
        [principal.tenantId, principal.integrationId, datasetId, source.sourceRunId, fixture.fixtureHash,
          source.labelSetId, source.artifactHash, fixture.fixtureHash, source.labelSetHash,
          JSON.stringify(source.labelSet), lineageHash, fingerprint(signature), JSON.stringify(signature),
          source.sourceCreatedAt, source.repository, source.pullNumber],
      ).catch((error: { code?: string }) => {
        if (error.code === "23505") throw datasetError("DATASET_CASE_EXISTS", 409, "Source Run is already in this dataset");
        throw error;
      });
      if (!caseId.rows[0]) throw new Error("dataset case insert failed");
      const updated = await client.query<DatasetRow>(
        `UPDATE pr_agent_harness.eval_datasets SET version=version+1,case_count=case_count+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='draft' RETURNING *`,
        [principal.tenantId, datasetId, expectedVersion]);
      if (!updated.rows[0]) throw datasetError("DATASET_CAS_CONFLICT", 409, "Dataset changed concurrently");
      return mapDataset(updated.rows[0]);
    });
  }

  async freeze(principal: RunPrincipal, datasetId: string, expectedVersion: number): Promise<DatasetMetadata> {
    requireRunPermission(principal, "evaluations:create");
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockTenantEvaluationData(client, principal.tenantId);
      const dataset = await selectOwnedDataset(client, principal, datasetId, true);
      if (dataset.status !== "draft" || Number(dataset.version) !== expectedVersion || dataset.content_purged_at) {
        throw datasetError("DATASET_CAS_CONFLICT", 409, "Dataset changed or is already frozen");
      }
      const cases = await client.query<CaseRow>(
        `SELECT c.*,r.workflow_version_hash,r.prompt_version_hash,r.model_version_hash,r.tool_version_hash,
                r.policy_version_hash,r.runtime_version_hash,f.content_purged_at AS fixture_content_purged_at,
                l.content_purged_at AS label_content_purged_at,l.active AS label_active,
                l.label_set_hash AS current_label_set_hash,f.fixture_hash AS persisted_fixture_hash
         FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=c.tenant_id AND r.integration_id=c.integration_id AND r.id=c.source_run_id
         JOIN pr_agent_harness.eval_fixtures f
           ON f.tenant_id=c.tenant_id AND f.id=c.fixture_id AND f.integration_id=c.integration_id
         JOIN pr_agent_harness.trusted_review_label_sets l
           ON l.tenant_id=c.tenant_id AND l.id=c.label_set_id AND l.integration_id=c.integration_id
              AND l.source_run_id=c.source_run_id
         WHERE c.tenant_id=$1 AND c.dataset_id=$2 AND c.content_purged_at IS NULL
         ORDER BY c.repository,c.pull_number,c.source_created_at,c.source_run_id FOR UPDATE OF c`,
        [principal.tenantId, datasetId]);
      if (!cases.rowCount) throw datasetError("DATASET_EMPTY", 409, "Dataset has no cases");
      if (cases.rowCount !== dataset.case_count || cases.rows.some((row) => row.fixture_content_purged_at
          || row.label_content_purged_at || !row.label_active || row.current_label_set_hash !== row.label_set_hash)) {
        throw datasetError("SOURCE_CHANGED", 409, "Dataset source labels or fixtures changed before freeze");
      }
      await validatePersistedFixtures(client, principal.tenantId, cases.rows);
      const assigned = cases.rows.map((row) => ({ row, split: splitForDate(dataset.split_policy_json, row.source_created_at) }));
      assertNoCrossSplitLeakage(assigned, dataset.split_policy_json.nearDuplicateThreshold);
      const splitOrder = { development: 0, validation: 1, holdout: 2 } as const;
      assigned.sort((left, right) => splitOrder[left.split] - splitOrder[right.split]
        || left.row.repository.localeCompare(right.row.repository) || left.row.pull_number - right.row.pull_number
        || left.row.source_run_id.localeCompare(right.row.source_run_id));
      for (const [ordinal, item] of assigned.entries()) {
        await client.query(
          `UPDATE pr_agent_harness.eval_cases SET split=$4,ordinal=$5
           WHERE tenant_id=$1 AND dataset_id=$2 AND id=$3`,
          [principal.tenantId, datasetId, item.row.id, item.split, ordinal]);
      }
      const manifest = { schemaVersion: 1, datasetId, splitPolicy: dataset.split_policy_json,
        cases: assigned.map(({ row, split }, ordinal) => ({ ordinal, split, sourceRunId: row.source_run_id,
          caseId: row.id, integrationId: row.integration_id, repository: row.repository,
          sourceArtifactHash: row.source_artifact_hash, fixtureId: row.fixture_id, fixtureHash: row.fixture_hash,
          labelSetId: row.label_set_id, labelSetHash: row.label_set_hash, lineageHash: row.lineage_hash,
          versions: { workflow: row.workflow_version_hash, prompt: row.prompt_version_hash, model: row.model_version_hash,
            tool: row.tool_version_hash, policy: row.policy_version_hash, runtime: row.runtime_version_hash } })) };
      const counts = { development: assigned.filter((item) => item.split === "development").length,
        validation: assigned.filter((item) => item.split === "validation").length,
        holdout: assigned.filter((item) => item.split === "holdout").length };
      const updated = await client.query<DatasetRow>(
        `UPDATE pr_agent_harness.eval_datasets SET status='frozen',version=version+1,manifest_hash=$4,
           dev_count=$5,validation_count=$6,holdout_count=$7,frozen_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='draft' RETURNING *`,
        [principal.tenantId, datasetId, expectedVersion, fingerprint(manifest), counts.development,
          counts.validation, counts.holdout]);
      if (!updated.rows[0]) throw datasetError("DATASET_CAS_CONFLICT", 409, "Dataset changed concurrently");
      return mapDataset(updated.rows[0]);
    });
  }

  async read(principal: RunPrincipal, datasetId: string): Promise<DatasetMetadata> {
    requireRunPermission(principal, "evaluations:read");
    return this.db.transaction(principal.tenantId, async (client) => mapDataset(
      await selectOwnedDataset(client, principal, datasetId, false)));
  }

  async readFixture(principal: RunPrincipal, datasetId: string, caseId: string): Promise<DatasetFixtureV1> {
    requireRunPermission(principal, "evaluations:read");
    return this.db.transaction(principal.tenantId, async (client) => {
      const dataset = await selectOwnedDataset(client, principal, datasetId, false);
      if (dataset.status !== "frozen" || dataset.content_purged_at) throw datasetError("DATASET_UNAVAILABLE", 410, "Dataset is unavailable");
      const selected = await client.query<{ split: "development" | "validation" | "holdout"; fixture_id: string;
        input_json: { input: Record<string, unknown>; collected: Record<string, unknown> }; coverage_json: DatasetFixtureV1["coverage"];
        ci_json: unknown; fixture_hash: string; run_id: string; repository: string; base_sha: string; head_sha: string;
        source_created_at: Date; pull_number: number; platform: "github" | "gitlab";
        fixture_content_purged_at: Date | null; case_content_purged_at: Date | null }>(
        `SELECT c.split,c.fixture_id,f.input_json,f.coverage_json,f.ci_json,f.fixture_hash,f.run_id,f.repository,
                f.base_sha,f.head_sha,c.source_created_at,c.pull_number,b.platform,
                f.content_purged_at AS fixture_content_purged_at,c.content_purged_at AS case_content_purged_at
         FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.eval_fixtures f
           ON f.tenant_id=c.tenant_id AND f.id=c.fixture_id
         JOIN pr_agent_harness.integration_bindings b ON b.tenant_id=f.tenant_id AND b.id=f.integration_id
         WHERE c.tenant_id=$1 AND c.dataset_id=$2 AND c.id=$3`, [principal.tenantId, datasetId, caseId]);
      const row = selected.rows[0];
      if (!row || !row.split) throw datasetError("CASE_NOT_FOUND", 404, "Dataset case was not found");
      if (row.split === "holdout" && !principal.permissions.includes("evaluations:holdout")) {
        throw datasetError("HOLDOUT_FORBIDDEN", 403, "Holdout fixture permission is required");
      }
      if (row.fixture_content_purged_at || row.case_content_purged_at) {
        throw datasetError("FIXTURE_PURGED", 410, "Dataset fixture content was purged");
      }
      const files = await client.query<{ path: string; kind: "source" | "manifest"; content_text: string;
        content_hash: string; size_bytes: number; content_purged_at: Date | null }>(
        `SELECT path,kind,content_text,content_hash,size_bytes,content_purged_at
         FROM pr_agent_harness.eval_fixture_files WHERE tenant_id=$1 AND fixture_id=$2 ORDER BY path`,
        [principal.tenantId, row.fixture_id]);
      if (files.rows.some((file) => file.content_purged_at || file.content_text === null)) {
        throw datasetError("FIXTURE_PURGED", 410, "Dataset fixture content was purged");
      }
      const fixture: DatasetFixtureV1 = { schemaVersion: 1, sourceRunId: row.run_id, platform: row.platform, repository: row.repository,
        pullNumber: row.pull_number, baseSha: row.base_sha, headSha: row.head_sha,
        sourceCreatedAt: row.source_created_at.toISOString(), input: row.input_json.input,
        collected: row.input_json.collected, coverage: row.coverage_json, ci: row.ci_json,
        files: files.rows.map((file) => ({ path: file.path, kind: file.kind, content: file.content_text,
          contentHash: file.content_hash, sizeBytes: file.size_bytes })),
        fixtureHash: row.fixture_hash, totalBytes: files.rows.reduce((sum, file) => sum + file.size_bytes, 0) };
      validateDatasetFixture(fixture, fixture);
      return fixture;
    });
  }
}

async function selectOwnedDataset(client: PoolClient, principal: RunPrincipal, datasetId: string, lock: boolean): Promise<DatasetRow> {
  const result = await client.query<DatasetRow>(
    `SELECT * FROM pr_agent_harness.eval_datasets WHERE tenant_id=$1 AND id=$2
       AND curator_actor_type=$3 AND curator_actor_id=$4${lock ? " FOR UPDATE" : ""}`,
    [principal.tenantId, datasetId, principal.actorType, principal.subjectId]);
  if (!result.rows[0]) throw datasetError("DATASET_NOT_FOUND", 404, "Dataset was not found");
  assertSplitPolicy(result.rows[0].split_policy_json, result.rows[0].split_policy_hash);
  return result.rows[0];
}

async function selectCaseSource(client: PoolClient, principal: RunPrincipal, sourceRunId: string,
  labelSetId: string): Promise<DatasetCaseSource> {
  const result = await client.query<{
    tenant_id: string; integration_id: string; source_run_id: string; platform: "github" | "gitlab";
    origin: string; repository: string; provider_repository_id: string; input_json: Record<string, unknown>;
    base_sha: string; head_sha: string; source_created_at: Date; collection_step_id: string;
    collection_output: Record<string, unknown>; collection_output_hash: string; artifact_hash: string;
    artifact_json: Record<string, unknown>;
    label_set_id: string; label_set_hash: string; label_set_json: Record<string, unknown>;
  }>(
    `SELECT r.tenant_id,r.integration_id,r.id AS source_run_id,b.platform,b.origin,b.repository,
            b.provider_repository_id,r.input_json,r.base_sha,r.head_sha,r.created_at AS source_created_at,
            s.id AS collection_step_id,s.output_json->'value' AS collection_output,s.output_hash AS collection_output_hash,
            a.content_hash AS artifact_hash,a.artifact_json,l.id AS label_set_id,l.label_set_hash,l.label_set_json
     FROM pr_agent_harness.agent_runs r JOIN pr_agent_harness.integration_bindings b
       ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
     JOIN pr_agent_harness.agent_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
       AND s.step_key=CASE b.platform WHEN 'github' THEN 'github.collect_context.v1' ELSE 'gitlab.collect_context.v1' END
       AND s.step_kind='tool' AND s.status='succeeded'
     JOIN pr_agent_harness.review_artifacts a ON a.tenant_id=r.tenant_id AND a.integration_id=r.integration_id
       AND a.run_id=r.id AND a.workflow_id='review.deep.v1' AND a.head_sha=r.head_sha AND a.content_purged_at IS NULL
     JOIN pr_agent_harness.trusted_review_label_sets l ON l.tenant_id=r.tenant_id AND l.integration_id=r.integration_id
       AND l.source_run_id=r.id AND l.id=$4 AND l.active AND l.content_purged_at IS NULL
     WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3 AND r.run_type='review.deep.v1'
       AND r.status='succeeded' AND r.content_purged_at IS NULL`,
    [principal.tenantId, principal.integrationId, sourceRunId, labelSetId]);
  const row = result.rows[0];
  if (!row) throw datasetError("SOURCE_NOT_FOUND", 404, "Eligible labeled review Run was not found");
  const input = reviewRunInputSchema.parse(row.input_json);
  const labels = row.label_set_json as { schemaVersion?: unknown; rubricVersion?: unknown; completeness?: unknown };
  const artifactCoverage = (row.artifact_json as { sourceCoverage?: { status?: unknown; reasonCodes?: unknown } }).sourceCoverage;
  if (labels.schemaVersion !== 1 || labels.rubricVersion !== "review-quality.v1" || labels.completeness !== "complete"
      || artifactCoverage?.status !== "complete" || !Array.isArray(artifactCoverage.reasonCodes)
      || artifactCoverage.reasonCodes.length !== 0
      || fingerprint(row.label_set_json) !== row.label_set_hash
      || fingerprint({ value: row.collection_output }) !== row.collection_output_hash
      || fingerprint(row.artifact_json) !== row.artifact_hash
      || input.platform !== row.platform || input.target.origin !== row.origin
      || input.target.repository !== row.repository || input.target.providerRepositoryId !== Number(row.provider_repository_id)
      || input.revision.baseSha !== row.base_sha || input.revision.headSha !== row.head_sha) {
    throw datasetError("SOURCE_INVALID", 409, "Labeled review source is not immutable and complete");
  }
  return { tenantId: row.tenant_id, integrationId: row.integration_id, sourceRunId: row.source_run_id,
    platform: row.platform, origin: row.origin, repository: row.repository,
    providerRepositoryId: Number(row.provider_repository_id), pullNumber: input.target.number,
    baseSha: row.base_sha, headSha: row.head_sha, sourceCreatedAt: row.source_created_at.toISOString(),
    input: row.input_json, collected: row.collection_output, collectionStepId: row.collection_step_id,
    collectionOutputHash: row.collection_output_hash, artifactHash: row.artifact_hash,
    labelSetId: row.label_set_id, labelSetHash: row.label_set_hash, labelSet: row.label_set_json };
}

async function insertFixture(client: PoolClient, source: DatasetCaseSource, fixture: DatasetFixtureV1): Promise<void> {
  const manifest = fixture.files.map(({ content: _content, ...file }) => file);
  const inserted = await client.query(
    `INSERT INTO pr_agent_harness.eval_fixtures
       (id,tenant_id,integration_id,run_id,repository,base_sha,head_sha,input_hash,source_step_id,
        source_step_output_hash,artifact_hash,fixture_hash,input_json,files_manifest_json,coverage_json,ci_json,total_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17)
     ON CONFLICT (tenant_id,run_id) DO NOTHING RETURNING id`,
    [fixture.fixtureHash, source.tenantId, source.integrationId, source.sourceRunId, source.repository,
      source.baseSha, source.headSha, fingerprint(source.input), source.collectionStepId,
      source.collectionOutputHash, source.artifactHash, fixture.fixtureHash,
      JSON.stringify({ input: fixture.input, collected: fixture.collected }), JSON.stringify(manifest),
      JSON.stringify(fixture.coverage), JSON.stringify(fixture.ci), fixture.totalBytes]);
  if (!inserted.rowCount) {
    const existing = await client.query<{ fixture_hash: string; content_purged_at: Date | null }>(
      `SELECT fixture_hash,content_purged_at FROM pr_agent_harness.eval_fixtures
       WHERE tenant_id=$1 AND run_id=$2`,
      [source.tenantId, source.sourceRunId]);
    if (existing.rows[0]?.content_purged_at) throw datasetError("SOURCE_CHANGED", 409, "Source fixture content was purged");
    if (existing.rows[0]?.fixture_hash !== fixture.fixtureHash) throw datasetError("FIXTURE_CONFLICT", 409, "Source fixture changed");
    return;
  }
  for (const file of fixture.files) {
    await client.query(
      `INSERT INTO pr_agent_harness.eval_fixture_files
         (tenant_id,fixture_id,path,kind,content_text,content_hash,size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,fixture_id,path) DO NOTHING`,
      [source.tenantId, fixture.fixtureHash, file.path, file.kind, file.content, file.contentHash, file.sizeBytes]);
  }
}

async function validatePersistedFixtures(client: PoolClient, tenantId: string, cases: CaseRow[]): Promise<void> {
  for (const row of cases) {
    const stored = await client.query<{ run_id: string; repository: string; base_sha: string; head_sha: string;
      platform: "github" | "gitlab"; input_json: { input: Record<string, unknown>; collected: Record<string, unknown> };
      files_manifest_json: Array<Omit<DatasetFixtureV1["files"][number], "content">>;
      coverage_json: DatasetFixtureV1["coverage"]; ci_json: unknown; total_bytes: number }>(
      `SELECT f.run_id,f.repository,f.base_sha,f.head_sha,b.platform,f.input_json,f.files_manifest_json,
              f.coverage_json,f.ci_json,f.total_bytes
       FROM pr_agent_harness.eval_fixtures f JOIN pr_agent_harness.integration_bindings b
         ON b.tenant_id=f.tenant_id AND b.id=f.integration_id
       WHERE f.tenant_id=$1 AND f.id=$2`, [tenantId, row.fixture_id]);
    const metadata = stored.rows[0];
    const selected = await client.query<{ path: string; kind: "source" | "manifest"; content_text: string | null;
      content_hash: string; size_bytes: number; content_purged_at: Date | null }>(
      `SELECT path,kind,content_text,content_hash,size_bytes,content_purged_at
       FROM pr_agent_harness.eval_fixture_files WHERE tenant_id=$1 AND fixture_id=$2 ORDER BY path`,
      [tenantId, row.fixture_id]);
    if (!metadata || selected.rows.some((file) => file.content_purged_at || file.content_text === null)) {
      throw datasetError("SOURCE_CHANGED", 409, "Dataset fixture content was purged before freeze");
    }
    const fixtureFiles = selected.rows.map((file) => ({ path: file.path, kind: file.kind,
      content: file.content_text!, contentHash: file.content_hash, sizeBytes: file.size_bytes }));
    const fixture: DatasetFixtureV1 = { schemaVersion: 1, sourceRunId: metadata.run_id,
      platform: metadata.platform, repository: metadata.repository, pullNumber: row.pull_number,
      baseSha: metadata.base_sha, headSha: metadata.head_sha, sourceCreatedAt: row.source_created_at.toISOString(),
      input: metadata.input_json.input, collected: metadata.input_json.collected,
      coverage: metadata.coverage_json, ci: metadata.ci_json, files: fixtureFiles,
      fixtureHash: row.persisted_fixture_hash, totalBytes: metadata.total_bytes };
    const manifest = fixtureFiles.map(({ content: _content, ...metadata }) => metadata);
    try {
      if (row.persisted_fixture_hash !== row.fixture_hash
          || fingerprint(manifest) !== fingerprint(metadata.files_manifest_json)) {
        throw new Error("fixture metadata mismatch");
      }
      validateDatasetFixture(fixture, fixture);
    } catch {
      throw datasetError("SOURCE_CHANGED", 409, "Dataset fixture failed immutable verification before freeze");
    }
  }
}

function assertWithinPolicy(policy: DatasetSplitPolicyV1, sourceCreatedAt: string, databaseNow: Date): void {
  const time = new Date(sourceCreatedAt).getTime();
  if (!Number.isFinite(time) || time > databaseNow.getTime() + 5 * 60_000) {
    throw datasetError("SOURCE_TIME_INVALID", 409, "Source Run time is invalid");
  }
  // All dates are accepted into one of the three chronological splits; boundaries are frozen in the policy.
  splitForDate(policy, new Date(time));
}

function assertSplitPolicy(policy: DatasetSplitPolicyV1, hash: string): void {
  if (policy.schemaVersion !== 1 || policy.strategy !== "repository_time_v1"
      || policy.nearDuplicateThreshold !== 0.85
      || !Number.isFinite(new Date(policy.developmentBefore).getTime())
      || !Number.isFinite(new Date(policy.validationBefore).getTime())
      || new Date(policy.developmentBefore) >= new Date(policy.validationBefore)
      || fingerprint(policy) !== hash) {
    throw datasetError("DATASET_POLICY_INVALID", 409, "Frozen dataset split policy is invalid");
  }
}

function splitForDate(policy: DatasetSplitPolicyV1, sourceCreatedAt: Date): "development" | "validation" | "holdout" {
  if (sourceCreatedAt < new Date(policy.developmentBefore)) return "development";
  if (sourceCreatedAt < new Date(policy.validationBefore)) return "validation";
  return "holdout";
}

function assertNoCrossSplitLeakage(items: Array<{ row: CaseRow; split: "development" | "validation" | "holdout" }>, threshold: number): void {
  for (let left = 0; left < items.length; left += 1) for (let right = left + 1; right < items.length; right += 1) {
    const a = items[left]!; const b = items[right]!;
    if (a.split === b.split) continue;
    if (normalizeRepository(a.row.repository) === normalizeRepository(b.row.repository)
        || a.row.lineage_hash === b.row.lineage_hash
        || shingleSimilarity(a.row.shingle_hashes_json, b.row.shingle_hashes_json) >= threshold) {
      throw datasetError("CROSS_SPLIT_LEAKAGE", 409, "Repository lineage or near-duplicate content crosses evaluation splits");
    }
  }
}

async function lockTenantEvaluationData(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,1830))", [tenantId]);
}

function normalizeRepository(repository: string): string {
  return repository.trim().normalize("NFC").toLowerCase();
}

function mapDataset(row: DatasetRow): DatasetMetadata {
  return { id: row.id, name: row.name, status: row.status, version: Number(row.version), splitPolicy: row.split_policy_json,
    ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}), caseCount: row.case_count,
    developmentCount: row.dev_count, validationCount: row.validation_count, holdoutCount: row.holdout_count,
    ...(row.frozen_at ? { frozenAt: row.frozen_at.toISOString() } : {}),
    ...(row.content_purged_at ? { contentPurgedAt: row.content_purged_at.toISOString() } : {}),
    createdAt: row.created_at.toISOString() };
}

function datasetError(code: string, status: number, message: string): RunControlError {
  return new RunControlError(code, status, message);
}
