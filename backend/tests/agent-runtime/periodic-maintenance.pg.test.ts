import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { PgRunArtifactStore, prepareRunArtifact } from "../../src/agent-runtime/artifacts/index.js";
import { PeriodicMaintenanceStore } from "../../src/agent-runtime/retention/periodic-store.js";
import { runMaintenanceOnce } from "../../src/agent-runtime/maintenance-process.js";
import { prepareHarnessRuntimeRoles } from "../support/harness-runtime-roles.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Periodic maintenance PostgreSQL tests require Docker", () => undefined);
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("maintenance role tests require a disposable database");
  const owner = new Pool({ connectionString: databaseUrl, max: 6 });
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const version = hash("periodic-maintenance-version");
  let maintenancePool: Pool;
  let appPool: Pool;

  before(async () => {
    await prepareHarnessRuntimeRoles(owner, { app: "maintenance-app-test", verifier: "maintenance-verifier-test" });
    await migrateRuntime(owner);
    maintenancePool = rolePool("pr_agent_maintenance", "maintenance-test-only");
    appPool = rolePool("pr_agent_app", "maintenance-app-test");
  });

  after(async () => {
    await maintenancePool?.end();
    await appPool?.end();
    await owner.end();
  });

  test("maintenance role is function-only and cycle receipts are atomic and idempotent", async () => {
    const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean; memberships: number }>(
      `SELECT r.rolsuper,r.rolbypassrls,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) memberships
       FROM pg_roles r WHERE r.rolname='pr_agent_maintenance'`,
    );
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, memberships: 0 });
    await assert.rejects(
      maintenancePool.query("SELECT count(*) FROM pr_agent_harness.agent_runs"),
      /permission denied/,
    );
    await assert.rejects(
      maintenancePool.query("INSERT INTO pr_agent_harness.audit_logs (tenant_id,actor_type,action,decision) VALUES ($1,'service','forbidden','allowed')", [tenantId]),
      /permission denied/,
    );
    await assert.rejects(
      appPool.query("SELECT pr_agent_harness.run_retention_maintenance($1,'preview',30,90,400,100)", [randomUUID()]),
      /permission denied/,
    );
    await assert.rejects(
      runMaintenanceOnce({ HARNESS_DATABASE_URL: databaseUrl },
        ["--once", "--cycle-id", randomUUID()]),
      /maintenance role mismatch/,
    );
    const heartbeatId = randomUUID();
    await maintenancePool.query(
      "SELECT pr_agent_harness.record_runtime_process_heartbeat('maintenance',$1,$2::jsonb)",
      [heartbeatId, JSON.stringify({ schemaVersion: 1, mode: "preview" })],
    );
    assert.equal((await owner.query(
      "SELECT 1 FROM pr_agent_harness.runtime_process_heartbeats WHERE process_role='maintenance' AND instance_id=$1",
      [heartbeatId],
    )).rowCount, 1);
    await maintenancePool.query(
      "SELECT pr_agent_harness.remove_runtime_process_heartbeat('maintenance',$1)", [heartbeatId],
    );

    const store = new PeriodicMaintenanceStore(maintenancePool);
    const cycleId = randomUUID();
    const policy = { action: "preview" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 100 };
    const [left, right] = await Promise.all([store.run(cycleId, policy), store.run(cycleId, policy)]);
    assert.deepEqual(left, right);
    assert.equal(left.action, "preview");
    assert.equal((await owner.query("SELECT 1 FROM pr_agent_harness.maintenance_receipts WHERE cycle_id=$1", [cycleId])).rowCount, 1);
    await assert.rejects(store.run(cycleId, { ...policy, action: "apply" }), /cycle id was reused/);

    const rollbackCycle = randomUUID();
    const client = await maintenancePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pr_agent_harness.run_retention_maintenance($1,'preview',30,90,400,100)",
        [rollbackCycle],
      );
      await client.query("ROLLBACK");
    } finally { client.release(); }
    assert.equal((await owner.query("SELECT 1 FROM pr_agent_harness.maintenance_receipts WHERE cycle_id=$1", [rollbackCycle])).rowCount, 0);
    await assert.rejects(store.run(randomUUID(), { ...policy, replayDays: 30 }), /invalid maintenance retention policy/);
    await assert.rejects(
      maintenancePool.query(
        "SELECT pr_agent_harness.run_retention_maintenance(NULL,'preview',30,90,400,100)",
      ),
      /invalid maintenance cycle id/,
    );
    await assert.rejects(
      maintenancePool.query(
        "SELECT pr_agent_harness.run_retention_maintenance($1,'preview',30,90,400,NULL)",
        [randomUUID()],
      ),
      /invalid maintenance retention policy/,
    );
  });

  test("preview and apply use the same bounded candidates and scrub raw content", async () => {
    const run = await createOldRun("raw-content");
    await owner.query(
      `INSERT INTO pr_agent_harness.webhook_replay_events
         (tenant_id,integration_id,platform,delivery_id,event_name,received_at,outcome,outcome_code,
          headers_json,payload_json,payload_hash,raw_body_hash)
       VALUES ($1,$2,'github','old-delivery','pull_request',clock_timestamp()-interval '100 days',
         'succeeded','handled',$3::jsonb,$4::jsonb,$5,$6)`,
      [tenantId, integrationId, JSON.stringify({ authorization: "secret" }),
        JSON.stringify({ secret: "payload" }), hash("payload"), hash("raw")],
    );
    const currentOperation = hash("current-operation");
    const retiredOperation = hash("retired-operation");
    for (const [operationId, slot, current] of [
      [currentOperation, "summary", true], [retiredOperation, "old-summary", false],
    ] as const) {
      await owner.query(
        `INSERT INTO pr_agent_harness.repository_operations
           (tenant_id,integration_id,business_operation_id,platform,origin,repository,target,revision,
            publication_slot,payload_hash,marker,status,outcome_code,remote_id,resolved_at,updated_at)
         VALUES ($1,$2,$3,'github','https://github.example.test','acme/maintenance','pull:1','head',
           $4,$5,$6,$7,$8,$9,clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
        [tenantId, integrationId, operationId, slot, hash(`payload:${slot}`), `marker:${slot}`,
          current ? "succeeded" : "failed_definite", current ? "current" : "stale",
          current ? "comment:1" : null],
      );
    }
    await owner.query(
      `INSERT INTO pr_agent_harness.publication_slots
         (tenant_id,integration_id,target,publication_slot,active_business_operation_id)
       VALUES ($1,$2,'pull:1','summary',$3)`,
      [tenantId, integrationId, currentOperation],
    );
    const store = new PeriodicMaintenanceStore(maintenancePool);
    const policy = { action: "preview" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 100 };
    const preview = await store.run(randomUUID(), policy);
    assert.equal(preview.candidates.runContent, 1);
    assert.equal(preview.candidates.replayContent, 1);
    assert.equal(preview.candidates.replayRows, 1);
    assert.equal(preview.candidates.repositoryOperations, 1);

    const applied = await store.run(randomUUID(), { ...policy, action: "apply" });
    assert.equal(applied.candidates.runContent, preview.candidates.runContent);
    assert.equal(applied.candidates.replayContent, preview.candidates.replayContent);
    assert.equal(applied.candidates.replayRows, preview.candidates.replayRows);
    assert.equal(applied.applied.runContent, 1);
    assert.equal(applied.applied.replayContent, 1);
    assert.equal(applied.applied.replayRows, 1);
    assert.equal(applied.applied.repositoryOperations, 1);

    const state = await owner.query<{ input_json: Record<string, unknown>; content_purged_at: Date | null;
      retention_events: number; replay_rows: number }>(
      `SELECT r.input_json,r.content_purged_at,
              (SELECT count(*)::int FROM pr_agent_harness.run_events e
               WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id
                 AND e.event_type='maintenance.retention_applied') retention_events,
              (SELECT count(*)::int FROM pr_agent_harness.webhook_replay_events e
               WHERE e.tenant_id=r.tenant_id) replay_rows
       FROM pr_agent_harness.agent_runs r WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, run.id],
    );
    assert.deepEqual(state.rows[0]!.input_json, {});
    assert.ok(state.rows[0]!.content_purged_at);
    assert.equal(state.rows[0]!.retention_events, 1);
    assert.equal(state.rows[0]!.replay_rows, 0);
    const operations = await owner.query<{ business_operation_id: string }>(
      "SELECT business_operation_id FROM pr_agent_harness.repository_operations WHERE tenant_id=$1 ORDER BY business_operation_id",
      [tenantId],
    );
    assert.deepEqual(operations.rows.map((row) => row.business_operation_id), [currentOperation]);
  });

  test("terminal Fix holds release once without deleting retained artifact content", async () => {
    const run = await createOldRun("terminal-fix-hold");
    const freshRun = await createOldRun("fresh-terminal-fix-hold", 1);
    const artifactStore = new PgRunArtifactStore(new RuntimeDatabase(owner));
    const artifact = await artifactStore.putStepOutput({ tenantId, integrationId, runId: run.id },
      Buffer.from(JSON.stringify({ value: { proof: "fix verification" } }), "utf8"));
    const freshArtifact = await artifactStore.putStepOutput(
      { tenantId, integrationId, runId: freshRun.id },
      Buffer.from(JSON.stringify({ value: { proof: "fresh fix verification" } }), "utf8"),
    );
    await artifactStore.hold({ tenantId, integrationId, runId: run.id }, artifact.artifactHash,
      `fix:${run.id}`, "fix");
    await artifactStore.hold({ tenantId, integrationId, runId: freshRun.id }, freshArtifact.artifactHash,
      `fix:${freshRun.id}`, "fix");
    const store = new PeriodicMaintenanceStore(maintenancePool);
    const policy = { action: "apply" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 100 };
    const applied = await store.run(randomUUID(), policy);
    assert.equal(applied.applied.fixHoldReleases, 1);
    assert.equal(applied.applied.artifacts, 0);
    const state = await owner.query<{ releases: number; purged_at: Date | null; has_content: boolean }>(
      `SELECT (SELECT count(*)::int FROM pr_agent_harness.run_artifact_hold_releases release
                WHERE release.tenant_id=artifact.tenant_id AND release.run_id=artifact.run_id
                  AND release.artifact_hash=artifact.artifact_hash) releases,
              artifact.purged_at,(artifact.content_compressed IS NOT NULL) has_content
       FROM pr_agent_harness.run_artifacts artifact
       WHERE artifact.tenant_id=$1 AND artifact.run_id=$2 AND artifact.artifact_hash=$3`,
      [tenantId, run.id, artifact.artifactHash],
    );
    assert.equal(state.rows[0]!.releases, 1);
    assert.equal(state.rows[0]!.purged_at, null);
    assert.equal(state.rows[0]!.has_content, true);
    assert.equal((await owner.query(
      `SELECT 1 FROM pr_agent_harness.run_artifact_hold_releases
       WHERE tenant_id=$1 AND run_id=$2 AND artifact_hash=$3`,
      [tenantId, freshRun.id, freshArtifact.artifactHash],
    )).rowCount, 0, "a newly terminal Fix Run keeps its human approval window");
    const second = await store.run(randomUUID(), policy);
    assert.equal(second.applied.fixHoldReleases, 0);
    assert.equal(second.applied.artifacts, 0);
  });

  test("trace horizon deletes a closed ordinary model graph and preserves tenant budget totals", async () => {
    const run = await createOldRun("closed-model-trace", 401);
    const step = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.agent_steps
         (tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,
          last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,'model','model',$3,'succeeded',$4,'{}'::jsonb,1,1,
         clock_timestamp()-interval '401 days') RETURNING id`,
      [tenantId, run.id, hash("trace-input"), hash("trace-output")],
    );
    const attempt = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.step_attempts
         (tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
       VALUES ($1,$2,$3,1,'trace-worker',1,'succeeded',clock_timestamp()-interval '401 days') RETURNING id`,
      [tenantId, run.id, step.rows[0]!.id],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.checkpoints
         (tenant_id,run_id,sequence,step_id,step_attempt_id,schema_version,runtime_version_hash,
          state_hash,state_json,lease_epoch,created_at)
       VALUES ($1,$2,1,$3,$4,1,$5,$6,'{}'::jsonb,1,clock_timestamp()-interval '401 days')`,
      [tenantId, run.id, step.rows[0]!.id, attempt.rows[0]!.id, version, hash("trace-state")],
    );
    const model = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.model_calls
         (tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,
          request_hash,input_token_bound,output_token_bound,response_json,response_hash,status,
          lease_epoch,created_at,finished_at)
       VALUES ($1,$2,$3,$4,1,'openai','trace-model','review.single.v1',$5,10,10,'{}'::jsonb,
         $6,'succeeded',1,clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')
       RETURNING id`,
      [tenantId, run.id, step.rows[0]!.id, attempt.rows[0]!.id,
        hash("trace-request"), hash("trace-response")],
    );
    const pricingHash = hash("trace-pricing");
    await owner.query(
      `INSERT INTO pr_agent_harness.model_pricing_snapshots
         (tenant_id,pricing_hash,pricing_version,provider,model,currency,rates_json,policy_json)
       VALUES ($1,$2,'v1','openai','trace-model','USD','{}'::jsonb,'{}'::jsonb)`,
      [tenantId, pricingHash],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.tenant_budget_accounts
         (tenant_id,period_key,currency,input_token_limit,output_token_limit,cost_limit_micros,
          spent_input_tokens,spent_output_tokens,spent_cost_micros)
       VALUES ($1,'2025-01','USD',1000,1000,100000,2,1,30)`, [tenantId],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.run_budget_envelopes
         (tenant_id,run_id,period_key,currency,pricing_hash,input_token_limit,output_token_limit,
          cost_limit_micros,actual_input_tokens,actual_output_tokens,actual_cost_micros,status,closed_at)
       VALUES ($1,$2,'2025-01','USD',$3,100,100,10000,2,1,30,'closed',
         clock_timestamp()-interval '401 days')`,
      [tenantId, run.id, pricingHash],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.model_usage_adjustments
         (tenant_id,run_id,model_call_id,provider_usage_revision,supersedes_provider_usage_revision,
          payload_hash,evidence_reference,actual_input_tokens,actual_output_tokens,actual_cost_micros,
          delta_input_tokens,delta_output_tokens,delta_cost_micros,actor_type,actor_id,created_at)
       VALUES ($1,$2,$3,'revision-1',NULL,$4,'retained-ledger-only',3,2,40,3,2,40,
         'service','trace-test',clock_timestamp()-interval '401 days'),
        ($1,$2,$3,'revision-2','revision-1',$5,'retained-ledger-only',2,1,30,-1,-1,-10,
         'service','trace-test',clock_timestamp()-interval '401 days')`,
      [tenantId, run.id, model.rows[0]!.id, hash("revision-1"), hash("revision-2")],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.model_budget_reservations
         (tenant_id,run_id,model_call_id,reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,
          actual_input_tokens,actual_output_tokens,actual_cost_micros,status,settlement_kind,
          current_provider_usage_revision,created_at,updated_at)
       VALUES ($1,$2,$3,2,1,30,2,1,30,'settled','actual','revision-2',
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
      [tenantId, run.id, model.rows[0]!.id],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.usage_records
         (tenant_id,run_id,model_call_id,measurement_status,input_tokens,output_tokens,total_tokens,
          cost_micros,currency,pricing_hash,original_usage_json,measured_at,updated_at)
       VALUES ($1,$2,$3,'actual',2,1,3,30,'USD',$4,'{}'::jsonb,
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
      [tenantId, run.id, model.rows[0]!.id, pricingHash],
    );
    const publication = await insertClosedPublicationGraph(run.id, step.rows[0]!.id);
    const currentRun = await createOldRun("current-publication-trace", 401);
    const currentPublication = await insertClosedPublicationGraph(currentRun.id, null);
    await owner.query(
      `INSERT INTO pr_agent_harness.publication_slots
         (tenant_id,integration_id,target,publication_slot,active_business_operation_id)
       VALUES ($1,$2,'pull:trace','review-summary',$3)`,
      [tenantId, integrationId, currentPublication.operationId],
    );
    const store = new PeriodicMaintenanceStore(maintenancePool);
    const policy = { action: "apply" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 100 };
    const preview = await store.run(randomUUID(), { ...policy, action: "preview" });
    assert.equal(preview.candidates.traceRuns, 1);
    const applied = await store.run(randomUUID(), policy);
    assert.equal(applied.applied.traceRuns, 1);
    assert.equal((await owner.query(
      "SELECT 1 FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, run.id],
    )).rowCount, 0);
    assert.equal((await owner.query(
      "SELECT 1 FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
      [tenantId, currentRun.id],
    )).rowCount, 1);
    for (const [table, column, value] of [
      ["publication_batches", "id", publication.batchId],
      ["repository_operations", "business_operation_id", publication.operationId],
      ["publication_command_receipts", "business_operation_id", publication.operationId],
      ["run_command_receipts", "id", publication.runReceiptId],
      ["run_waits", "id", publication.waitId],
      ["job_queue", "id", publication.manualJobId],
    ] as const) {
      assert.equal((await owner.query(
        `SELECT 1 FROM pr_agent_harness.${table} WHERE tenant_id=$1 AND ${column}=$2`,
        [tenantId, value],
      )).rowCount, 0);
    }
    const account = await owner.query<{ spent_input_tokens: string; spent_output_tokens: string;
      spent_cost_micros: string }>(
      `SELECT spent_input_tokens,spent_output_tokens,spent_cost_micros
       FROM pr_agent_harness.tenant_budget_accounts
       WHERE tenant_id=$1 AND period_key='2025-01' AND currency='USD'`, [tenantId],
    );
    assert.deepEqual(account.rows[0], {
      spent_input_tokens: "2", spent_output_tokens: "1", spent_cost_micros: "30",
    });
  });

  test("dead-letter detail scrub requires prior safe content purge and preserves held or unknown Runs", async () => {
    const safe = await createOldRun("deadletter-safe", 401);
    const held = await createOldRun("deadletter-held", 401);
    const unknown = await createOldRun("deadletter-unknown", 401);
    const artifactStore = new PgRunArtifactStore(new RuntimeDatabase(owner));
    const heldArtifact = await artifactStore.putStepOutput(
      { tenantId, integrationId, runId: held.id }, Buffer.from("legal hold evidence"),
    );
    await artifactStore.hold({ tenantId, integrationId, runId: held.id },
      heldArtifact.artifactHash, `legal:${held.id}`, "qualification");
    const unknownStep = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.agent_steps
         (tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,
          last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,'unknown-deadletter','model',$3,'succeeded',$4,'{}'::jsonb,1,1,
         clock_timestamp()-interval '401 days') RETURNING id`,
      [tenantId, unknown.id, hash("unknown-deadletter-input"), hash("unknown-deadletter-output")],
    );
    const unknownAttempt = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.step_attempts
         (tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
       VALUES ($1,$2,$3,1,'deadletter-worker',1,'succeeded',
         clock_timestamp()-interval '401 days') RETURNING id`,
      [tenantId, unknown.id, unknownStep.rows[0]!.id],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.model_calls
         (tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,
          request_hash,input_token_bound,output_token_bound,status,lease_epoch,created_at,finished_at)
       VALUES ($1,$2,$3,$4,1,'openai','deadletter-model','review.single.v1',$5,10,10,
         'unknown',1,clock_timestamp()-interval '401 days',NULL)`,
      [tenantId, unknown.id, unknownStep.rows[0]!.id, unknownAttempt.rows[0]!.id,
        hash("unknown-deadletter-request")],
    );
    await owner.query(
      `UPDATE pr_agent_harness.agent_runs
       SET content_purged_at=clock_timestamp()-interval '31 days',input_json='{}'::jsonb
       WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
      [tenantId, [safe.id, held.id, unknown.id]],
    );
    const safeDeadletter = await insertDeadletter(safe.id, "safe details");
    const heldDeadletter = await insertDeadletter(held.id, "legal hold details");
    const unknownDeadletter = await insertDeadletter(unknown.id, "unknown model details");
    const store = new PeriodicMaintenanceStore(maintenancePool);
    const policy = { action: "apply" as const, contentDays: 30, replayDays: 90,
      traceDays: 400, batchLimit: 100 };
    const preview = await store.run(randomUUID(), { ...policy, action: "preview" });
    assert.equal(preview.candidates.deadLetterContent, 1);
    const applied = await store.run(randomUUID(), policy);
    assert.equal(applied.applied.deadLetterContent, 1);
    const details = await owner.query<{ id: string; details_json: Record<string, unknown>;
      content_purged_at: Date | null }>(
      `SELECT id,details_json,content_purged_at FROM pr_agent_harness.dead_letter_jobs
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[safeDeadletter, heldDeadletter, unknownDeadletter]],
    );
    const byId = new Map(details.rows.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(safeDeadletter)?.details_json, {});
    assert.ok(byId.get(safeDeadletter)?.content_purged_at);
    assert.deepEqual(byId.get(heldDeadletter)?.details_json, { secret: "legal hold details" });
    assert.equal(byId.get(heldDeadletter)?.content_purged_at, null);
    assert.deepEqual(byId.get(unknownDeadletter)?.details_json, { secret: "unknown model details" });
    assert.equal(byId.get(unknownDeadletter)?.content_purged_at, null);
  });

  test("periodic artifact GC preserves unknown model and unclosed budget Runs", async () => {
    const ordinary = await createOldRun("gc-ordinary");
    const unknown = await createOldRun("gc-unknown-model");
    const budget = await createOldRun("gc-unclosed-budget");
    const ordinaryHash = await insertExpiredArtifact(ordinary.id, "ordinary");
    const unknownHash = await insertExpiredArtifact(unknown.id, "unknown");
    const budgetHash = await insertExpiredArtifact(budget.id, "budget");
    const step = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.agent_steps
         (tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,
          last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,'unknown','model',$3,'succeeded',$4,'{}'::jsonb,1,1,clock_timestamp()) RETURNING id`,
      [tenantId, unknown.id, hash("unknown-input"), hash("unknown-output")],
    );
    const attempt = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.step_attempts
         (tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
       VALUES ($1,$2,$3,1,'gc-worker',1,'succeeded',clock_timestamp()) RETURNING id`,
      [tenantId, unknown.id, step.rows[0]!.id],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.model_calls
         (tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,
          request_hash,input_token_bound,output_token_bound,status,lease_epoch)
       VALUES ($1,$2,$3,$4,1,'openai','gc-model','review.single.v1',$5,10,10,'unknown',1)`,
      [tenantId, unknown.id, step.rows[0]!.id, attempt.rows[0]!.id, hash("unknown-request")],
    );
    const pricingHash = hash("gc-budget-pricing");
    await owner.query(
      `INSERT INTO pr_agent_harness.model_pricing_snapshots
         (tenant_id,pricing_hash,pricing_version,provider,model,currency,rates_json,policy_json)
       VALUES ($1,$2,'v1','openai','gc-model','EUR','{}'::jsonb,'{}'::jsonb)`,
      [tenantId, pricingHash],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.tenant_budget_accounts
         (tenant_id,period_key,currency,input_token_limit,output_token_limit,cost_limit_micros)
       VALUES ($1,'2025-02','EUR',100,100,1000)`, [tenantId],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.run_budget_envelopes
         (tenant_id,run_id,period_key,currency,pricing_hash,input_token_limit,output_token_limit,
          cost_limit_micros,status)
       VALUES ($1,$2,'2025-02','EUR',$3,100,100,1000,'active')`,
      [tenantId, budget.id, pricingHash],
    );
    const applied = await runMaintenanceOnce({
      HARNESS_DATABASE_URL: roleUrl("pr_agent_maintenance", "maintenance-test-only"),
    }, ["--once", "--action", "apply", "--cycle-id", randomUUID()]);
    assert.equal(applied.candidates.artifacts, 1);
    assert.equal(applied.applied.artifacts, 1);
    const artifacts = await owner.query<{ artifact_hash: string; purged_at: Date | null }>(
      `SELECT artifact_hash,purged_at FROM pr_agent_harness.run_artifacts
       WHERE tenant_id=$1 AND artifact_hash=ANY($2::text[]) ORDER BY artifact_hash`,
      [tenantId, [ordinaryHash, unknownHash, budgetHash]],
    );
    assert.ok(artifacts.rows.find((row) => row.artifact_hash === ordinaryHash)?.purged_at);
    assert.equal(artifacts.rows.find((row) => row.artifact_hash === unknownHash)?.purged_at, null);
    assert.equal(artifacts.rows.find((row) => row.artifact_hash === budgetHash)?.purged_at, null);
  });

  async function createOldRun(key: string, ageDays = 31) {
    const runs = new RunStore(new RuntimeDatabase(owner));
    const existing = await owner.query("SELECT 1 FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2", [tenantId, integrationId]);
    if (!existing.rowCount) {
      await runs.registerIntegration({ tenantId, id: integrationId, platform: "github",
        origin: "https://github.example.test", repository: "acme/maintenance" });
      const authority = new PublicationAuthorityStore(new RuntimeDatabase(owner));
      await authority.configure({ tenantId, integrationId, providerRepositoryId: 771,
        providerActorId: 772, credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
      await owner.query(
        "UPDATE pr_agent_harness.integration_bindings SET execution_mode_generation=1 WHERE tenant_id=$1 AND id=$2",
        [tenantId, integrationId],
      );
      await authority.transition({ tenantId, integrationId, expectedVersion: 1, action: "activate",
        actor: "maintenance-test", actorType: "service", quiescenceEvidence: "isolated Docker database" });
      await owner.query(
        "UPDATE pr_agent_harness.integration_bindings SET review_execution_mode='harness_async' WHERE tenant_id=$1 AND id=$2",
        [tenantId, integrationId],
      );
    }
    const run = await runs.createRun({ tenantId, integrationId, actorType: "service",
      actorId: "maintenance-test", createScope: "periodic-maintenance.pg.v1", createKey: key,
      requestHash: hash(`request:${key}`), runType: "review.single.v1", baseSha: "base", headSha: "head",
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      authorityGeneration: 1, executionModeGeneration: 1, input: { secret: key } });
    await owner.query(
      `UPDATE pr_agent_harness.agent_runs SET status='succeeded',
         finished_at=clock_timestamp()-make_interval(days=>$3),
         updated_at=clock_timestamp()-make_interval(days=>$3),next_outcome_scan_at=NULL
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, run.id, ageDays],
    );
    await owner.query(
      `UPDATE pr_agent_harness.job_queue SET status='completed',
         completed_at=clock_timestamp()-make_interval(days=>$3)
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, run.id, ageDays],
    );
    return run;
  }

  async function insertExpiredArtifact(runId: string, label: string): Promise<string> {
    const prepared = await prepareRunArtifact(Buffer.from(label), {
      contentType: "text/plain", purpose: "other",
    });
    await owner.query(
      `INSERT INTO pr_agent_harness.run_artifacts
         (tenant_id,integration_id,run_id,artifact_hash,purpose,content_type,raw_size_bytes,
          compressed_size_bytes,content_compressed,retention_expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()-interval '1 day',
         clock_timestamp()-interval '32 days')`,
      [tenantId, integrationId, runId, prepared.artifactHash, prepared.purpose,
        prepared.contentType, prepared.rawSizeBytes, prepared.compressedSizeBytes, prepared.compressed],
    );
    return prepared.artifactHash;
  }

  async function insertDeadletter(runId: string, secret: string): Promise<string> {
    const job = await owner.query<{ id: string }>(
      "SELECT id FROM pr_agent_harness.job_queue WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at LIMIT 1",
      [tenantId, runId],
    );
    const deadletter = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.dead_letter_jobs
         (tenant_id,run_id,job_id,final_run_epoch,attempt_count,reason_code,details_json,created_at)
       VALUES ($1,$2,$3,1,1,'test_failure',$4::jsonb,
         clock_timestamp()-interval '401 days') RETURNING id`,
      [tenantId, runId, job.rows[0]!.id, JSON.stringify({ secret })],
    );
    return deadletter.rows[0]!.id;
  }

  async function insertClosedPublicationGraph(runId: string, stepId: string | null) {
    const batchId = randomUUID();
    const operationId = hash(`trace-publication:${runId}`);
    const operationSetHash = hash(`trace-publication-set:${runId}`);
    const runReceiptId = randomUUID();
    const waitId = randomUUID();
    await owner.query(
      `INSERT INTO pr_agent_harness.repository_operations
         (tenant_id,integration_id,business_operation_id,platform,origin,repository,target,revision,
          publication_slot,payload_hash,marker,status,outcome_code,remote_id,attempt_count,version,
          prepared_at,dispatched_at,resolved_at,updated_at)
       VALUES ($1,$2,$3,'github','https://github.example.test','acme/maintenance','pull:trace','head',
         'review-summary',$4,$5,'succeeded','stale','comment:trace',1,1,
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days',
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
      [tenantId, integrationId, operationId, hash(`trace-publication-payload:${runId}`),
        `trace-publication:${runId}`],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.publication_batches
         (id,tenant_id,integration_id,platform,origin,repository,target,revision,
          authority_generation,source_key,source_hash,status,created_at,updated_at)
       VALUES ($1,$2,$3,'github','https://github.example.test','acme/maintenance','pull:trace','head',
         1,$4,$5,'succeeded',clock_timestamp()-interval '401 days',
         clock_timestamp()-interval '401 days')`,
      [batchId, tenantId, integrationId, `trace-publication:${runId}`,
        hash(`trace-publication-source:${runId}`)],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.publication_batch_operations
         (tenant_id,batch_id,ordinal,business_operation_id) VALUES ($1,$2,0,$3)`,
      [tenantId, batchId, operationId],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.run_publication_batches
         (tenant_id,run_id,batch_id,step_id,lease_epoch,operation_set_hash,created_at)
       VALUES ($1,$2,$3,$4,1,$5,clock_timestamp()-interval '401 days')`,
      [tenantId, runId, batchId, stepId, operationSetHash],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.checkpoints
         (tenant_id,run_id,sequence,checkpoint_kind,publication_batch_id,schema_version,
          runtime_version_hash,state_hash,state_json,lease_epoch,created_at)
       VALUES ($1,$2,2,'publication_frozen',$3,1,$4,$5,'{}'::jsonb,1,
         clock_timestamp()-interval '401 days')`,
      [tenantId, runId, batchId, version, hash(`trace-publication-checkpoint:${runId}`)],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.publication_command_receipts
         (tenant_id,business_operation_id,command_key,request_hash,decision,actor_type,actor_id,
          evidence_json,remote_id,previous_status,resulting_status,previous_version,resulting_version,created_at)
       VALUES ($1,$2,$3,$4,'confirm_occurred','service','trace-test','{}'::jsonb,
         'comment:trace','unknown','succeeded',0,1,clock_timestamp()-interval '401 days')`,
      [tenantId, operationId, `trace-publication-command:${runId}`,
        hash(`trace-publication-command:${runId}`)],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.run_command_receipts
         (id,tenant_id,integration_id,run_id,command_kind,command_key,request_hash,actor_type,
          actor_id,request_json,result_json,status,accepted_version,resulting_version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'resume',$5,$6,'service','trace-test','{}'::jsonb,'{}'::jsonb,
         'completed',1,2,clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
      [runReceiptId, tenantId, integrationId, runId, `trace-run-command:${runId}`,
        hash(`trace-run-command:${runId}`)],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.run_waits
         (id,tenant_id,run_id,batch_id,operation_set_hash,business_operation_id,
          operation_version,intent_hash,version,status,allowed_decisions,created_at,consumed_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,2,'consumed',$8::jsonb,
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days')`,
      [waitId, tenantId, runId, batchId, operationSetHash, operationId,
        hash(`trace-wait:${runId}`), JSON.stringify(["confirm_occurred"])],
    );
    await owner.query(
      `INSERT INTO pr_agent_harness.run_wait_decisions
         (tenant_id,run_id,wait_id,command_receipt_id,decision,evidence_json,remote_id,created_at)
       VALUES ($1,$2,$3,$4,'confirm_occurred','{}'::jsonb,'comment:trace',
         clock_timestamp()-interval '401 days')`,
      [tenantId, runId, waitId, runReceiptId],
    );
    const manualJob = await owner.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.job_queue
         (tenant_id,run_id,job_kind,status,expected_run_version,expected_batch_id,
          expected_operation_set_hash,command_receipt_id,wait_id,wait_version,job_payload_json,
          max_attempts,created_at,updated_at,completed_at)
       VALUES ($1,$2,'manual_resume','completed',2,$3,$4,$5,$6,1,$7::jsonb,3,
         clock_timestamp()-interval '401 days',clock_timestamp()-interval '401 days',
         clock_timestamp()-interval '401 days') RETURNING id`,
      [tenantId, runId, batchId, operationSetHash, runReceiptId, waitId,
        JSON.stringify({ decision: "confirm_occurred", commandReceiptId: runReceiptId,
          waitId, waitVersion: 1 })],
    );
    await owner.query(
      `UPDATE pr_agent_harness.run_command_receipts
       SET job_id=$3,result_json=$4::jsonb
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, runReceiptId, manualJob.rows[0]!.id,
        JSON.stringify({ status: "succeeded", jobId: manualJob.rows[0]!.id })],
    );
    return { batchId, operationId, runReceiptId, waitId, manualJobId: manualJob.rows[0]!.id };
  }

  function rolePool(user: string, password: string): Pool {
    return new Pool({ connectionString: roleUrl(user, password), max: 2 });
  }

  function roleUrl(user: string, password: string): string {
    const url = new URL(databaseUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
