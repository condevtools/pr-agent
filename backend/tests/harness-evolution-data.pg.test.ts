import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { DatasetStore } from "../src/evolution/dataset-store.js";
import { buildDatasetFixture, type DatasetRepositoryAdapter } from "../src/evolution/dataset-fixture.js";
import { EvolutionDatasetMaintenanceStore } from "../src/evolution/dataset-maintenance.js";
import { FeedbackStore } from "../src/evolution/feedback-store.js";
import type { TrustedLabelSetV1 } from "../src/evolution/feedback-contracts.js";
import { labelSetHash } from "../src/evolution/feedback-contracts.js";
import { HarnessDatabase } from "../src/harness/postgres/database.js";
import { migrateHarness } from "../src/harness/postgres/migrations.js";
import { HarnessMaintenanceStore } from "../src/harness/maintenance.js";
import type { RunPrincipal } from "../src/harness/run-control-contracts.js";
import { RunControlError } from "../src/harness/run-control-contracts.js";
import { fingerprint } from "../src/harness/versions.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Evolution data PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("evolution tests require a disposable database");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const tenantId = randomUUID(); const otherTenantId = randomUUID();
  const integrationId = randomUUID(); const otherIntegrationId = randomUUID(); const crossTenantIntegrationId = randomUUID();
  const datasetIntegrationA = randomUUID(); const datasetIntegrationB = randomUUID(); const datasetIntegrationC = randomUUID();
  const datasetIntegrationD = randomUUID(); const datasetIntegrationE = randomUUID();
  const datasetIntegrationF = randomUUID();
  const sourceRunId = randomUUID(); const arbitrationRunId = randomUUID(); const purgedRunId = randomUUID();
  const crossTenantRunId = randomUUID();
  const datasetRunA = randomUUID(); const datasetRunB = randomUUID(); const datasetRunC = randomUUID();
  const datasetRunD = randomUUID(); const datasetRunE = randomUUID();
  const datasetRunF = randomUUID();
  const appPassword = randomUUID();
  const artifact = { schemaVersion: 1, summary: "durable review artifact", findings: [],
    sourceCoverage: { status: "complete", reasonCodes: [] } };
  const artifactHash = fingerprint(artifact);
  const emptyLabels: TrustedLabelSetV1 = { schemaVersion: 1, rubricVersion: "review-quality.v1",
    completeness: "complete", expectedFindings: [] };
  const oneFinding: TrustedLabelSetV1 = { ...emptyLabels, expectedFindings: [
    { path: "src/a.ts", startLine: 1, endLine: 1, severity: "high", title: "Unsafe assignment" },
  ] };
  let appPool: Pool; let store: FeedbackStore; let datasets: DatasetStore;

  const principal = (subjectId: string, integration = integrationId): RunPrincipal => ({ subjectId, actorType: "user",
    tenantId, integrationId: integration, permissions: ["feedback:create", "annotations:create", "annotations:arbitrate"] });

  before(async () => {
    await migrateHarness(adminPool);
    const role = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app'");
    const ddl = await adminPool.query<{ sql: string }>(role.rowCount
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) AS sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) AS sql",
    [appPassword]);
    await adminPool.query(ddl.rows[0]!.sql);
    const configured = spawnSync(process.execPath, ["--import", "tsx", "src/harness/cli.ts", "migrate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HARNESS_DATABASE_URL: databaseUrl },
    });
    if (configured.status !== 0) throw new Error(`runtime grant CLI failed: ${configured.stderr}`);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 8 });
    const appDb = new HarnessDatabase(appPool);
    store = new FeedbackStore(appDb); datasets = new DatasetStore(appDb);
    await seedIntegration(integrationId, "acme/evolution", 88);
    await seedIntegration(otherIntegrationId, "acme/other", 89);
    await seedIntegration(crossTenantIntegrationId, "foreign/repository", 90, otherTenantId);
    await seedIntegration(datasetIntegrationA, "dataset/development", 91);
    await seedIntegration(datasetIntegrationB, "dataset/holdout", 92);
    await seedIntegration(datasetIntegrationC, "dataset/positive", 93);
    await seedIntegration(datasetIntegrationD, "dataset/corrected", 94);
    await seedIntegration(datasetIntegrationE, "dataset/purged", 95);
    await seedIntegration(datasetIntegrationF, "dataset/maintenance", 96);
    await seedReview(sourceRunId, integrationId);
    await seedReview(arbitrationRunId, integrationId);
    await seedReview(purgedRunId, integrationId);
    await seedReview(crossTenantRunId, crossTenantIntegrationId, otherTenantId);
    await seedReview(datasetRunA, datasetIntegrationA);
    await seedReview(datasetRunB, datasetIntegrationB);
    await seedReview(datasetRunC, datasetIntegrationC);
    await seedReview(datasetRunD, datasetIntegrationD);
    await seedReview(datasetRunE, datasetIntegrationE);
    await seedReview(datasetRunF, datasetIntegrationF);
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET created_at='2025-01-01T00:00:00Z' WHERE id=$1", [datasetRunA]);
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET created_at='2025-08-01T00:00:00Z' WHERE id=$1", [datasetRunB]);
    for (const [runId, integration] of [[datasetRunA, datasetIntegrationA], [datasetRunB, datasetIntegrationB],
      [datasetRunC, datasetIntegrationC], [datasetRunD, datasetIntegrationD],
      [datasetRunE, datasetIntegrationE], [datasetRunF, datasetIntegrationF]] as const) {
      const feedback = new FeedbackStore(new HarnessDatabase(appPool));
      const annotation = { artifactHash, labelSet: emptyLabels, provenance: { method: "full_diff_review" as const } };
      await feedback.createAnnotation(principal(`seed-a-${runId}`, integration), runId, "seed-a", annotation);
      await feedback.createAnnotation(principal(`seed-b-${runId}`, integration), runId, "seed-b", annotation);
    }
    await adminPool.query(
      `INSERT INTO pr_agent_harness.feedback_observations
         (tenant_id,integration_id,source_run_id,artifact_hash,command_key,request_hash,actor_type,actor_id,observation_json)
       VALUES ($1,$2,$3,$4,'foreign-feedback',$5,'user','foreign-user','{"schemaVersion":1}'::jsonb)`,
      [otherTenantId, crossTenantIntegrationId, crossTenantRunId, artifactHash, fingerprint("foreign-feedback")]);
  });

  after(async () => { await appPool?.end(); await adminPool.end(); });

  test("feedback command keys are idempotent and reject different content with HTTP 409 semantics", async () => {
    const request = { schemaVersion: 1 as const, artifactHash, sentiment: "helpful" as const, categories: [] };
    const first = await store.recordObservation(principal("feedback-user"), sourceRunId, "feedback-1", request);
    const replay = await store.recordObservation(principal("feedback-user"), sourceRunId, "feedback-1", request);
    assert.equal(replay.id, first.id);

    await assert.rejects(store.recordObservation(principal("feedback-user"), sourceRunId, "feedback-1",
      { ...request, sentiment: "not_helpful" }), (error: unknown) =>
      error instanceof RunControlError && error.status === 409 && error.code === "RUN_CONFLICT");
    const count = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.feedback_observations WHERE tenant_id=$1 AND source_run_id=$2",
      [tenantId, sourceRunId]);
    assert.equal(count.rows[0]!.count, "1");
  });

  test("feedback observations never become trusted labels", async () => {
    await store.recordObservation(principal("feedback-only-user"), sourceRunId, "feedback-never-label", {
      schemaVersion: 1, artifactHash, sentiment: "not_helpful", categories: ["missed_finding"],
      comment: "This is an untrusted user claim, not ground truth.",
    });
    const trusted = await adminPool.query(
      "SELECT id FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2",
      [tenantId, sourceRunId]);
    assert.equal(trusted.rowCount, 0);
  });

  test("two independent exact annotations create one trusted consensus label while preserving both annotations", async () => {
    const request = { artifactHash, labelSet: oneFinding,
      provenance: { method: "full_diff_review" as const, notes: "Reviewed the complete persisted diff." } };
    const left = await store.createAnnotation(principal("reviewer-a"), sourceRunId, "annotation-a", request);
    assert.equal(left.trustedLabelSetId, undefined);
    const right = await store.createAnnotation(principal("reviewer-b"), sourceRunId, "annotation-b", request);
    assert.ok(right.trustedLabelSetId);

    const state = await adminPool.query<{ annotations: string; trusted: string; resolution_kind: string }>(
      `SELECT (SELECT count(*) FROM pr_agent_harness.review_annotations WHERE tenant_id=$1 AND source_run_id=$2) annotations,
              (SELECT count(*) FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2) trusted,
              (SELECT resolution_kind FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2) resolution_kind`,
      [tenantId, sourceRunId]);
    assert.deepEqual(state.rows[0], { annotations: "2", trusted: "1", resolution_kind: "consensus" });
  });

  test("conflicting annotations require a third independent actor to arbitrate exact hashes", async () => {
    const left = await store.createAnnotation(principal("left-reviewer"), arbitrationRunId, "left", {
      artifactHash, labelSet: emptyLabels, provenance: { method: "full_diff_review" },
    });
    const right = await store.createAnnotation(principal("right-reviewer"), arbitrationRunId, "right", {
      artifactHash, labelSet: oneFinding, provenance: { method: "full_diff_review" },
    });
    const arbitration = { artifactHash, rubricVersion: "review-quality.v1" as const,
      leftAnnotationId: left.id, leftLabelSetHash: left.labelSetHash,
      rightAnnotationId: right.id, rightLabelSetHash: right.labelSetHash,
      chosenLabelSetHash: right.labelSetHash,
      reason: "The finding is on an added line and is supported by the durable diff evidence." };
    await assert.rejects(store.arbitrate(principal("left-reviewer"), arbitrationRunId, "self-arbitration", arbitration),
      (error: unknown) => error instanceof RunControlError && error.status === 409);
    const resolved = await store.arbitrate(principal("independent-arbitrator"), arbitrationRunId, "arbitration", arbitration);
    assert.equal(resolved.chosenLabelSetHash, labelSetHash(oneFinding));

    const history = await adminPool.query<{ annotation_count: string; arbitration_count: string; trusted_count: string }>(
      `SELECT (SELECT count(*) FROM pr_agent_harness.review_annotations WHERE tenant_id=$1 AND source_run_id=$2) annotation_count,
              (SELECT count(*) FROM pr_agent_harness.review_annotation_arbitrations WHERE tenant_id=$1 AND source_run_id=$2) arbitration_count,
              (SELECT count(*) FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2) trusted_count`,
      [tenantId, arbitrationRunId]);
    assert.deepEqual(history.rows[0], { annotation_count: "2", arbitration_count: "1", trusted_count: "1" });
  });

  test("purged source reviews reject new feedback and annotation collection", async () => {
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET content_purged_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [tenantId, purgedRunId]);
    await assert.rejects(store.recordObservation(principal("late-user"), purgedRunId, "late-feedback",
      { schemaVersion: 1, artifactHash, sentiment: "helpful", categories: [] }),
    (error: unknown) => error instanceof RunControlError && error.status === 404);
  });

  test("same-tenant principals cannot collect feedback through another integration scope", async () => {
    await assert.rejects(store.recordObservation(principal("cross-scope", otherIntegrationId), sourceRunId, "cross-feedback",
      { schemaVersion: 1, artifactHash, sentiment: "helpful", categories: [] }),
    (error: unknown) => error instanceof RunControlError && error.status === 404);
  });

  test("FORCE RLS hides another tenant from the actual non-bypass application role", async () => {
    const visible = await new HarnessDatabase(appPool).transaction(tenantId, async (client) => client.query(
      "SELECT id FROM pr_agent_harness.feedback_observations WHERE tenant_id=$1", [otherTenantId]));
    assert.equal(visible.rowCount, 0);
    const role = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
  });

  test("CLI migration removes legacy broad evolution grants and denies system-owned insert columns", async () => {
    await adminPool.query(`GRANT INSERT,UPDATE,DELETE ON
      pr_agent_harness.feedback_observations,pr_agent_harness.review_annotations,
      pr_agent_harness.review_annotation_arbitrations,pr_agent_harness.trusted_review_label_sets,
      pr_agent_harness.eval_datasets,pr_agent_harness.eval_cases,
      pr_agent_harness.eval_fixtures,pr_agent_harness.eval_fixture_files TO pr_agent_app`);
    assert.equal((await appPool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege(current_user,'pr_agent_harness.eval_datasets','INSERT') allowed")).rows[0]!.allowed, true);
    const configured = spawnSync(process.execPath, ["--import", "tsx", "src/harness/cli.ts", "migrate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HARNESS_DATABASE_URL: databaseUrl },
    });
    if (configured.status !== 0) throw new Error(`runtime grant repair failed: ${configured.stderr}`);

    const privileges = await appPool.query<Record<string, boolean>>(
      `SELECT
        has_table_privilege(current_user,'pr_agent_harness.eval_datasets','INSERT') dataset_insert,
        has_table_privilege(current_user,'pr_agent_harness.eval_datasets','UPDATE') dataset_update,
        has_table_privilege(current_user,'pr_agent_harness.eval_datasets','DELETE') dataset_delete,
        has_table_privilege(current_user,'pr_agent_harness.feedback_observations','DELETE') feedback_delete,
        has_table_privilege(current_user,'pr_agent_harness.eval_cases','DELETE') cases_delete,
        has_table_privilege(current_user,'pr_agent_harness.eval_fixtures','UPDATE') fixture_update,
        has_table_privilege(current_user,'pr_agent_harness.eval_fixture_files','DELETE') fixture_files_delete,
        has_column_privilege(current_user,'pr_agent_harness.eval_datasets','status','INSERT') dataset_status_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_datasets','frozen_at','INSERT') dataset_frozen_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_datasets','manifest_hash','INSERT') dataset_manifest_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_fixtures','content_purged_at','INSERT') fixture_purge_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_fixtures','created_at','INSERT') fixture_created_insert,
        has_column_privilege(current_user,'pr_agent_harness.review_annotations','superseded_by_annotation_id','INSERT') annotation_superseded_insert,
        has_column_privilege(current_user,'pr_agent_harness.review_annotations','content_purged_at','INSERT') annotation_purge_insert,
        has_column_privilege(current_user,'pr_agent_harness.review_annotations','created_at','INSERT') annotation_created_insert,
        has_column_privilege(current_user,'pr_agent_harness.trusted_review_label_sets','content_purged_at','INSERT') label_purge_insert,
        has_column_privilege(current_user,'pr_agent_harness.trusted_review_label_sets','created_at','INSERT') label_created_insert`);
    assert.deepEqual(privileges.rows[0], Object.fromEntries(Object.keys(privileges.rows[0]!).map((key) => [key, false])));

    const appDb = new HarnessDatabase(appPool);
    for (const [statement, parameters] of [
      [`INSERT INTO pr_agent_harness.eval_datasets
         (tenant_id,name,status,curator_actor_type,curator_actor_id,split_policy_json,split_policy_hash)
       VALUES ($1,'forged-frozen','frozen','user','attacker','{}'::jsonb,$2)`, [tenantId, fingerprint("forged")]],
      ["INSERT INTO pr_agent_harness.eval_fixtures (content_purged_at) VALUES (clock_timestamp())", []],
      ["INSERT INTO pr_agent_harness.review_annotations (superseded_by_annotation_id) VALUES ($1)", [randomUUID()]],
    ] as const) {
      await assert.rejects(appDb.transaction(tenantId, async (client) => client.query(statement, parameters)), (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "42501");
    }
  });

  test("dataset cases are built from an authorized durable collection and fixed-SHA provider reads", async () => {
    const curator = datasetPrincipal("dataset-curator", datasetIntegrationC, ["evaluations:create", "evaluations:read"]);
    const dataset = await datasets.create(curator, { name: "positive-holdout", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const labelId = await trustedLabelId(datasetRunC);
    const source = await datasets.loadCaseSource(curator, dataset.id, datasetRunC, labelId);
    const reads: string[] = [];
    const fixture = await buildDatasetFixture(source, repositoryAdapter(reads));
    const added = await datasets.addCase(curator, dataset.id, dataset.version, source, fixture);
    const frozen = await datasets.freeze(curator, dataset.id, added.version);

    assert.equal(frozen.status, "frozen"); assert.equal(frozen.holdoutCount, 1);
    assert.deepEqual(reads, ["package.json", "src/a.ts"]);
    const caseId = (await adminPool.query<{ id: string }>(
      "SELECT id FROM pr_agent_harness.eval_cases WHERE tenant_id=$1 AND dataset_id=$2", [tenantId, dataset.id])).rows[0]!.id;
    await assert.rejects(datasets.readFixture(curator, dataset.id, caseId),
      (error: unknown) => error instanceof RunControlError && error.code === "HOLDOUT_FORBIDDEN" && error.status === 403);
    const fixtureRead = await datasets.readFixture({ ...curator,
      permissions: [...curator.permissions, "evaluations:holdout"] }, dataset.id, caseId);
    assert.equal(fixtureRead.fixtureHash, fixture.fixtureHash);
  });

  test("dataset freeze rejects repository-lineage or near-duplicate leakage across chronological splits", async () => {
    const curatorA = datasetPrincipal("leak-curator", datasetIntegrationA, ["evaluations:create"]);
    const dataset = await datasets.create(curatorA, { name: "leak-rejection", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    await assert.rejects(datasets.read(datasetPrincipal("different-curator", datasetIntegrationA, ["evaluations:read"]), dataset.id),
      (error: unknown) => error instanceof RunControlError && error.code === "DATASET_NOT_FOUND" && error.status === 404);
    const sourceA = await datasets.loadCaseSource(curatorA, dataset.id, datasetRunA, await trustedLabelId(datasetRunA));
    const first = await datasets.addCase(curatorA, dataset.id, dataset.version, sourceA,
      await buildDatasetFixture(sourceA, repositoryAdapter([])));
    const curatorB = datasetPrincipal("leak-curator", datasetIntegrationB, ["evaluations:create"]);
    const sourceB = await datasets.loadCaseSource(curatorB, dataset.id, datasetRunB, await trustedLabelId(datasetRunB));
    const second = await datasets.addCase(curatorB, dataset.id, first.version, sourceB,
      await buildDatasetFixture(sourceB, repositoryAdapter([])));

    await assert.rejects(datasets.freeze(curatorA, dataset.id, second.version),
      (error: unknown) => error instanceof RunControlError && error.code === "CROSS_SPLIT_LEAKAGE" && error.status === 409);
  });

  test("draft fixture guards and frozen dataset fencing reject additions or mutation", async () => {
    const curator = datasetPrincipal("freeze-curator", datasetIntegrationC, ["evaluations:create"]);
    const dataset = await datasets.create(curator, { name: "freeze-fence", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const source = await datasets.loadCaseSource(curator, dataset.id, datasetRunC, await trustedLabelId(datasetRunC));
    const fixture = await buildDatasetFixture(source, repositoryAdapter([]));
    const added = await datasets.addCase(curator, dataset.id, dataset.version, source, fixture);
    await assert.rejects(new HarnessDatabase(appPool).transaction(tenantId, async (client) => client.query(
      `INSERT INTO pr_agent_harness.eval_fixture_files
         (tenant_id,fixture_id,path,kind,content_text,content_hash,size_bytes)
       VALUES ($1,$2,'src/injected.ts','source','injected',$3,8)`,
      [tenantId, fixture.fixtureHash, fingerprint("injected")])), /fixture(?: file)? referenced by an evaluation dataset is immutable/);
    await assert.rejects(adminPool.query(
      "UPDATE pr_agent_harness.eval_fixtures SET files_manifest_json='[]'::jsonb WHERE tenant_id=$1 AND id=$2",
      [tenantId, fixture.fixtureHash]), /fixture referenced by an evaluation dataset is immutable/);
    await assert.rejects(adminPool.query(
      "UPDATE pr_agent_harness.eval_fixture_files SET content_hash=$3 WHERE tenant_id=$1 AND fixture_id=$2",
      [tenantId, fixture.fixtureHash, fingerprint("tampered-content")]),
    /fixture(?: file)? referenced by an evaluation dataset is immutable/);
    const racing = await Promise.allSettled([
      datasets.freeze(curator, dataset.id, added.version), datasets.freeze(curator, dataset.id, added.version),
    ]);
    const fulfilled = racing.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<DatasetStore["freeze"]>>> =>
      result.status === "fulfilled");
    const rejected = racing.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1); assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof RunControlError);
    assert.equal((rejected[0]!.reason as RunControlError).code, "DATASET_CAS_CONFLICT");
    const frozen = fulfilled[0]!.value;

    await assert.rejects(new HarnessDatabase(appPool).transaction(tenantId, async (client) => client.query(
      "UPDATE pr_agent_harness.eval_datasets SET status='retired',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [tenantId, dataset.id])), /admin|immutable/);
    await assert.rejects(datasets.addCase(curator, dataset.id, frozen.version, source, fixture),
      (error: unknown) => error instanceof RunControlError && error.code === "DATASET_CAS_CONFLICT");
    await assert.rejects(adminPool.query(
      "UPDATE pr_agent_harness.eval_fixture_files SET content_text='mutated' WHERE tenant_id=$1 AND fixture_id=$2",
      [tenantId, fixture.fixtureHash]), /frozen evaluation dataset is immutable|fixture.*referenced by an evaluation dataset is immutable/);
  });

  test("chronological cutoffs assign a middle-period case to the validation split", async () => {
    const curator = datasetPrincipal("validation-curator", datasetIntegrationB, ["evaluations:create"]);
    const dataset = await datasets.create(curator, { name: "validation-split", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const source = await datasets.loadCaseSource(curator, dataset.id, datasetRunB, await trustedLabelId(datasetRunB));
    const added = await datasets.addCase(curator, dataset.id, dataset.version, source,
      await buildDatasetFixture(source, repositoryAdapter([])));
    const frozen = await datasets.freeze(curator, dataset.id, added.version);

    assert.deepEqual({ development: frozen.developmentCount, validation: frozen.validationCount, holdout: frozen.holdoutCount },
      { development: 0, validation: 1, holdout: 0 });
  });

  test("admin retirement and purge preserve identities and do not destroy a fixture shared by an active dataset", async () => {
    const curator = datasetPrincipal("maintenance-curator", datasetIntegrationF,
      ["evaluations:create", "evaluations:read", "evaluations:holdout"]);
    const sourceLabelId = await trustedLabelId(datasetRunF);
    const active = await datasets.create(curator, { name: "active-shared-fixture", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const source = await datasets.loadCaseSource(curator, active.id, datasetRunF, sourceLabelId);
    const fixture = await buildDatasetFixture(source, repositoryAdapter([]));
    const activeAdded = await datasets.addCase(curator, active.id, active.version, source, fixture);
    const activeFrozen = await datasets.freeze(curator, active.id, activeAdded.version);
    const retiring = await datasets.create(curator, { name: "retiring-shared-fixture", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const retiringAdded = await datasets.addCase(curator, retiring.id, retiring.version, source, fixture);
    const retiringFrozen = await datasets.freeze(curator, retiring.id, retiringAdded.version);
    const before = (await adminPool.query<{ manifest_hash: string; fixture_hash: string; artifact_hash: string; label_set_hash: string }>(
      `SELECT d.manifest_hash,c.fixture_hash,f.artifact_hash,c.label_set_hash
       FROM pr_agent_harness.eval_datasets d JOIN pr_agent_harness.eval_cases c
         ON c.tenant_id=d.tenant_id AND c.dataset_id=d.id
       JOIN pr_agent_harness.eval_fixtures f ON f.tenant_id=c.tenant_id AND f.id=c.fixture_id
       WHERE d.tenant_id=$1 AND d.id=$2`, [tenantId, retiring.id])).rows[0]!;

    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET finished_at=clock_timestamp()-interval '90 days' WHERE tenant_id=$1 AND id=$2",
      [tenantId, datasetRunF]);
    const sourceRetention = await new HarnessMaintenanceStore(adminPool).apply({ tenantId, olderThanDays: 30, limit: 10 });
    assert.equal(sourceRetention.applied, 1);

    await assert.rejects(new EvolutionDatasetMaintenanceStore(appPool).retire({ tenantId, datasetId: retiring.id,
      expectedVersion: retiringFrozen.version }), /administrative PostgreSQL role/);
    const maintenance = new EvolutionDatasetMaintenanceStore(adminPool);
    assert.deepEqual(await maintenance.retire({ tenantId, datasetId: retiring.id,
      expectedVersion: retiringFrozen.version }), { retired: true });
    assert.deepEqual(await maintenance.purge({ tenantId, datasetId: retiring.id }), { purged: true, fixtures: 0 });
    const activeCaseId = (await adminPool.query<{ id: string }>(
      "SELECT id FROM pr_agent_harness.eval_cases WHERE tenant_id=$1 AND dataset_id=$2", [tenantId, active.id])).rows[0]!.id;
    assert.equal((await datasets.readFixture(curator, active.id, activeCaseId)).fixtureHash, fixture.fixtureHash);

    await maintenance.retire({ tenantId, datasetId: active.id, expectedVersion: activeFrozen.version });
    assert.deepEqual(await maintenance.purge({ tenantId, datasetId: active.id }), { purged: true, fixtures: 1 });
    const after = (await adminPool.query<{ manifest_hash: string; fixture_hash: string; artifact_hash: string;
      label_set_hash: string; input_json: Record<string, unknown>; live_files: string }>(
      `SELECT d.manifest_hash,c.fixture_hash,f.artifact_hash,c.label_set_hash,f.input_json,
              (SELECT count(*) FROM pr_agent_harness.eval_fixture_files ff
               WHERE ff.tenant_id=f.tenant_id AND ff.fixture_id=f.id AND ff.content_text IS NOT NULL) live_files
       FROM pr_agent_harness.eval_datasets d JOIN pr_agent_harness.eval_cases c
         ON c.tenant_id=d.tenant_id AND c.dataset_id=d.id
       JOIN pr_agent_harness.eval_fixtures f ON f.tenant_id=c.tenant_id AND f.id=c.fixture_id
       WHERE d.tenant_id=$1 AND d.id=$2`, [tenantId, retiring.id])).rows[0]!;
    assert.deepEqual({ manifestHash: after.manifest_hash, fixtureHash: after.fixture_hash,
      artifactHash: after.artifact_hash, labelSetHash: after.label_set_hash },
    { manifestHash: before.manifest_hash, fixtureHash: before.fixture_hash,
      artifactHash: before.artifact_hash, labelSetHash: before.label_set_hash });
    assert.deepEqual(after.input_json, { purged: true }); assert.equal(after.live_files, "0");
  });

  test("freeze rejects a case whose trusted label was corrected after collection", async () => {
    const curator = datasetPrincipal("corrected-label-curator", datasetIntegrationD, ["evaluations:create"]);
    const dataset = await datasets.create(curator, { name: "corrected-label", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const labelId = await trustedLabelId(datasetRunD);
    const source = await datasets.loadCaseSource(curator, dataset.id, datasetRunD, labelId);
    const added = await datasets.addCase(curator, dataset.id, dataset.version, source,
      await buildDatasetFixture(source, repositoryAdapter([])));
    await adminPool.query("UPDATE pr_agent_harness.trusted_review_label_sets SET active=false WHERE tenant_id=$1 AND id=$2",
      [tenantId, labelId]);

    await assert.rejects(datasets.freeze(curator, dataset.id, added.version),
      (error: unknown) => error instanceof RunControlError && error.code === "SOURCE_CHANGED" && error.status === 409);
    assert.equal((await datasets.read({ ...curator, permissions: ["evaluations:read"] }, dataset.id)).status, "draft");
  });

  test("a purged durable fixture cannot be reused by a later dataset", async () => {
    const curator = datasetPrincipal("purged-fixture-curator", datasetIntegrationE, ["evaluations:create"]);
    const first = await datasets.create(curator, { name: "purged-source", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    const source = await datasets.loadCaseSource(curator, first.id, datasetRunE, await trustedLabelId(datasetRunE));
    const fixture = await buildDatasetFixture(source, repositoryAdapter([]));
    const added = await datasets.addCase(curator, first.id, first.version, source, fixture);
    const frozen = await datasets.freeze(curator, first.id, added.version);
    const maintenance = new EvolutionDatasetMaintenanceStore(adminPool);
    await maintenance.retire({ tenantId, datasetId: first.id, expectedVersion: frozen.version });
    assert.deepEqual(await maintenance.purge({ tenantId, datasetId: first.id }), { purged: true, fixtures: 1 });
    const second = await datasets.create(curator, { name: "must-not-reuse-purged", developmentBefore: "2025-06-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });

    await assert.rejects(datasets.addCase(curator, second.id, second.version, source, fixture),
      (error: unknown) => error instanceof RunControlError && error.status === 409);
  });

  async function seedIntegration(id: string, repository: string, providerRepositoryId: number,
    tenant = tenantId): Promise<void> {
    await adminPool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
          publication_state,publication_generation,authority_version,review_execution_mode,execution_mode_generation,
          review_execution_state,quiescence_receipt)
       VALUES ($1,$2,'github','https://github.example.test',$3,$4,1,'env:GITHUB_TOKEN',
         'active',1,1,'harness_async',1,'active','{}'::jsonb)`, [id, tenant, repository, providerRepositoryId]);
  }

  async function seedReview(runId: string, integration: string, tenant = tenantId): Promise<void> {
    const binding = (await adminPool.query<{ origin: string; repository: string; provider_repository_id: string }>(
      "SELECT origin,repository,provider_repository_id FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2",
      [tenant, integration])).rows[0]!;
    const sourceKey = `evolution-source:${runId}`;
    const input = { schemaVersion: 1 as const, workflow: "review.deep.v1" as const, platform: "github" as const,
      target: { origin: binding.origin, repository: binding.repository, number: 42,
        providerRepositoryId: Number(binding.provider_repository_id) },
      source: { key: sourceKey, hash: fingerprint(sourceKey) },
      revision: { baseSha: "a".repeat(40), headSha: "b".repeat(40) }, mode: "report" as const,
      trigger: "comment-command" as const, options: { customRules: [], includeCiChecks: true,
        enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Evolution fixture", body: "", author: "fixture", baseBranch: "main",
        headBranch: "feature", webUrl: `${binding.origin}/${binding.repository}/pull/42`, draft: false } };
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,run_type,create_scope,create_key,
          request_hash,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,
          tool_version_hash,policy_version_hash,runtime_version_hash,input_json,status,finished_at)
       VALUES ($1,$2,$3,'service','evolution-fixture','review.deep.v1',$4,$9,$5,$6,$7,
          $5,$5,$5,$5,$5,$5,$8::jsonb,'succeeded',clock_timestamp())`,
      [runId, tenant, integration, `evolution:${runId}`, fingerprint(input),
        "a".repeat(40), "b".repeat(40), JSON.stringify(input), runId]);
    const collected = { files: [{ newPath: "src/a.ts", patch: "@@ -0,0 +1 @@\n+dangerous = input\n" }],
      pull: { number: 42, baseSha: "a".repeat(40), headSha: "b".repeat(40) } };
    const stepId = randomUUID();
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'github.collect_context.v1','tool',$4,'succeeded',$5,$6::jsonb,1,1,clock_timestamp())`,
      [stepId, tenant, runId, fingerprint(input), fingerprint({ value: collected }), JSON.stringify({ value: collected })]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,$7::jsonb)`,
      [fingerprint(`artifact:${runId}`), tenant, integration, runId, "b".repeat(40), artifactHash, JSON.stringify(artifact)]);
  }

  function datasetPrincipal(subjectId: string, integration: string,
    permissions: RunPrincipal["permissions"]): RunPrincipal {
    return { subjectId, actorType: "user", tenantId, integrationId: integration, permissions };
  }

  async function trustedLabelId(runId: string): Promise<string> {
    return (await adminPool.query<{ id: string }>(
      "SELECT id FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2 AND active",
      [tenantId, runId])).rows[0]!.id;
  }

  function repositoryAdapter(reads: string[]): DatasetRepositoryAdapter {
    const files = new Map([["package.json", "{\"scripts\":{\"test\":\"node --test\"}}\n"],
      ["src/a.ts", "export function review value one two three four five six seven eight\n"]]);
    return { listFiles: async () => ["src/a.ts", ".env", "package.json"],
      readFile: async (path) => { reads.push(path); const content = files.get(path);
        return content === undefined ? null : { path, mode: "100644", bytes: Buffer.from(content) }; },
      readCiStatus: async () => ({ state: "success", sha: "b".repeat(40) }) };
  }
}
