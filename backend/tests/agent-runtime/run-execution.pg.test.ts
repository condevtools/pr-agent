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
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName}`);
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
    const checkpoint = await storeA.completeStep(lease, completion(step.id, step.attemptId, "answer"));
    const reusedStep = await storeA.beginStep(lease, {
      stepKey: "review", kind: "model", inputHash: hash("model-input"),
    });
    assert.equal(reusedStep.reused, true);
    assert.equal(
      (await storeA.completeStep(lease, completion(step.id, step.attemptId, "answer"))).id,
      checkpoint.id,
    );
    await assert.rejects(
      storeA.beginStep(lease, { stepKey: "review", kind: "model", inputHash: hash("changed") }),
      RunStepConflictError,
    );
    await assert.rejects(
      storeA.latestCheckpoint(lease, { schemaVersion: 2, runtimeVersionHash: fixture.runtimeHash }),
      RunCheckpointCompatibilityError,
    );
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

  test("a queued Run pinned to another runtime is explicitly dead-lettered", async () => {
    const fixture = await createFixture("runtime-mismatch");
    assert.equal(await storeA.claim(fixture.binding, "wrong-runtime", hash("new-runtime")), undefined);
    const snapshot = await storeA.load(fixture.binding.tenantId, fixture.runId);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.errorCode, "runtime_version_incompatible");
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
    stepId, attemptId, outputHash: hash(`output:${value}`), output: { value },
    checkpoint: { schemaVersion: 1, stateHash: hash(`state:${value}`), state: { next: "done", value } },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
