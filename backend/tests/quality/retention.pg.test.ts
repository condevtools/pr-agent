import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { PeriodicMaintenanceStore } from "../../src/agent-runtime/retention/periodic-store.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { createMaintenanceTestPool, prepareHarnessRuntimeRoles } from "../support/harness-runtime-roles.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Quality retention PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => undefined);
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("quality retention tests require a disposable database");
  const owner = new Pool({ connectionString: databaseUrl, max: 4 });
  const tenantId = randomUUID(); const integrationId = randomUUID();
  const appPassword = randomUUID(); const hash = fingerprint("quality-retention");
  let maintenance: Pool; let app: Pool;

  before(async () => {
    await prepareHarnessRuntimeRoles(owner, { app: appPassword, verifier: randomUUID() });
    await migrateRuntime(owner);
    maintenance = createMaintenanceTestPool(databaseUrl);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    app = new Pool({ connectionString: appUrl.toString(), max: 2 });
    await owner.query(
      `INSERT INTO pr_agent_harness.integration_bindings (id,tenant_id,platform,origin,repository)
       VALUES ($1,$2,'github','https://api.github.com','condevtools/quality-retention')`,
      [integrationId, tenantId],
    );
  });

  after(async () => { await app?.end(); await maintenance?.end(); await owner.end(); });

  test("quality retention previews without mutation and applies bounded FK-safe cleanup", async () => {
    const unreferencedRuns = await Promise.all([oldRun("trace-a"), oldRun("trace-b")]);
    const annotatedRuns = await Promise.all([oldRun("annotation-a"), oldRun("annotation-b")]);
    const unreferencedTraces = await Promise.all(unreferencedRuns.map((runId, index) =>
      trace(runId, `unreferenced-${index}`)));
    const annotatedTraces = await Promise.all(annotatedRuns.map((runId, index) =>
      trace(runId, `annotated-${index}`)));
    await Promise.all(annotatedTraces.map((traceId, index) => reviewedAnnotation(
      annotatedRuns[index]!, traceId, `score-${index}`)));
    await Promise.all([oldPrompt("prompt-a"), oldPrompt("prompt-b")]);
    await Promise.all([oldSyncJob("sync-a"), oldSyncJob("sync-b")]);

    const store = new PeriodicMaintenanceStore(maintenance);
    const policy = { action: "preview" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 1 };
    const beforeCounts = await tableCounts();
    const preview = await store.run(randomUUID(), policy);
    assert.deepEqual(pickQuality(preview.candidates), {
      qualitySyncJobs: 1, qualityPrompts: 1, qualityAnnotations: 1, qualityTraceLinks: 1,
    });
    assert.deepEqual(pickQuality(preview.applied), {
      qualitySyncJobs: 0, qualityPrompts: 0, qualityAnnotations: 0, qualityTraceLinks: 0,
    });
    assert.deepEqual(await tableCounts(), beforeCounts, "preview must not mutate quality tables");

    const applied = await store.run(randomUUID(), { ...policy, action: "apply" });
    assert.deepEqual(pickQuality(applied.applied), {
      qualitySyncJobs: 1, qualityPrompts: 1, qualityAnnotations: 1, qualityTraceLinks: 1,
    });
    assert.deepEqual(await tableCounts(), {
      syncJobs: beforeCounts.syncJobs - 1,
      prompts: beforeCounts.prompts - 1,
      annotations: beforeCounts.annotations - 1,
      traces: beforeCounts.traces - 1,
      runs: beforeCounts.runs,
    });
    assert.equal((await owner.query(
      "SELECT count(*)::int count FROM pr_agent_harness.quality_trace_links WHERE id=ANY($1::uuid[])",
      [annotatedTraces],
    )).rows[0]!.count, 2, "annotation-referenced traces remain FK-safe until a later cycle");
  });

  test("pending annotations use the longer replay horizon and other roles cannot invoke maintenance", async () => {
    const store = new PeriodicMaintenanceStore(maintenance);
    const policy = { action: "preview" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 100 };
    const baseline = await store.run(randomUUID(), policy);
    const recentRunId = await oldRun("pending-recent");
    const recentTraceId = await trace(recentRunId, "pending-recent");
    const recentPending = await pendingAnnotation(recentRunId, recentTraceId, "pending-recent", 31);
    const afterRecent = await store.run(randomUUID(), policy);
    assert.equal(afterRecent.candidates.qualityAnnotations, baseline.candidates.qualityAnnotations,
      "pending review remains available beyond the content horizon");
    const staleRunId = await oldRun("pending-stale");
    const staleTraceId = await trace(staleRunId, "pending-stale");
    await pendingAnnotation(staleRunId, staleTraceId, "pending-stale", 91);
    const afterStale = await store.run(randomUUID(), policy);
    assert.equal(afterStale.candidates.qualityAnnotations, baseline.candidates.qualityAnnotations + 1,
      "pending review is eventually bounded by the replay horizon");
    await assert.rejects(
      app.query("SELECT pr_agent_harness.run_retention_maintenance($1,'preview',30,90,400,100)", [randomUUID()]),
      /permission denied/,
    );
    await assert.rejects(
      maintenance.query(
        "SELECT pr_agent_harness.run_retention_maintenance_core($1,'preview',30,90,400,100)",
        [randomUUID()],
      ),
      /permission denied/,
      "the restricted role cannot bypass quality retention through the renamed core",
    );
    assert.equal((await owner.query(
      "SELECT 1 FROM pr_agent_harness.quality_annotation_imports WHERE id=$1", [recentPending],
    )).rowCount, 1);
  });

  async function oldRun(key: string): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
          request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,
          tool_version_hash,policy_version_hash,runtime_version_hash,input_json,status,finished_at,updated_at)
       VALUES ($1,$2,$3,'system','retention-test','quality-retention',$4,$5,'review.deep.v1',
         'base','head',$6,$6,$6,$6,$6,$6,'{}'::jsonb,'succeeded',
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
      [id, tenantId, integrationId, key, fingerprint(`request:${key}`), hash],
    );
    return id;
  }

  async function trace(runId: string, key: string): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO pr_agent_harness.quality_trace_links
         (id,tenant_id,integration_id,run_id,run_attempt,trace_id,external_id,target_fingerprint,created_at)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,clock_timestamp()-interval '401 days')`,
      [id, tenantId, integrationId, runId, fingerprint(`trace:${key}`).slice(0, 32), key, hash],
    );
    return id;
  }

  async function reviewedAnnotation(runId: string, traceId: string, key: string): Promise<void> {
    await owner.query(
      `INSERT INTO pr_agent_harness.quality_annotation_imports
         (tenant_id,integration_id,source_run_id,trace_link_id,remote_score_id,content_hash,score_json,
          state,imported_by_actor_type,imported_by_actor_id,review_command_key,
          reviewed_by_actor_type,reviewed_by_actor_id,reviewed_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,'rejected','system','retention-test',$7,
         'service','reviewer',clock_timestamp()-interval '31 days',
         clock_timestamp()-interval '32 days',clock_timestamp()-interval '31 days')`,
      [tenantId, integrationId, runId, traceId, key, fingerprint(`annotation:${key}`), `review:${key}`],
    );
  }

  async function pendingAnnotation(runId: string, traceId: string, key: string, ageDays: number): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO pr_agent_harness.quality_annotation_imports
         (id,tenant_id,integration_id,source_run_id,trace_link_id,remote_score_id,content_hash,score_json,
          state,imported_by_actor_type,imported_by_actor_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'pending_review','system','retention-test',
         clock_timestamp()-make_interval(days=>$8),clock_timestamp()-make_interval(days=>$8))`,
      [id, tenantId, integrationId, runId, traceId, key, fingerprint(`annotation:${key}`), ageDays],
    );
    return id;
  }

  async function oldPrompt(key: string): Promise<void> {
    await owner.query(
      `INSERT INTO pr_agent_harness.quality_prompt_versions
         (tenant_id,integration_id,prompt_key,remote_prompt_name,remote_prompt_version,template_json,
          content_hash,variables,source_fingerprint,target_fingerprint,status,
          imported_by_actor_type,imported_by_actor_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,'{}'::text[],$6,$6,'candidate','system','retention-test',
         clock_timestamp()-interval '31 days',clock_timestamp()-interval '31 days')`,
      [tenantId, integrationId, `test.${key}`, `pr-agent.${key}`, JSON.stringify(`template-${key}`),
        fingerprint(`prompt:${key}`)],
    );
  }

  async function oldSyncJob(key: string): Promise<void> {
    await owner.query(
      `INSERT INTO pr_agent_harness.quality_sync_jobs
         (tenant_id,integration_id,kind,external_id,idempotency_key,request_hash,target_fingerprint,
          payload_json,principal_json,status,result_json,completed_at,created_at,updated_at)
       VALUES ($1,$2,'dataset_export',$3,$3,$4,$5,'{}'::jsonb,'{}'::jsonb,'succeeded','{}'::jsonb,
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days',
         clock_timestamp()-interval '401 days')`,
      [tenantId, integrationId, key, fingerprint(`sync:${key}`), hash],
    );
  }

  async function tableCounts() {
    const result = await owner.query<{ sync_jobs: number; prompts: number; annotations: number; traces: number; runs: number }>(
      `SELECT
        (SELECT count(*)::int FROM pr_agent_harness.quality_sync_jobs) sync_jobs,
        (SELECT count(*)::int FROM pr_agent_harness.quality_prompt_versions) prompts,
        (SELECT count(*)::int FROM pr_agent_harness.quality_annotation_imports) annotations,
        (SELECT count(*)::int FROM pr_agent_harness.quality_trace_links) traces,
        (SELECT count(*)::int FROM pr_agent_harness.agent_runs) runs`,
    );
    const row = result.rows[0]!;
    return { syncJobs: row.sync_jobs, prompts: row.prompts, annotations: row.annotations,
      traces: row.traces, runs: row.runs };
  }

  function pickQuality(value: Record<string, number>) {
    return { qualitySyncJobs: value.qualitySyncJobs, qualityPrompts: value.qualityPrompts,
      qualityAnnotations: value.qualityAnnotations, qualityTraceLinks: value.qualityTraceLinks };
  }
}
