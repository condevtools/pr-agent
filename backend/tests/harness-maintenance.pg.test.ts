import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore } from "../src/agent-runtime/authority/publication-authority.js";
import { RuntimeMaintenanceStore } from "../src/agent-runtime/maintenance.js";
import { RuntimeMetricsStore } from "../src/agent-runtime/metrics.js";
import { PublicationBatchStore } from "../src/agent-runtime/publication/batches.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import { RunCursorExpiredError, RunQueryStore } from "../src/agent-runtime/runs/query-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Harness maintenance PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("maintenance tests require a disposable database");
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const db = new RuntimeDatabase(pool);
  const runs = new RunStore(db);
  const maintenance = new RuntimeMaintenanceStore(pool);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const integrationId = randomUUID();
  const otherIntegrationId = randomUUID();
  const v = hash("retention-version");
  let runtimePool: Pool;

  before(async () => {
    await migrateRuntime(pool);
    await activate(tenantId, integrationId, "acme/retention");
    await activate(otherTenantId, otherIntegrationId, "other/retention");
    const role = `retention_runtime_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'runtime-only' NOSUPERUSER NOBYPASSRLS`);
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = "runtime-only";
    runtimePool = new Pool({ connectionString: url.toString(), max: 1 });
  });

  after(async () => {
    await runtimePool?.end();
    const roles = await pool.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'retention_runtime_%'",
    );
    for (const { rolname } of roles.rows) await pool.query(`DROP ROLE IF EXISTS ${rolname}`);
    await pool.end();
  });

  test("bounded retention is tenant-scoped, blocks unresolved cost, advances cursors, and preserves hashes", async () => {
    const eligible = await createRun(tenantId, integrationId, "eligible");
    const eligibleSecond = await createRun(tenantId, integrationId, "eligible-second");
    const unknown = await createRun(tenantId, integrationId, "unknown-cost");
    const publicationUnknown = await createRun(tenantId, integrationId, "publication-unknown");
    const active = await createRun(tenantId, integrationId, "active");
    const foreign = await createRun(otherTenantId, otherIntegrationId, "foreign");
    await makeOldTerminal(tenantId, eligible.id);
    await makeOldTerminal(tenantId, eligibleSecond.id);
    await makeOldTerminal(tenantId, unknown.id);
    await makeOldTerminal(tenantId, publicationUnknown.id);
    await makeOldTerminal(otherTenantId, foreign.id);
    const metadata = await addTrace(tenantId, eligible.id, "succeeded");
    await addTrace(tenantId, unknown.id, "unknown");
    const unresolvedBatch = await new PublicationBatchStore(db).freeze({
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/retention", target: "pull:99", revision: "head", authorityGeneration: 1 },
      sourceKey: "retention-publication-unknown", sourceHash: hash("retention-publication-unknown"),
      operations: [{ slot: "comment:unknown", payload: { body: "unknown publication" } }],
    });
    const unresolvedOperation = unresolvedBatch.operations[0]!.businessOperationId;
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='unknown',attempt_count=1,dispatched_at=now(),last_error_code='response_lost'
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, unresolvedOperation],
    );
    const batchHash = await pool.query<{ operation_set_hash: string }>(
      `SELECT operation_set_hash FROM pr_agent_harness.publication_batches
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, unresolvedBatch.id],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.run_publication_batches
         (tenant_id,run_id,batch_id,lease_epoch,operation_set_hash)
       VALUES ($1,$2,$3,1,$4)`,
      [tenantId, publicationUnknown.id, unresolvedBatch.id, batchHash.rows[0]!.operation_set_hash],
    );

    await assert.rejects(
      new RuntimeMaintenanceStore(runtimePool).apply({ tenantId, olderThanDays: 30 }),
      /administrative PostgreSQL role/,
    );
    await assert.rejects(maintenance.preview({ tenantId, olderThanDays: 6 }), /between 7 and 3650/);
    await assert.rejects(maintenance.preview({ tenantId, limit: 1001 }), /between 1 and 1000/);

    const preview = await maintenance.preview({ tenantId, olderThanDays: 30, limit: 10 });
    assert.deepEqual(preview.candidates.map((candidate) => candidate.runId).sort(),
      [eligible.id, eligibleSecond.id].sort());
    const applied = await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 });
    assert.equal(applied.applied, 1);
    assert.equal((await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 })).applied, 1);
    assert.equal((await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 })).applied, 0);

    const evidence = await pool.query<{
      input_json: Record<string, unknown>; run_purged: Date | null; event_retention_floor: string;
      next_event_seq: string; output_json: Record<string, unknown>; output_hash: string;
      checkpoint_json: Record<string, unknown>; state_hash: string; response_json: Record<string, unknown>;
      response_hash: string; request_hash: string; result_ref: string | null; audit_count: number;
    }>(
      `SELECT r.input_json,r.content_purged_at AS run_purged,r.event_retention_floor,r.next_event_seq,
              s.output_json,s.output_hash,c.state_json AS checkpoint_json,c.state_hash,
              m.response_json,m.response_hash,m.request_hash,t.result_ref,
              (SELECT count(*)::int FROM pr_agent_harness.run_events e
               WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id
                 AND e.event_type='maintenance.retention_applied' AND e.visibility='internal') audit_count
       FROM pr_agent_harness.agent_runs r
       JOIN pr_agent_harness.agent_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
       JOIN pr_agent_harness.checkpoints c ON c.tenant_id=r.tenant_id AND c.run_id=r.id
       JOIN pr_agent_harness.model_calls m ON m.tenant_id=r.tenant_id AND m.run_id=r.id
       JOIN pr_agent_harness.tool_calls t ON t.tenant_id=r.tenant_id AND t.run_id=r.id
       WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, eligible.id],
    );
    const row = evidence.rows[0]!;
    assert.deepEqual(row.input_json, {});
    assert.ok(row.run_purged);
    assert.deepEqual(row.output_json, {});
    assert.deepEqual(row.checkpoint_json, {});
    assert.deepEqual(row.response_json, {});
    assert.equal(row.result_ref, null);
    assert.equal(row.output_hash, metadata.outputHash);
    assert.equal(row.state_hash, metadata.stateHash);
    assert.equal(row.response_hash, metadata.responseHash);
    assert.equal(row.request_hash, metadata.requestHash);
    assert.equal(row.audit_count, 1);
    assert.equal(Number(row.next_event_seq), Number(row.event_retention_floor) + 1);

    const query = new RunQueryStore(db);
    const principal = { subjectId: "operator", actorType: "user" as const, tenantId,
      integrationId, permissions: ["runs:read" as const] };
    await assert.rejects(query.events(principal, eligible.id, `${eligible.id}:0`), RunCursorExpiredError);
    const states = await pool.query<{ id: string; input_json: Record<string, unknown>; content_purged_at: Date | null }>(
      `SELECT id,input_json,content_purged_at FROM pr_agent_harness.agent_runs
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[unknown.id, publicationUnknown.id, active.id, foreign.id]],
    );
    assert.equal(states.rows.every((state) => state.content_purged_at === null), true);
    assert.equal(states.rows.every((state) => Object.keys(state.input_json).length > 0), true);
    const audit = await pool.query<{ actor_id: string; details_json: Record<string, unknown> }>(
      `SELECT actor_id,details_json FROM pr_agent_harness.audit_logs
       WHERE tenant_id=$1 AND run_id=$2 AND action='harness.retention_apply'`,
      [tenantId, eligible.id],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]!.actor_id, "postgres");
    assert.equal(typeof audit.rows[0]!.details_json.cutoff, "string");
    assert.equal(audit.rows[0]!.details_json.previousEventRetentionFloor, 1);
    const metrics = await new RuntimeMetricsStore(db).snapshot(tenantId, integrationId);
    assert.equal(metrics.runs.succeeded, 4);
    assert.equal(metrics.runs.queued, 1);
    assert.equal(metrics.claimableJobs, 1);
    assert.equal(metrics.pendingBudgetReservations, 0);
    assert.equal("repository" in metrics, false);
  });

  test("retention waits for a concurrent operation revive and skips the newly unresolved Run", async () => {
    const revivedRun = await createRun(tenantId, integrationId, "revive-race");
    await makeOldTerminal(tenantId, revivedRun.id);
    const batchStore = new PublicationBatchStore(db);
    const batch = await batchStore.freeze({
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/retention", target: "pull:100", revision: "head", authorityGeneration: 1 },
      sourceKey: "retention-revive-race", sourceHash: hash("retention-revive-race"),
      operations: [{ slot: "comment:revive", payload: { body: "revivable publication" } }],
    });
    const operationId = batch.operations[0]!.businessOperationId;
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='cancelled',outcome_code='publication_abandoned',
           last_error_code='run_cancelled_before_dispatch',resolved_at=now(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, operationId],
    );
    await batchStore.refreshOutcome(tenantId, batch.id);
    const batchHash = await pool.query<{ operation_set_hash: string }>(
      `SELECT operation_set_hash FROM pr_agent_harness.publication_batches
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, batch.id],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.run_publication_batches
         (tenant_id,run_id,batch_id,lease_epoch,operation_set_hash)
       VALUES ($1,$2,$3,1,$4)`,
      [tenantId, revivedRun.id, batch.id, batchHash.rows[0]!.operation_set_hash],
    );
    const before = await pool.query<{
      input_json: Record<string, unknown>; event_retention_floor: string; next_event_seq: string;
    }>(
      `SELECT input_json,event_retention_floor,next_event_seq FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, revivedRun.id],
    );

    const reviveClient = await pool.connect();
    let maintenanceSettled = false;
    try {
      await reviveClient.query("BEGIN");
      await reviveClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await reviveClient.query(
        `SELECT 1 FROM pr_agent_harness.repository_operations
         WHERE tenant_id=$1 AND business_operation_id=$2 FOR UPDATE`,
        [tenantId, operationId],
      );
      const applying = maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 })
        .finally(() => { maintenanceSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(maintenanceSettled, false);
      await reviveClient.query(
        `UPDATE pr_agent_harness.repository_operations
         SET status='prepared',outcome_code=NULL,last_error_code=NULL,resolved_at=NULL,version=version+1
         WHERE tenant_id=$1 AND business_operation_id=$2`,
        [tenantId, operationId],
      );
      await reviveClient.query(
        `UPDATE pr_agent_harness.publication_batches SET status='pending',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, batch.id],
      );
      await reviveClient.query("COMMIT");
      const result = await applying;
      assert.equal(result.examined, 1);
      assert.equal(result.applied, 0);
    } catch (error) {
      await reviveClient.query("ROLLBACK");
      throw error;
    } finally {
      reviveClient.release();
    }
    const after = await pool.query<{
      input_json: Record<string, unknown>; event_retention_floor: string; next_event_seq: string;
      content_purged_at: Date | null; audit_count: number;
    }>(
      `SELECT r.input_json,r.event_retention_floor,r.next_event_seq,r.content_purged_at,
              (SELECT count(*)::int FROM pr_agent_harness.audit_logs a
               WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id
                 AND a.action='harness.retention_apply') audit_count
       FROM pr_agent_harness.agent_runs r WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, revivedRun.id],
    );
    assert.deepEqual(after.rows[0]!.input_json, before.rows[0]!.input_json);
    assert.equal(after.rows[0]!.event_retention_floor, before.rows[0]!.event_retention_floor);
    assert.equal(after.rows[0]!.next_event_seq, before.rows[0]!.next_event_seq);
    assert.equal(after.rows[0]!.content_purged_at, null);
    assert.equal(after.rows[0]!.audit_count, 0);
  });

  async function activate(tenant: string, integration: string, repository: string): Promise<void> {
    const store = new RunStore(db);
    const authority = new PublicationAuthorityStore(db);
    await store.registerIntegration({ tenantId: tenant, id: integration, platform: "github",
      origin: "https://github.example.test", repository });
    await authority.configure({ tenantId: tenant, integrationId: integration,
      providerRepositoryId: Math.floor(Math.random() * 1_000_000) + 1, providerActorId: 99,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    await authority.transition({ tenantId: tenant, integrationId: integration, expectedVersion: 1,
      action: "activate", actor: "maintenance-test", actorType: "service",
      quiescenceEvidence: "isolated Docker database" });
  }

  async function createRun(tenant: string, integration: string, key: string) {
    return runs.createRun({ tenantId: tenant, integrationId: integration, actorType: "service",
      actorId: "maintenance-test", createScope: "maintenance.pg.v1", createKey: key,
      requestHash: hash(`request:${tenant}:${key}`), runType: "review.single.v1", baseSha: "base",
      headSha: "head", workflowVersionHash: v, promptVersionHash: v, modelVersionHash: v,
      toolVersionHash: v, policyVersionHash: v, runtimeVersionHash: v,
      input: { source: `sensitive:${key}` } });
  }

  async function makeOldTerminal(tenant: string, runId: string): Promise<void> {
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='succeeded',lease_epoch=1,finished_at=now()-interval '40 days',updated_at=now()-interval '40 days'
       WHERE tenant_id=$1 AND id=$2`,
      [tenant, runId],
    );
    await pool.query(
      `UPDATE pr_agent_harness.job_queue SET status='completed',completed_at=now()-interval '40 days'
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenant, runId],
    );
    const sequence = await pool.query<{ sequence: string }>(
      `UPDATE pr_agent_harness.agent_runs SET next_event_seq=next_event_seq+1
       WHERE tenant_id=$1 AND id=$2 RETURNING next_event_seq-1 AS sequence`,
      [tenant, runId],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.run_events
         (tenant_id,run_id,sequence,event_type,visibility,actor_type,actor_id,payload_json)
       VALUES ($1,$2,$3,'run.succeeded','public','system','fixture','{}')`,
      [tenant, runId, sequence.rows[0]!.sequence],
    );
  }

  async function addTrace(tenant: string, runId: string, modelStatus: "succeeded" | "unknown") {
    const outputHash = hash(`output:${runId}`);
    const stateHash = hash(`state:${runId}`);
    const requestHash = hash(`model-request:${runId}`);
    const responseHash = hash(`model-response:${runId}`);
    const step = await pool.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.agent_steps
         (tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,
          last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,'fixture','model',$3,'succeeded',$4,$5,1,1,now()) RETURNING id`,
      [tenant, runId, hash(`input:${runId}`), outputHash,
        JSON.stringify({ raw: "sensitive model output" })],
    );
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.step_attempts
         (tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
       VALUES ($1,$2,$3,1,'fixture',1,'succeeded',now()) RETURNING id`,
      [tenant, runId, step.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.checkpoints
         (tenant_id,run_id,sequence,step_id,step_attempt_id,schema_version,runtime_version_hash,
          state_hash,state_json,lease_epoch)
       VALUES ($1,$2,1,$3,$4,1,$5,$6,$7,1)`,
      [tenant, runId, step.rows[0]!.id, attempt.rows[0]!.id, v, stateHash,
        JSON.stringify({ raw: "sensitive checkpoint" })],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.tool_calls
         (tenant_id,run_id,step_id,step_attempt_id,tool_kind,tool_name,request_hash,status,
          result_hash,result_ref,completed_at)
       VALUES ($1,$2,$3,$4,'provider_read','fixture',$5,'succeeded',$6,'secret://result',now())`,
      [tenant, runId, step.rows[0]!.id, attempt.rows[0]!.id,
        hash(`tool-request:${runId}`), hash(`tool-result:${runId}`)],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.model_calls
         (tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,
          request_hash,request_metadata_json,input_token_bound,output_token_bound,response_json,
          response_hash,status,lease_epoch,finished_at)
       VALUES ($1,$2,$3,$4,1,'openai','fixture','review',$5,$6,10,10,$7,$8,$9,1,
         CASE WHEN $9='succeeded' THEN now() ELSE NULL END)`,
      [tenant, runId, step.rows[0]!.id, attempt.rows[0]!.id, requestHash,
        JSON.stringify({ raw: "sensitive request metadata" }),
        modelStatus === "succeeded" ? JSON.stringify({ raw: "sensitive response" }) : null,
        modelStatus === "succeeded" ? responseHash : null, modelStatus],
    );
    return { outputHash, stateHash, requestHash, responseHash };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
