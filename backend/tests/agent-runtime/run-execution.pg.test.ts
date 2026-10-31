import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import {
  RunCheckpointCompatibilityError,
  RunLeaseLostError,
  RunStepConflictError,
  type ClaimableBinding,
} from "../../src/agent-runtime/runs/contracts.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { withAgentObservability } from "../../src/observability/index.js";
import {
  observationMetadata,
  recordingObservability,
  type ObservationRecord,
} from "../helpers/recording-observability.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Run execution PostgreSQL tests require the dedicated Docker database", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const adminPool = new Pool({ connectionString: databaseUrl, max: 3 });
  const roleName = `run_exec_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  let poolA: Pool;
  let poolB: Pool;
  let runStore: RunStore;
  let storeA: RunExecutionStore;
  let storeB: RunExecutionStore;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(
      `REVOKE UPDATE,DELETE ON pr_agent_harness.checkpoints,
         pr_agent_harness.run_publication_batches,
         pr_agent_harness.dead_letter_jobs FROM ${roleName}`,
    );
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_current_binding_capability(uuid,uuid,text),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    poolA = new Pool({ connectionString: appUrl.toString(), max: 3 });
    poolB = new Pool({ connectionString: appUrl.toString(), max: 3 });
    runStore = new RunStore(new RuntimeDatabase(poolA));
    storeA = new RunExecutionStore(new RuntimeDatabase(poolA), {
      leaseTtlMs: 60_000, initialRetryMs: 10, maxRetryMs: 100,
    });
    storeB = new RunExecutionStore(new RuntimeDatabase(poolB), {
      leaseTtlMs: 60_000, initialRetryMs: 10, maxRetryMs: 100,
    });
  });

  after(async () => {
    await poolB?.end();
    await poolA?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("two non-bypass connections claim one Run and a wrong tenant sees nothing", async () => {
    const fixture = await createFixture("concurrent-claim");
    const [left, right] = await Promise.all([
      storeA.claim(fixture.binding, "worker-a", fixture.runtimeHash),
      storeB.claim(fixture.binding, "worker-b", fixture.runtimeHash),
    ]);
    assert.equal(Number(Boolean(left)) + Number(Boolean(right)), 1);
    const lease = left ?? right!;
    assert.equal(lease.executionModeGeneration, fixture.binding.executionModeGeneration);
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings SET publication_state='draining'
       WHERE tenant_id=$1 AND id=$2`,
      [fixture.binding.tenantId, fixture.binding.integrationId],
    );
    assert.equal((await runStore.createRun(fixture.input)).created, false);
    await assert.rejects(
      runStore.createRun({
        ...fixture.input, createKey: "new-while-draining", requestHash: hash("new-while-draining"),
      }),
      /active asynchronous review execution authority not found/,
    );
    assert.equal(await storeA.load(randomUUID(), fixture.runId), undefined);
    assert.equal(await storeB.claim({ ...fixture.binding, tenantId: randomUUID() }, "intruder", fixture.runtimeHash), undefined);
  });

  test("binding capacity is serialized across worker connections", async () => {
    const first = await createFixture("binding-capacity");
    const second = await runStore.createRun({
      ...first.input,
      createKey: "binding-capacity-2",
      requestHash: hash("binding-capacity-2"),
    });
    const third = await runStore.createRun({
      ...first.input,
      createKey: "binding-capacity-3",
      requestHash: hash("binding-capacity-3"),
    });
    const claims = await Promise.all([
      storeA.claim(first.binding, "capacity-a", first.runtimeHash),
      storeB.claim(first.binding, "capacity-b", first.runtimeHash),
    ]);
    assert.equal(claims.filter(Boolean).length, 2);
    assert.equal(await storeA.claim(first.binding, "capacity-c", first.runtimeHash), undefined);
    assert.equal(new Set(claims.map((lease) => lease!.runId)).size, 2);
    const queued = await adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND integration_id=$2 AND status='queued'`,
      [first.binding.tenantId, first.binding.integrationId],
    );
    assert.equal(queued.rows[0]?.count, 1);
    assert.notEqual(second.id, third.id);
  });

  test("claim excludes P0c jobs and retry delays use the PostgreSQL clock", async () => {
    const excluded = await createFixture("excluded-job-kind");
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET job_kind='manual_resume' WHERE run_id=$1",
      [excluded.runId],
    );
    assert.equal(await storeA.claim(excluded.binding, "wrong-worker", excluded.runtimeHash), undefined);

    const fixture = await createFixture("pg-retry-delay", { maxJobAttempts: 2 });
    const job = await adminPool.query<{ max_attempts: number }>(
      "SELECT max_attempts FROM pr_agent_harness.job_queue WHERE run_id=$1",
      [fixture.runId],
    );
    assert.equal(job.rows[0]?.max_attempts, 2);
    const lease = (await storeA.claim(fixture.binding, "retry-worker", fixture.runtimeHash))!;
    await storeA.transition(lease, {
      to: "retry_wait", reasonCode: "provider_busy", retryDelayMs: 1_000,
    });
    const timing = await adminPool.query<{ delay_ms: number }>(
      `SELECT (extract(epoch FROM (available_at-now()))*1000)::int AS delay_ms
       FROM pr_agent_harness.job_queue WHERE run_id=$1`,
      [fixture.runId],
    );
    assert.ok(timing.rows[0]!.delay_ms >= 900 && timing.rows[0]!.delay_ms <= 1_000);
  });

  test("source build hash is persisted as explicit audit metadata and never as compatibility", async () => {
    const unavailable = await createFixture("audit-unavailable");
    const unavailableConfig = await adminPool.query<{ audit: Record<string, unknown> }>(
      "SELECT runtime_config_json->'audit' AS audit FROM pr_agent_harness.agent_runs WHERE id=$1",
      [unavailable.runId],
    );
    assert.deepEqual(unavailableConfig.rows[0]?.audit,
      { sourceHash: null, sourceHashAvailability: "unavailable" });

    const sourceAuditHash = hash("full-server-build");
    const created = await runStore.createRun({ ...unavailable.input,
      createKey: "audit-available", requestHash: hash("audit-available"), sourceAuditHash });
    const availableConfig = await adminPool.query<{ audit: Record<string, unknown> }>(
      "SELECT runtime_config_json->'audit' AS audit FROM pr_agent_harness.agent_runs WHERE id=$1",
      [created.id],
    );
    assert.deepEqual(availableConfig.rows[0]?.audit,
      { sourceHash: sourceAuditHash, sourceHashAvailability: "available" });
    assert.equal((await storeA.claim(unavailable.binding, "audit-worker", unavailable.runtimeHash))?.runId,
      unavailable.runId);
  });

  test("expired leases fence late writes and a replacement reuses the logical step", async () => {
    const fixture = await createFixture("lease-fencing");
    const first = (await storeA.claim(fixture.binding, "old-worker", fixture.runtimeHash))!;
    const started = await storeA.beginStep(first, {
      stepKey: "collect-repository", kind: "tool", inputHash: hash("tool-input"),
      tool: { kind: "repository_read", name: "collect", requestHash: hash("tool-request") },
    });
    await expireLease(first.runId);
    assert.deepEqual(await storeB.sweep(fixture.binding), { retried: 1, deadLettered: 0, cancelled: 0 });
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET available_at=now()-interval '1 second' WHERE run_id=$1",
      [first.runId],
    );
    const second = (await storeB.claim(fixture.binding, "new-worker", fixture.runtimeHash))!;
    assert.ok(second.epoch > first.epoch);
    await assert.rejects(
      storeA.completeStep(first, completion(started.id, started.attemptId, "late")),
      RunLeaseLostError,
    );
    const replacement = await storeB.beginStep(second, {
      stepKey: "collect-repository", kind: "tool", inputHash: hash("tool-input"),
      tool: { kind: "repository_read", name: "collect", requestHash: hash("tool-request") },
    });
    assert.equal(replacement.id, started.id);
    assert.equal(replacement.attemptNumber, 2);
    const oldTool = await adminPool.query<{ status: string }>(
      "SELECT status FROM pr_agent_harness.tool_calls WHERE step_attempt_id=$1",
      [started.attemptId],
    );
    assert.equal(oldTool.rows[0]?.status, "unknown");
  });

  test("completed step and checkpoint are reused while changed hashes or schemas fail closed", async () => {
    const fixture = await createFixture("checkpoint-reuse");
    const lease = (await storeA.claim(fixture.binding, "checkpoint-worker", fixture.runtimeHash))!;
    const step = await storeA.beginStep(lease, {
      stepKey: "review", kind: "model", inputHash: hash("model-input"),
    });
    const records: ObservationRecord[] = [];
    const observability = recordingObservability(records);
    assert.equal(await withAgentObservability(observability, () => storeA.latestCheckpoint(lease, {
      schemaVersion: 1, runtimeVersionHash: fixture.runtimeHash,
    })), undefined);
    const missing = records.find((record) => record.name === "validate-checkpoint"
      && observationMetadata(record).checkpointOutcome === "missing");
    assert.ok(missing);
    assert.equal(observationMetadata(missing!).runId, lease.runId);
    const checkpoint = await withAgentObservability(observability, () =>
      storeA.completeStep(lease, completion(step.id, step.attemptId, "answer")));
    const saved = records.find(({ name }) => name === "save-checkpoint")!;
    assert.ok(saved);
    const savedMetadata = observationMetadata(saved);
    assert.equal(savedMetadata.checkpointAction, "save");
    assert.equal(savedMetadata.checkpointOutcome, "saved");
    assert.equal(savedMetadata.checkpointKind, "step_completed");
    assert.equal(savedMetadata.checkpointId, checkpoint.id);
    assert.equal(savedMetadata.checkpointSequence, checkpoint.sequence);
    assert.equal(savedMetadata.checkpointSchemaVersion, checkpoint.schemaVersion);
    assert.equal(savedMetadata.checkpointRuntimeVersionHash, checkpoint.runtimeVersionHash);
    assert.equal(savedMetadata.checkpointStateHash, checkpoint.stateHash);
    assert.equal(savedMetadata.checkpointCreatedAt, checkpoint.createdAt);
    assert.equal(savedMetadata.tenantId, lease.tenantId);
    assert.equal(savedMetadata.integrationId, lease.integrationId);
    assert.equal(savedMetadata.runId, lease.runId);
    assert.equal(savedMetadata.stepId, step.id);
    assert.equal(savedMetadata.stepAttemptId, step.attemptId);
    assert.equal(savedMetadata.outputHash, fingerprint({ value: "answer" }));
    assert.equal(saved.attributes.input, undefined);
    assert.equal(saved.updates.at(-1)?.output, undefined);
    assert.equal(JSON.stringify(saved).includes('"value":"answer"'), false);

    const reusedStep = await withAgentObservability(observability, () => storeA.beginStep(lease, {
      stepKey: "review", kind: "model", inputHash: hash("model-input"),
    }));
    assert.equal(reusedStep.reused, true);
    assert.deepEqual(await withAgentObservability(observability, () =>
      storeA.loadStepOutput(lease, reusedStep)), "answer");
    const reused = records.find(({ name }) => name === "reuse-checkpoint")!;
    assert.ok(reused);
    const reusedMetadata = observationMetadata(reused);
    assert.equal(reusedMetadata.checkpointAction, "reuse");
    assert.equal(reusedMetadata.checkpointOutcome, "reused");
    assert.equal(reusedMetadata.checkpointKind, "step_completed");
    assert.equal(reusedMetadata.checkpointId, checkpoint.id);
    assert.equal(reusedMetadata.checkpointSequence, checkpoint.sequence);
    assert.equal(reusedMetadata.checkpointSchemaVersion, checkpoint.schemaVersion);
    assert.equal(reusedMetadata.checkpointRuntimeVersionHash, checkpoint.runtimeVersionHash);
    assert.equal(reusedMetadata.checkpointStateHash, checkpoint.stateHash);
    assert.equal(reusedMetadata.checkpointCreatedAt, checkpoint.createdAt);
    assert.equal(reusedMetadata.tenantId, lease.tenantId);
    assert.equal(reusedMetadata.integrationId, lease.integrationId);
    assert.equal(reusedMetadata.runId, lease.runId);
    assert.equal(reusedMetadata.stepId, step.id);
    assert.equal(reusedMetadata.stepAttemptId, step.attemptId);
    assert.equal(reusedMetadata.outputHash, fingerprint({ value: "answer" }));
    assert.equal(
      (await storeA.completeStep(lease, completion(step.id, step.attemptId, "answer"))).id,
      checkpoint.id,
    );
    const validatedCheckpoint = await withAgentObservability(observability, () => storeA.latestCheckpoint(lease, {
      schemaVersion: 1, runtimeVersionHash: fixture.runtimeHash,
    }));
    assert.equal(validatedCheckpoint?.id, checkpoint.id);
    const validated = records.find((record) => record.name === "validate-checkpoint"
      && observationMetadata(record).checkpointOutcome === "validated");
    assert.ok(validated);
    assert.equal(observationMetadata(validated!).checkpointId, checkpoint.id);
    assert.equal(observationMetadata(validated!).checkpointStateHash, checkpoint.stateHash);
    await assert.rejects(
      storeA.beginStep(lease, { stepKey: "review", kind: "model", inputHash: hash("changed") }),
      RunStepConflictError,
    );
    await assert.rejects(
      withAgentObservability(observability, () => storeA.latestCheckpoint(lease, {
        schemaVersion: 2, runtimeVersionHash: fixture.runtimeHash,
      })),
      RunCheckpointCompatibilityError,
    );
    const rejected = records.find((record) => record.name === "validate-checkpoint"
      && observationMetadata(record).checkpointOutcome === "rejected");
    assert.ok(rejected);
    assert.equal(observationMetadata(rejected!).checkpointId, checkpoint.id);
    assert.equal(observationMetadata(rejected!).checkpointSchemaVersion, checkpoint.schemaVersion);
    await observability.shutdown();
  });

  test("checkpoint telemetry reports a failed commit without claiming that it was saved", async () => {
    const fixture = await createFixture("checkpoint-commit-failure");
    const lease = (await storeA.claim(fixture.binding, "checkpoint-commit-worker", fixture.runtimeHash))!;
    const step = await storeA.beginStep(lease, {
      stepKey: "review", kind: "model", inputHash: hash("commit-failure-input"),
    });
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION pr_agent_harness.reject_checkpoint_commit_fixture()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic deferred checkpoint commit failure';
      END
      $$
    `);
    await adminPool.query(`
      CREATE CONSTRAINT TRIGGER reject_checkpoint_commit_fixture
      AFTER INSERT ON pr_agent_harness.checkpoints
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.reject_checkpoint_commit_fixture()
    `);
    const records: ObservationRecord[] = [];
    const observability = recordingObservability(records, { captureContent: "redacted" });
    try {
      await assert.rejects(
        withAgentObservability(observability, () =>
          storeA.completeStep(lease, completion(step.id, step.attemptId, "must-rollback"))),
        /synthetic deferred checkpoint commit failure/,
      );
    } finally {
      await adminPool.query("DROP TRIGGER reject_checkpoint_commit_fixture ON pr_agent_harness.checkpoints");
      await adminPool.query("DROP FUNCTION pr_agent_harness.reject_checkpoint_commit_fixture()");
      await observability.shutdown();
    }
    assert.equal(records.some((record) => observationMetadata(record).checkpointOutcome === "saved"), false);
    const failed = records.find((record) => record.name === "save-checkpoint");
    assert.ok(failed);
    assert.equal(observationMetadata(failed!).checkpointOutcome, "failed");
    assert.equal(JSON.stringify(failed).includes("must-rollback"), false);
    const rows = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2",
      [lease.tenantId, lease.runId],
    );
    assert.equal(rows.rows[0]?.count, 0);
  });

  test("saved checkpoint telemetry is emitted only after the row is visible to another connection", async () => {
    const fixture = await createFixture("checkpoint-commit-visible");
    const lease = (await storeA.claim(fixture.binding, "checkpoint-visible-worker", fixture.runtimeHash))!;
    const step = await storeA.beginStep(lease, {
      stepKey: "review", kind: "model", inputHash: hash("commit-visible-input"),
    });
    const probe = await adminPool.connect();
    const visibilityChecks: Array<Promise<boolean>> = [];
    const records: ObservationRecord[] = [];
    const observability = recordingObservability(records, {
      onUpdate(record) {
        const metadata = observationMetadata(record);
        if (metadata.checkpointOutcome !== "saved" || metadata.runId !== lease.runId) return;
        visibilityChecks.push(probe.query(
          "SELECT EXISTS(SELECT 1 FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2 AND id=$3) AS visible",
          [lease.tenantId, lease.runId, metadata.checkpointId],
        ).then(({ rows }) => rows[0]?.visible === true));
      },
    });
    try {
      await probe.query("SET statement_timeout='250ms'");
      await withAgentObservability(observability, () =>
        storeA.completeStep(lease, completion(step.id, step.attemptId, "committed")));
      assert.equal(visibilityChecks.length, 1);
      assert.deepEqual(await Promise.all(visibilityChecks), [true]);
    } finally {
      await observability.shutdown();
      await probe.query("RESET statement_timeout");
      probe.release();
    }
  });

  test("telemetry driver failures never roll back a committed checkpoint", async () => {
    for (const mode of ["start", "update"] as const) {
      const fixture = await createFixture(`checkpoint-telemetry-${mode}`);
      const lease = (await storeA.claim(fixture.binding, `checkpoint-${mode}-worker`, fixture.runtimeHash))!;
      const step = await storeA.beginStep(lease, {
        stepKey: "review", kind: "model", inputHash: hash(`telemetry-${mode}-input`),
      });
      const records: ObservationRecord[] = [];
      const observability = recordingObservability(records, {
        throwOnStart: mode === "start", throwOnUpdate: mode === "update",
      });
      const checkpoint = await withAgentObservability(observability, () =>
        storeA.completeStep(lease, completion(step.id, step.attemptId, `telemetry-${mode}`)));
      await observability.shutdown();
      const persisted = await adminPool.query<{ id: string; state_hash: string }>(
        "SELECT id,state_hash FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2",
        [lease.tenantId, lease.runId],
      );
      assert.deepEqual(persisted.rows, [{ id: checkpoint.id, state_hash: checkpoint.stateHash }]);
    }
  });

  test("the persisted maxStepAttempts limit fences a new physical attempt", async () => {
    const fixture = await createFixture("step-attempt-limit", { maxStepAttempts: 1 });
    const first = (await storeA.claim(fixture.binding, "step-worker-1", fixture.runtimeHash))!;
    await storeA.beginStep(first, {
      stepKey: "bounded-step", kind: "model", inputHash: hash("bounded-input"),
    });
    await storeA.transition(first, {
      to: "retry_wait", reasonCode: "model_transient", retryDelayMs: 1,
    });
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET available_at=now()-interval '1 second' WHERE run_id=$1",
      [fixture.runId],
    );
    const second = (await storeB.claim(fixture.binding, "step-worker-2", fixture.runtimeHash))!;
    await assert.rejects(
      storeB.beginStep(second, {
        stepKey: "bounded-step", kind: "model", inputHash: hash("bounded-input"),
      }),
      /attempt limit exhausted/,
    );
  });

  test("caught role failures settle physical attempts and allow a bounded new attempt", async () => {
    const fixture = await createFixture("role-failure");
    const lease = (await storeA.claim(fixture.binding, "role-worker", fixture.runtimeHash))!;
    const step = await storeA.beginStep(lease, { stepKey: "deep.role.security.tool.read_file_range.1", kind: "tool",
      inputHash: hash("tool-input"), tool: { name: "read_file_range", kind: "repository_read", requestHash: hash("request") } });
    await storeA.failStep(lease, { stepId: step.id, attemptId: step.attemptId, errorCode: "ToolTimeout" });
    const settled = await adminPool.query(`SELECT s.status AS step,a.status AS attempt,t.status AS tool
      FROM pr_agent_harness.agent_steps s JOIN pr_agent_harness.step_attempts a ON a.step_id=s.id
      JOIN pr_agent_harness.tool_calls t ON t.step_attempt_id=a.id WHERE s.id=$1`, [step.id]);
    assert.deepEqual(settled.rows[0], { step: "failed", attempt: "failed", tool: "failed_definite" });
    const retry = await storeA.beginStep(lease, { stepKey: step.stepKey, kind: "tool", inputHash: hash("tool-input"),
      tool: { name: "read_file_range", kind: "repository_read", requestHash: hash("request") } });
    assert.equal(retry.id, step.id); assert.equal(retry.attemptNumber, 2);
    await assert.rejects(storeA.failStep({ ...lease, epoch: lease.epoch + 1 },
      { stepId: retry.id, attemptId: retry.attemptId, errorCode: "late" }), RunLeaseLostError);
  });

  test("deadline and attempt bounds dead-letter without reviving terminal Runs", async () => {
    const fixture = await createFixture("attempt-dlq");
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET max_attempts=1 WHERE tenant_id=$1 AND run_id=$2",
      [fixture.binding.tenantId, fixture.runId],
    );
    const lease = (await storeA.claim(fixture.binding, "deadline-worker", fixture.runtimeHash))!;
    await expireLease(lease.runId);
    assert.deepEqual(await storeB.sweep(fixture.binding), { retried: 0, deadLettered: 1, cancelled: 0 });
    assert.equal((await storeA.load(fixture.binding.tenantId, fixture.runId))?.status, "failed");
    assert.equal(await storeA.claim(fixture.binding, "reviver", fixture.runtimeHash), undefined);
    const dead = await adminPool.query<{ reason_code: string }>(
      "SELECT reason_code FROM pr_agent_harness.dead_letter_jobs WHERE run_id=$1",
      [fixture.runId],
    );
    assert.equal(dead.rows[0]?.reason_code, "run_attempts_exhausted");

    const deadline = await createFixture("deadline-dlq", { maxRunMs: 250 });
    assert.ok(await storeA.claim(deadline.binding, "deadline-worker", deadline.runtimeHash));
    await adminPool.query("SELECT pg_sleep(0.3)");
    assert.deepEqual(await storeB.sweep(deadline.binding), {
      retried: 0, deadLettered: 1, cancelled: 0,
    });
    const deadlineDead = await adminPool.query<{ reason_code: string }>(
      "SELECT reason_code FROM pr_agent_harness.dead_letter_jobs WHERE run_id=$1",
      [deadline.runId],
    );
    assert.equal(deadlineDead.rows[0]?.reason_code, "run_deadline_exceeded");
  });

  test("queued and retry-wait deadlines terminate even when no worker claims them", async () => {
    for (const status of ["queued", "retry_wait"] as const) {
      const fixture = await createFixture(`unclaimed-expired-${status}`, { maxRunMs: 300 });
      if (status === "retry_wait") {
        const lease = (await storeA.claim(fixture.binding, "retry-before-deadline", fixture.runtimeHash))!;
        await storeA.transition(lease, { to: "retry_wait", retryDelayMs: 60_000 });
      }
      await adminPool.query("SELECT pg_sleep(0.35)");
      assert.equal(await storeA.claim(fixture.binding, "too-late", fixture.runtimeHash), undefined);
      assert.deepEqual(await storeB.sweep(fixture.binding), { retried: 0, deadLettered: 1, cancelled: 0 });
      assert.equal((await storeA.load(fixture.binding.tenantId, fixture.runId))?.errorCode, "run_deadline_exceeded");
      assert.equal((await adminPool.query("SELECT 1 FROM pr_agent_harness.dead_letter_jobs WHERE run_id=$1", [fixture.runId])).rowCount, 1);
    }
    const cancelled = await createFixture("unclaimed-cancelled");
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET cancel_requested_at=now() WHERE id=$1", [cancelled.runId]);
    assert.deepEqual(await storeB.sweep(cancelled.binding), { retried: 0, deadLettered: 0, cancelled: 1 });
    assert.equal((await storeA.load(cancelled.binding.tenantId, cancelled.runId))?.status, "cancelled");
  });

  test("an incompatible worker leaves the queued Run and job byte-for-byte claimable", async () => {
    const fixture = await createFixture("runtime-mismatch");
    const before = (await adminPool.query(
      `SELECT r.status,r.version,r.execution_attempt_count,r.error_code,
              j.status AS job_status,j.attempt_count,j.claimed_run_epoch,j.last_error_code
       FROM pr_agent_harness.agent_runs r
       JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
       WHERE r.id=$1`, [fixture.runId])).rows[0];
    assert.equal(await storeA.claim(fixture.binding, "wrong-runtime", hash("new-runtime")), undefined);
    const backlog = await storeA.compatibilityBacklog(fixture.binding, hash("new-runtime"));
    assert.equal(backlog.queuedRuns, 1);
    assert.deepEqual(backlog.runtimeVersionHashes, [fixture.runtimeHash]);
    assert.ok(backlog.oldestQueuedAt);
    const after = (await adminPool.query(
      `SELECT r.status,r.version,r.execution_attempt_count,r.error_code,
              j.status AS job_status,j.attempt_count,j.claimed_run_epoch,j.last_error_code
       FROM pr_agent_harness.agent_runs r
       JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
       WHERE r.id=$1`, [fixture.runId])).rows[0];
    assert.deepEqual(after, before);
    assert.ok(await storeB.claim(fixture.binding, "compatible-runtime", fixture.runtimeHash));
  });

  test("a checkpointed Run waits for its compatible worker without clearing saved results", async () => {
    const fixture = await createFixture("checkpoint-runtime-wait");
    const first = (await storeA.claim(fixture.binding, "old-runtime", fixture.runtimeHash))!;
    const step = await storeA.beginStep(first, {
      stepKey: "review", kind: "model", inputHash: hash("frozen-input"),
    });
    await storeA.completeStep(first, completion(step.id, step.attemptId, "saved-result"));
    await storeA.transition(first, { to: "retry_wait", retryDelayMs: 1, reasonCode: "rollout" });
    await adminPool.query("SELECT pg_sleep(0.01)");
    assert.equal(await storeB.claim(fixture.binding, "new-runtime", hash("incompatible-runtime")), undefined);
    const compatible = (await storeA.claim(fixture.binding, "old-runtime-replacement", fixture.runtimeHash))!;
    const reused = await storeA.beginStep(compatible, {
      stepKey: "review", kind: "model", inputHash: hash("frozen-input"),
    });
    assert.equal(reused.reused, true);
    assert.deepEqual(reused.output, { value: "saved-result" });
  });

  test("three graceful rolling stops return the lease without spending attempt budget", async () => {
    const fixture = await createFixture("graceful-rollout", { maxJobAttempts: 2 });
    for (let rollout = 0; rollout < 3; rollout += 1) {
      const lease = (await storeA.claim(fixture.binding, `worker-${rollout}`, fixture.runtimeHash))!;
      await storeA.beginStep(lease, {
        stepKey: "long-running-step", kind: "model", inputHash: hash("stable-step-input"),
      });
      await storeA.relinquishSettledLease(lease);
      const state = (await adminPool.query<{
        status: string; execution_attempt_count: number; job_status: string; attempt_count: number;
      }>(`SELECT r.status,r.execution_attempt_count,j.status AS job_status,j.attempt_count
           FROM pr_agent_harness.agent_runs r
           JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
           WHERE r.id=$1`, [fixture.runId])).rows[0]!;
      assert.deepEqual(state, { status: "queued", execution_attempt_count: 0,
        job_status: "ready", attempt_count: 0 });
    }
    const finalLease = await storeB.claim(fixture.binding, "post-rollout-worker", fixture.runtimeHash);
    assert.equal(finalLease?.jobAttempt, 1);
    const resumed = await storeB.beginStep(finalLease!, {
      stepKey: "long-running-step", kind: "model", inputHash: hash("stable-step-input"),
    });
    assert.equal(resumed.attemptNumber, 4);
  });

  async function createFixture(
    key: string,
    overrides: { maxRunMs?: number; maxJobAttempts?: number; maxStepAttempts?: number } = {},
  ): Promise<{
    binding: ClaimableBinding;
    runId: string;
    runtimeHash: string;
    input: Parameters<RunStore["createRun"]>[0];
  }> {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    const runtimeHash = hash(`runtime:${key}`);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,publication_state,publication_generation,
          provider_repository_id,provider_actor_id,credential_ref,quiescence_receipt,
          review_execution_mode,execution_mode_generation)
       VALUES ($1,$2,'github',$3,$4,'active',1,'1001','2001','test-credential',$5::jsonb,
               'harness_async',1)`,
      [integrationId, tenantId, `https://${key}.example.test`, `acme/${key}`,
        JSON.stringify({ verifiedBy: "test", at: new Date().toISOString() })],
    );
    const input: Parameters<RunStore["createRun"]>[0] = {
      tenantId, integrationId, actorType: "service", actorId: "test-intake",
      createScope: "test:run:v1", createKey: key, requestHash: hash(`request:${key}`),
      runType: "review", baseSha: "base", headSha: "head",
      workflowVersionHash: hash("workflow"), promptVersionHash: hash("prompt"),
      modelVersionHash: hash("model"), toolVersionHash: hash("tool"),
      policyVersionHash: hash("policy"), runtimeVersionHash: runtimeHash,
      input: { key }, authorityGeneration: 1, executionModeGeneration: 1,
      runtimeConfig: {
        maxRunMs: overrides.maxRunMs ?? 15 * 60_000,
        maxJobAttempts: overrides.maxJobAttempts ?? 3,
      },
      limits: { maxStepAttempts: overrides.maxStepAttempts ?? 3 },
    };
    const created = await runStore.createRun(input);
    return {
      binding: { tenantId, integrationId, authorityGeneration: 1, executionModeGeneration: 1 },
      runId: created.id,
      runtimeHash,
      input,
    };
  }

  async function expireLease(runId: string): Promise<void> {
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [runId],
    );
  }
}

function completion(stepId: string, attemptId: string, value: string) {
  return {
    stepId, attemptId, outputHash: fingerprint({ value }), output: { value },
    checkpoint: { schemaVersion: 1, stateHash: hash(`state:${value}`), state: { next: "done", value } },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
