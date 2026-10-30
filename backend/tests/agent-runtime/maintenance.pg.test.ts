import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { RuntimeMaintenanceStore } from "../../src/agent-runtime/maintenance.js";
import { RuntimeMetricsStore } from "../../src/agent-runtime/metrics.js";
import { PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { RunCursorExpiredError, RunQueryStore } from "../../src/agent-runtime/runs/query-store.js";
import { ModelBudgetStore } from "../../src/agent-runtime/budget/model-budget-store.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";

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
  const execution = new RunExecutionStore(db);
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
    const estimatedUnknown = await createRun(tenantId, integrationId, "estimated-unknown-cost");
    const publicationUnknown = await createRun(tenantId, integrationId, "publication-unknown");
    const active = await createRun(tenantId, integrationId, "active");
    const foreign = await createRun(otherTenantId, otherIntegrationId, "foreign");
    await makeOldTerminal(tenantId, eligible.id);
    await makeOldTerminal(tenantId, eligibleSecond.id);
    await makeOldTerminal(tenantId, unknown.id);
    await makeOldTerminal(tenantId, estimatedUnknown.id);
    await makeOldTerminal(otherTenantId, foreign.id);
    const metadata = await addTrace(tenantId, eligible.id, "succeeded");
    const pendingTrace = await addTrace(tenantId, unknown.id, "unknown");
    await addBudgetReservation(tenantId, unknown.id, pendingTrace.modelCallId, "pending");
    const estimatedTrace = await addTrace(tenantId, estimatedUnknown.id, "unknown");
    await addBudgetReservation(tenantId, estimatedUnknown.id, estimatedTrace.modelCallId, "estimated");
    const budget = new ModelBudgetStore(db);
    await budget.reconcileActualUsage({
      tenantId, integrationId, runId: estimatedUnknown.id, modelCallId: estimatedTrace.modelCallId,
      providerUsageRevision: "retention-provider-v1", supersedesProviderUsageRevision: null,
      evidenceReference: "provider://sensitive/pre-retention-evidence",
      usage: { inputTokens: 4, outputTokens: 2, original: { secret: "purge-before-adjusting" } },
      actorType: "service", actorId: "retention-reconciler",
    });
    await pool.query(
      `UPDATE pr_agent_harness.job_queue SET available_at=now()+interval '1 day'
       WHERE tenant_id=$1 AND run_id=$2`, [tenantId, active.id]);
    const publicationLease = await execution.claim({ tenantId, integrationId,
      authorityGeneration: 1, executionModeGeneration: 1 }, "retention-publication", v);
    assert.ok(publicationLease);
    const unresolvedBatch = await new PublicationBatchStore(db).freeze({
      runLease: publicationLease,
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/retention", target: "pull:99", revision: "head", authorityGeneration: 1 },
      sourceKey: "retention-publication-unknown", sourceHash: hash("retention-publication-unknown"),
      operations: [{ slot: "comment:unknown", payload: { body: "unknown publication" } }],
    });
    await makeOldTerminal(tenantId, publicationUnknown.id);
    const unresolvedOperation = unresolvedBatch.operations[0]!.businessOperationId;
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='unknown',attempt_count=1,dispatched_at=now(),last_error_code='response_lost'
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, unresolvedOperation],
    );

    await assert.rejects(
      new RuntimeMaintenanceStore(runtimePool).apply({ tenantId, olderThanDays: 30 }),
      /administrative PostgreSQL role/,
    );
    await assert.rejects(maintenance.preview({ tenantId, olderThanDays: 6 }), /between 7 and 3650/);
    await assert.rejects(maintenance.preview({ tenantId, limit: 1001 }), /between 1 and 1000/);

    const preview = await maintenance.preview({ tenantId, olderThanDays: 30, limit: 10 });
    assert.deepEqual(preview.candidates.map((candidate) => candidate.runId).sort(),
      [eligible.id, eligibleSecond.id, estimatedUnknown.id].sort());
    const applied = await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 });
    assert.equal(applied.applied, 1);
    assert.equal((await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 })).applied, 1);
    assert.equal((await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 })).applied, 1);
    assert.equal((await maintenance.apply({ tenantId, olderThanDays: 30, limit: 1 })).applied, 0);

    await budget.reconcileActualUsage({
      tenantId, integrationId, runId: estimatedUnknown.id, modelCallId: estimatedTrace.modelCallId,
      providerUsageRevision: "retention-provider-v2",
      supersedesProviderUsageRevision: "retention-provider-v1",
      evidenceReference: "provider://sensitive/retention-evidence",
      usage: { inputTokens: 2, outputTokens: 1, original: { secret: "must-not-return" } },
      actorType: "service", actorId: "retention-reconciler",
    });
    const retainedUsage = await pool.query<{ original_usage_json: Record<string, unknown>;
      adjustments: number; evidence_redacted: boolean; all_purged: boolean }>(
      `SELECT ur.original_usage_json,count(a.id)::int AS adjustments,
              bool_and(a.evidence_reference='retained-ledger-only') AS evidence_redacted,
              bool_and(a.content_purged_at IS NOT NULL) AS all_purged
       FROM pr_agent_harness.usage_records ur
       JOIN pr_agent_harness.model_usage_adjustments a
         ON a.tenant_id=ur.tenant_id AND a.model_call_id=ur.model_call_id
       WHERE ur.tenant_id=$1 AND ur.model_call_id=$2
       GROUP BY ur.original_usage_json`,
      [tenantId, estimatedTrace.modelCallId],
    );
    assert.deepEqual(retainedUsage.rows[0]?.original_usage_json, {});
    assert.equal(retainedUsage.rows[0]?.adjustments, 2);
    assert.equal(retainedUsage.rows[0]?.evidence_redacted, true);
    assert.equal(retainedUsage.rows[0]?.all_purged, true);

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
    assert.equal(metrics.runs.succeeded, 5);
    assert.equal(metrics.runs.queued, 1);
    assert.equal(metrics.claimableJobs, 0);
    assert.equal(metrics.pendingBudgetReservations, 1);
    assert.equal("repository" in metrics, false);
  });

  test("retention waits for a concurrent operation revive and skips the newly unresolved Run", async () => {
    const revivedRun = await createRun(tenantId, integrationId, "revive-race");
    const revivedLease = await execution.claim({ tenantId, integrationId,
      authorityGeneration: 1, executionModeGeneration: 1 }, "retention-revive", v);
    assert.ok(revivedLease);
    const batchStore = new PublicationBatchStore(db);
    const batch = await batchStore.freeze({
      runLease: revivedLease,
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/retention", target: "pull:100", revision: "head", authorityGeneration: 1 },
      sourceKey: "retention-revive-race", sourceHash: hash("retention-revive-race"),
      operations: [{ slot: "comment:revive", payload: { body: "revivable publication" } }],
    });
    await makeOldTerminal(tenantId, revivedRun.id);
    const operationId = batch.operations[0]!.businessOperationId;
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='cancelled',outcome_code='publication_abandoned',
           last_error_code='run_cancelled_before_dispatch',resolved_at=now(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, operationId],
    );
    await batchStore.refreshOutcome(tenantId, batch.id);
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
      await waitForBlockedMaintenanceQuery();
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

  async function waitForBlockedMaintenanceQuery(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database()
             AND state='active'
             AND wait_event_type='Lock'
             AND query LIKE '%FOR SHARE OF ro%'
         ) AS blocked`,
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("maintenance did not block on the revived publication operation");
  }

  async function activate(tenant: string, integration: string, repository: string): Promise<void> {
    const store = new RunStore(db);
    const authority = new PublicationAuthorityStore(db);
    await store.registerIntegration({ tenantId: tenant, id: integration, platform: "github",
      origin: "https://github.example.test", repository });
    await authority.configure({ tenantId: tenant, integrationId: integration,
      providerRepositoryId: Math.floor(Math.random() * 1_000_000) + 1, providerActorId: 99,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    await pool.query(
      `UPDATE pr_agent_harness.integration_bindings SET execution_mode_generation=1
       WHERE tenant_id=$1 AND id=$2`, [tenant, integration]);
    await authority.transition({ tenantId: tenant, integrationId: integration, expectedVersion: 1,
      action: "activate", actor: "maintenance-test", actorType: "service",
      quiescenceEvidence: "isolated Docker database" });
    await pool.query("UPDATE pr_agent_harness.integration_bindings SET review_execution_mode='harness_async' WHERE tenant_id=$1 AND id=$2", [tenant, integration]);
  }

  async function createRun(tenant: string, integration: string, key: string) {
    return runs.createRun({ tenantId: tenant, integrationId: integration, actorType: "service",
      actorId: "maintenance-test", createScope: "maintenance.pg.v1", createKey: key,
      requestHash: hash(`request:${tenant}:${key}`), runType: "review.single.v1", baseSha: "base",
      headSha: "head", workflowVersionHash: v, promptVersionHash: v, modelVersionHash: v,
      toolVersionHash: v, policyVersionHash: v, runtimeVersionHash: v,
      authorityGeneration: 1, executionModeGeneration: 1,
      input: { source: `sensitive:${key}` } });
  }

  async function makeOldTerminal(tenant: string, runId: string): Promise<void> {
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,lease_epoch=1,
           finished_at=now()-interval '40 days',updated_at=now()-interval '40 days'
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
    const modelCall = await pool.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.model_calls
         (tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,
          request_hash,request_metadata_json,input_token_bound,output_token_bound,response_json,
          response_hash,status,lease_epoch,finished_at)
       VALUES ($1,$2,$3,$4,1,'openai','fixture','review',$5,$6,10,10,$7,$8,$9,1,
         CASE WHEN $9='succeeded' THEN now() ELSE NULL END) RETURNING id`,
      [tenant, runId, step.rows[0]!.id, attempt.rows[0]!.id, requestHash,
        JSON.stringify({ raw: "sensitive request metadata" }),
        modelStatus === "succeeded" ? JSON.stringify({ raw: "sensitive response" }) : null,
        modelStatus === "succeeded" ? responseHash : null, modelStatus],
    );
    return { outputHash, stateHash, requestHash, responseHash,
      modelCallId: modelCall.rows[0]!.id };
  }

  async function addBudgetReservation(
    tenant: string,
    runId: string,
    modelCallId: string,
    status: "pending" | "estimated",
  ): Promise<void> {
    const pricingHash = hash(`retention-pricing:${tenant}`);
    const periodKey = "2026-01";
    const rates = { inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000,
      cacheWriteInputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000,
      thoughtOutputMicrosPerMillion: 1_000_000, toolInputMicrosPerMillion: 1_000_000 };
    await pool.query(
      `INSERT INTO pr_agent_harness.model_pricing_snapshots
         (tenant_id,pricing_hash,pricing_version,provider,model,currency,rates_json,policy_json)
       VALUES ($1,$2,'retention','openai','fixture','USD',$3::jsonb,'{}'::jsonb)
       ON CONFLICT DO NOTHING`, [tenant, pricingHash, JSON.stringify(rates)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.tenant_budget_accounts
         (tenant_id,period_key,currency,input_token_limit,output_token_limit,cost_limit_micros)
       VALUES ($1,$2,'USD',1000,1000,1000) ON CONFLICT DO NOTHING`, [tenant, periodKey]);
    if (status === "estimated") await pool.query(
      `UPDATE pr_agent_harness.tenant_budget_accounts
       SET spent_input_tokens=spent_input_tokens+10,spent_output_tokens=spent_output_tokens+10,
           spent_cost_micros=spent_cost_micros+20
       WHERE tenant_id=$1 AND period_key=$2 AND currency='USD'`, [tenant, periodKey]);
    await pool.query(
      `INSERT INTO pr_agent_harness.run_budget_envelopes
         (tenant_id,run_id,period_key,currency,pricing_hash,input_token_limit,output_token_limit,
          cost_limit_micros,actual_input_tokens,actual_output_tokens,actual_cost_micros,status,closed_at)
       VALUES ($1,$2,$3,'USD',$4,100,100,100,10,10,20,$5,
         CASE WHEN $5='closed' THEN now() ELSE NULL END)`,
      [tenant, runId, periodKey, pricingHash, status === "pending" ? "pending_reconciliation" : "closed"]);
    await pool.query(
      `INSERT INTO pr_agent_harness.model_budget_reservations
         (tenant_id,run_id,model_call_id,reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,
          actual_input_tokens,actual_output_tokens,actual_cost_micros,status,reconciliation_due_at,
          next_reconcile_at,settlement_kind)
       VALUES ($1,$2,$3,10,10,20,
         CASE WHEN $4='estimated' THEN 10 ELSE NULL END,
         CASE WHEN $4='estimated' THEN 10 ELSE NULL END,
         CASE WHEN $4='estimated' THEN 20 ELSE NULL END,
         CASE WHEN $4='estimated' THEN 'settled' ELSE 'pending' END,
         CASE WHEN $4='pending' THEN now()-interval '1 minute' ELSE NULL END,
         CASE WHEN $4='pending' THEN now()-interval '1 minute' ELSE NULL END,
         CASE WHEN $4='estimated' THEN 'estimated_upper_bound' ELSE NULL END)`,
      [tenant, runId, modelCallId, status]);
    if (status === "estimated") await pool.query(
      `INSERT INTO pr_agent_harness.usage_records
         (tenant_id,run_id,model_call_id,measurement_status,input_tokens,output_tokens,total_tokens,
          cost_micros,currency,pricing_hash,original_usage_json)
       VALUES ($1,$2,$3,'estimated_upper_bound',10,10,20,20,'USD',$4,$5::jsonb)`,
      [tenant, runId, modelCallId, pricingHash, JSON.stringify({ secret: "purge-me" })]);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
