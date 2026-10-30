import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PgEvolutionDatasetStore } from "../../src/evolution/datasets/store.js";
import { PgEvolutionFeedbackStore } from "../../src/evolution/feedback/store.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) test.skip("Feedback PostgreSQL tests require Docker HARNESS_TEST_DATABASE_URL", () => {});
else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("feedback tests require a disposable database");
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const role = `feedback_app_${process.pid}`; const password = "feedback-test-password";
  let app: Pool; let store: PgEvolutionFeedbackStore;
  const tenantId = randomUUID(); const integrationId = randomUUID(); const otherIntegrationId = randomUUID();
  const runId = randomUUID(); const stepId = randomUUID(); const artifactId = fingerprint("artifact-id");
  const artifact = { workflowId: "review.deep.v1", identity: { tenantId, integrationId, runId }, sourceCoverage: { status: "complete" } };
  const artifactHash = fingerprint(artifact);

  before(async () => {
    process.env.FEATURE_EVOLUTION = "on";
    await migrateRuntime(admin);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) TO ${role}`);
    await admin.query(`GRANT SELECT ON pr_agent_harness.integration_bindings,pr_agent_harness.agent_runs,pr_agent_harness.review_artifacts,
      pr_agent_harness.agent_steps,pr_agent_harness.feedback_observations,pr_agent_harness.review_annotations,
      pr_agent_harness.review_annotation_arbitrations,pr_agent_harness.trusted_review_label_sets,
      pr_agent_harness.eval_datasets TO ${role}`);
    await admin.query(`GRANT INSERT ON pr_agent_harness.feedback_observations,pr_agent_harness.review_annotations,
      pr_agent_harness.review_annotation_arbitrations,pr_agent_harness.trusted_review_label_sets,
      pr_agent_harness.eval_datasets TO ${role}`);
    await admin.query(`GRANT UPDATE (superseded_by_annotation_id) ON pr_agent_harness.review_annotations TO ${role}`);
    await admin.query(`GRANT UPDATE (active) ON pr_agent_harness.trusted_review_label_sets TO ${role}`);
    await admin.query(`GRANT UPDATE ON pr_agent_harness.agent_runs TO ${role}`);
    await admin.query(
      `INSERT INTO pr_agent_harness.integration_bindings (id,tenant_id,platform,origin,repository,active,evolution_enabled)
       VALUES ($1,$3,'github','https://github.example.test','acme/widgets',true,true),
              ($2,$3,'github','https://github.example.test','acme/other',true,true)`,
      [integrationId, otherIntegrationId, tenantId]);
    const version = fingerprint("version");
    await admin.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
          run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
          policy_version_hash,runtime_version_hash,input_json,status,authority_generation,execution_mode_generation,
          deadline_at,finished_at)
       VALUES ($1,$2,$3,'user','creator','feedback-test','feedback-source',$4,'review.deep.v1',$5,$6,$4,$4,$4,$4,$4,$4,
         '{}'::jsonb,'succeeded',1,1,clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [runId, tenantId, integrationId, version, "1".repeat(40), "2".repeat(40)]);
    const collected = { files: [{ newPath: "src/a.ts", patch: "@@ -1,2 +1,3 @@\n old\n+changed\n end" }] };
    await admin.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'github.collect_context.v1','tool',$4,'succeeded',$5,$6::jsonb,1,1,clock_timestamp())`,
      [stepId, tenantId, runId, fingerprint("collector-input"), fingerprint({ value: collected }),
        JSON.stringify({ value: collected })]);
    await admin.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,$7::jsonb)`,
      [artifactId, tenantId, integrationId, runId, "2".repeat(40), artifactHash, JSON.stringify(artifact)]);
    const url = new URL(databaseUrl); url.username = role; url.password = password;
    app = new Pool({ connectionString: url.toString(), max: 3 }); store = new PgEvolutionFeedbackStore(new RuntimeDatabase(app));
  });

  after(async () => { await app?.end(); await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end(); });

  test("feedback stays observational while annotations require consensus or exact third-actor arbitration", async () => {
    const maker = principal("maker", integrationId, ["feedback:create", "annotations:create"]);
    const observation = { schemaVersion: 1 as const, artifactHash, sentiment: "not_helpful" as const,
      categories: ["missed_finding" as const], comment: "Review missed a changed-line defect" };
    const first = await store.recordObservation(maker, runId, "feedback-1", observation);
    assert.equal((await store.recordObservation(maker, runId, "feedback-1", observation)).id, first.id);
    await assert.rejects(store.recordObservation(maker, runId, "feedback-1", { ...observation, sentiment: "helpful" }), /different content/);
    assert.equal((await admin.query("SELECT count(*)::integer AS n FROM pr_agent_harness.trusted_review_label_sets")).rows[0]!.n, 0);

    const wrongScope = principal("maker", otherIntegrationId, ["feedback:create"]);
    await assert.rejects(store.recordObservation(wrongScope, runId, "wrong-integration", observation), /not found/i);

    const label = (title: string, line = 2) => ({ artifactHash,
      labelSet: { schemaVersion: 1 as const, rubricVersion: "review-quality.v1" as const,
        completeness: "complete" as const, expectedFindings: [{ path: "src/a.ts", startLine: line, endLine: line,
          severity: "high" as const, title }] }, provenance: { method: "full_diff_review" as const } });
    await assert.rejects(store.createAnnotation(maker, runId, "outside", label("outside", 99)), /changed line/);
    const annotationA = await store.createAnnotation(maker, runId, "annotation-a", label("unsafe addition"));
    assert.equal(annotationA.trustedLabelSetId, undefined);
    const reviewerB = principal("reviewer-b", integrationId, ["annotations:create"]);
    const annotationB = await store.createAnnotation(reviewerB, runId, "annotation-b", label("unsafe addition"));
    assert.ok(annotationB.trustedLabelSetId);

    const reviewerC = principal("reviewer-c", integrationId, ["annotations:create"]);
    const dissent = await store.createAnnotation(reviewerC, runId, "annotation-c-dissent", {
      ...label("explicitly clean"), labelSet: { ...label("explicitly clean").labelSet, expectedFindings: [] },
    });
    assert.equal(dissent.trustedLabelSetId, undefined);
    const labelHistory = await admin.query<{ version: string; active: boolean }>(
      "SELECT version,active FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2 ORDER BY version",
      [tenantId, runId]);
    assert.deepEqual(labelHistory.rows, [{ version: "1", active: false }]);
    const datasetStore = new PgEvolutionDatasetStore(new RuntimeDatabase(app));
    const curator = principal("curator", integrationId, ["evaluations:create"]);
    const dataset = await datasetStore.create(curator, { name: "inactive-label-rejection",
      developmentBefore: "2025-01-01T00:00:00.000Z", validationBefore: "2026-01-01T00:00:00.000Z" });
    await assert.rejects(datasetStore.loadCaseSource(curator, dataset.id, runId, annotationB.trustedLabelSetId!),
      /not found|unavailable/i);

    const arbitrator = principal("reviewer-d", integrationId, ["annotations:arbitrate"]);
    const arbitration = await store.arbitrate(arbitrator, runId, "arbitration-1", {
      artifactHash, rubricVersion: "review-quality.v1", leftAnnotationId: annotationB.id,
      leftLabelSetHash: annotationB.labelSetHash, rightAnnotationId: dissent.id,
      rightLabelSetHash: dissent.labelSetHash, chosenLabelSetHash: dissent.labelSetHash,
      reason: "The complete review confirms the changed line contains no actionable defect.",
    });
    assert.ok(arbitration.trustedLabelSetId);
    const trusted = await admin.query<{ version: string; active: boolean; label_set_hash: string }>(
      "SELECT version,active,label_set_hash FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2 ORDER BY version",
      [tenantId, runId]);
    assert.deepEqual(trusted.rows, [
      { version: "1", active: false, label_set_hash: annotationB.labelSetHash },
      { version: "2", active: true, label_set_hash: dissent.labelSetHash },
    ]);
    await assert.rejects(store.arbitrate(maker, runId, "maker-cannot-arbitrate", {
      artifactHash, rubricVersion: "review-quality.v1", leftAnnotationId: annotationB.id,
      leftLabelSetHash: annotationB.labelSetHash, rightAnnotationId: dissent.id,
      rightLabelSetHash: dissent.labelSetHash, chosenLabelSetHash: dissent.labelSetHash,
      reason: "The original annotator must not arbitrate their own conflicting annotations.",
    }));
    const reviewerE = principal("reviewer-e", integrationId, ["annotations:create"]);
    const agreement = await store.createAnnotation(reviewerE, runId, "annotation-e-agrees", {
      ...label("explicitly clean"), labelSet: { ...label("explicitly clean").labelSet, expectedFindings: [] },
    });
    assert.equal(agreement.trustedLabelSetId, arbitration.trustedLabelSetId);
    const revision = await store.createAnnotation(reviewerE, runId, "annotation-e-revises", {
      ...label("unsafe addition"), supersedesAnnotationId: agreement.id,
    });
    assert.equal(revision.trustedLabelSetId, undefined);
    assert.equal((await admin.query<{ active: boolean }>(`SELECT active FROM pr_agent_harness.trusted_review_label_sets
      WHERE tenant_id=$1 AND id=$2`, [tenantId, arbitration.trustedLabelSetId])).rows[0]!.active, false);
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await assert.rejects(app.query(`UPDATE pr_agent_harness.review_annotations
        SET superseded_by_annotation_id=NULL WHERE tenant_id=$1 AND id=$2`, [tenantId, agreement.id]), /immutable/i);
    } finally { await app.query("ROLLBACK"); }
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await assert.rejects(app.query(`UPDATE pr_agent_harness.trusted_review_label_sets
        SET active=true WHERE tenant_id=$1 AND source_run_id=$2 AND version=1`, [tenantId, runId]), /immutable/i);
    } finally { await app.query("ROLLBACK"); }
  });

  test("partial source coverage accepts observations but rejects complete ground-truth annotations", async () => {
    const partialRunId = randomUUID(); const partialStepId = randomUUID();
    const partialArtifactId = fingerprint(`partial-artifact:${partialRunId}`);
    const partialArtifact = { workflowId: "review.deep.v1", identity: { tenantId, integrationId, runId: partialRunId },
      sourceCoverage: { status: "partial", reasonCodes: ["file_limit"] }, analysisStatus: "partial", verdict: "incomplete" };
    const partialArtifactHash = fingerprint(partialArtifact); const version = fingerprint("partial-version");
    await admin.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
          run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
          policy_version_hash,runtime_version_hash,input_json,status,authority_generation,execution_mode_generation,
          deadline_at,finished_at)
       VALUES ($1,$2,$3,'user','creator','feedback-test','partial-source',$4,'review.deep.v1',$5,$6,$4,$4,$4,$4,$4,$4,
         '{}'::jsonb,'succeeded',1,1,clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [partialRunId, tenantId, integrationId, version, "1".repeat(40), "3".repeat(40)]);
    const collected = { files: [{ newPath: "src/a.ts", patch: "@@ -1,2 +1,3 @@\n old\n+changed\n end" }] };
    await admin.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'github.collect_context.v1','tool',$4,'succeeded',$5,$6::jsonb,1,1,clock_timestamp())`,
      [partialStepId, tenantId, partialRunId, fingerprint("partial-collector-input"), fingerprint({ value: collected }),
        JSON.stringify({ value: collected })]);
    await admin.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,$7::jsonb)`,
      [partialArtifactId, tenantId, integrationId, partialRunId, "3".repeat(40), partialArtifactHash,
        JSON.stringify(partialArtifact)]);
    const reviewer = principal("partial-reviewer", integrationId, ["feedback:create", "annotations:create"]);
    await store.recordObservation(reviewer, partialRunId, "partial-observation", { schemaVersion: 1,
      artifactHash: partialArtifactHash, sentiment: "helpful", categories: ["other"] });
    await assert.rejects(store.createAnnotation(reviewer, partialRunId, "partial-annotation", {
      artifactHash: partialArtifactHash, labelSet: { schemaVersion: 1, rubricVersion: "review-quality.v1",
        completeness: "complete", expectedFindings: [] }, provenance: { method: "full_diff_review" },
    }), /complete source coverage/i);
  });

  test("only administrators can scrub raw evolution content while identity hashes remain stable", async () => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await assert.rejects(app.query(
        `UPDATE pr_agent_harness.feedback_observations
            SET observation_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
          WHERE tenant_id=$1 AND source_run_id=$2`, [tenantId, runId]), /permission denied/i);
    } finally {
      await app.query("ROLLBACK");
    }

    const before = await admin.query<{ table_name: string; identity_hash: string }>(`
      SELECT 'feedback' AS table_name,request_hash AS identity_hash FROM pr_agent_harness.feedback_observations
       WHERE tenant_id=$1 AND source_run_id=$2
      UNION ALL SELECT 'annotation',label_set_hash FROM pr_agent_harness.review_annotations
       WHERE tenant_id=$1 AND source_run_id=$2
      UNION ALL SELECT 'arbitration',request_hash FROM pr_agent_harness.review_annotation_arbitrations
       WHERE tenant_id=$1 AND source_run_id=$2
      UNION ALL SELECT 'label',label_set_hash FROM pr_agent_harness.trusted_review_label_sets
       WHERE tenant_id=$1 AND source_run_id=$2 ORDER BY table_name,identity_hash`, [tenantId, runId]);
    await admin.query(`UPDATE pr_agent_harness.feedback_observations
      SET observation_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
      WHERE tenant_id=$1 AND source_run_id=$2`, [tenantId, runId]);
    await admin.query(`UPDATE pr_agent_harness.review_annotations
      SET label_set_json='{"purged":true}'::jsonb,provenance_json='{"purged":true}'::jsonb,
          content_purged_at=clock_timestamp() WHERE tenant_id=$1 AND source_run_id=$2`, [tenantId, runId]);
    await admin.query(`UPDATE pr_agent_harness.review_annotation_arbitrations
      SET reason='content purged by retention',content_purged_at=clock_timestamp()
      WHERE tenant_id=$1 AND source_run_id=$2`, [tenantId, runId]);
    await admin.query(`UPDATE pr_agent_harness.trusted_review_label_sets
      SET label_set_json='{"purged":true}'::jsonb,resolution_json='{"purged":true}'::jsonb,
          content_purged_at=clock_timestamp() WHERE tenant_id=$1 AND source_run_id=$2`, [tenantId, runId]);
    const after = await admin.query<{ table_name: string; identity_hash: string }>(`
      SELECT 'feedback' AS table_name,request_hash AS identity_hash FROM pr_agent_harness.feedback_observations
       WHERE tenant_id=$1 AND source_run_id=$2
      UNION ALL SELECT 'annotation',label_set_hash FROM pr_agent_harness.review_annotations
       WHERE tenant_id=$1 AND source_run_id=$2
      UNION ALL SELECT 'arbitration',request_hash FROM pr_agent_harness.review_annotation_arbitrations
       WHERE tenant_id=$1 AND source_run_id=$2
      UNION ALL SELECT 'label',label_set_hash FROM pr_agent_harness.trusted_review_label_sets
       WHERE tenant_id=$1 AND source_run_id=$2 ORDER BY table_name,identity_hash`, [tenantId, runId]);
    assert.deepEqual(after.rows, before.rows);
    assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM pr_agent_harness.feedback_observations
      WHERE observation_json='{"purged":true}'::jsonb AND content_purged_at IS NOT NULL`)).rows[0]!.n, 1);
  });

  test("feedback queued behind source retention rechecks the locked Run and leaves no late observation", async () => {
    const retention = await admin.connect();
    try {
      await retention.query("BEGIN");
      await retention.query("SELECT id FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, runId]);
      let settled = false;
      const pending = store.recordObservation(principal("late-feedback", integrationId, ["feedback:create"]), runId,
        "late-after-purge", { schemaVersion: 1, artifactHash, sentiment: "helpful", categories: ["other"] })
        .finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false);
      await retention.query(`UPDATE pr_agent_harness.agent_runs SET content_purged_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`, [tenantId, runId]);
      await retention.query("COMMIT");
      await assert.rejects(pending, /not found/i);
      assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM pr_agent_harness.feedback_observations
        WHERE tenant_id=$1 AND source_run_id=$2 AND command_key='late-after-purge'`, [tenantId, runId])).rows[0]!.n, 0);
    } finally {
      await retention.query("ROLLBACK").catch(() => undefined);
      retention.release();
    }
  });

  function principal(subjectId: string, scopedIntegrationId: string,
    permissions: RunPrincipal["permissions"]): RunPrincipal {
    return { subjectId, actorType: "user", tenantId, integrationId: scopedIntegrationId, permissions };
  }
}
