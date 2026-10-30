import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore, type CreateRunInput } from "../../src/agent-runtime/postgres/run-store.js";
import type { RunCommand, RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { RunControlStore } from "../../src/agent-runtime/runs/control-store.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Run command PostgreSQL tests require the dedicated Docker database", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }
  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const roleName = `run_command_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  let pool: Pool;
  let runStore: RunStore;
  let commandStore: RunControlStore;
  let executionStore: RunExecutionStore;
  let batchStore: PublicationBatchStore;
  let nextProviderId = 90_000;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.agent_runs,
      pr_agent_harness.job_queue,pr_agent_harness.repository_operations,
      pr_agent_harness.publication_slots,pr_agent_harness.publication_batches,
      pr_agent_harness.agent_steps,pr_agent_harness.step_attempts,pr_agent_harness.tool_calls TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,INSERT ON pr_agent_harness.publication_batch_operations,
      pr_agent_harness.run_publication_batches,pr_agent_harness.checkpoints,
      pr_agent_harness.run_events,pr_agent_harness.audit_logs TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.run_command_receipts,
      pr_agent_harness.run_waits TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,INSERT ON pr_agent_harness.run_wait_decisions TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION
      pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint),
      pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_current_binding_capability(uuid,uuid,text),
      pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = password;
    pool = new Pool({ connectionString: appUrl.toString(), max: 8 });
    const db = new RuntimeDatabase(pool);
    runStore = new RunStore(db);
    commandStore = new RunControlStore(db);
    executionStore = new RunExecutionStore(db);
    batchStore = new PublicationBatchStore(db);
  });

  after(async () => {
    await pool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("receipt replay reauthorizes, excludes actor from its hash, and CAS serializes commands", async () => {
    const fixture = await createFixture("receipt");
    const version = await runVersion(fixture.run.id);
    const command = { kind: "cancel" as const, expectedVersion: version, commandKey: "cancel-once" };
    const receipt = await commandStore.apply(fixture.principal, fixture.run.id, command);
    assert.equal(receipt.status, "completed");
    const replay = await commandStore.apply(
      { ...fixture.principal, subjectId: "another-authorized-actor" },
      fixture.run.id,
      command,
    );
    assert.equal(replay.id, receipt.id);
    await assert.rejects(
      commandStore.apply(fixture.principal, fixture.run.id, {
        ...command, expectedVersion: version + 1,
      }),
      /different request/,
    );
    await assert.rejects(
      commandStore.apply({ ...fixture.principal, tenantId: randomUUID() }, fixture.run.id, command),
      { code: "RUN_NOT_FOUND" },
    );

    const concurrent = await createFixture("command-cas");
    const concurrentVersion = await runVersion(concurrent.run.id);
    const results = await Promise.allSettled([
      commandStore.apply(concurrent.principal, concurrent.run.id, {
        kind: "cancel", expectedVersion: concurrentVersion, commandKey: "left",
      }),
      commandStore.apply(concurrent.principal, concurrent.run.id, {
        kind: "cancel", expectedVersion: concurrentVersion, commandKey: "right",
      }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  });

  test("cancelling one Run skips only its prepared memberships and preserves a shared operation", async () => {
    const fixture = await createFixture("shared-cancel");
    const second = await createRun(fixture, "shared-cancel-second");
    const firstLease = await claim(fixture, fixture.run.id, "first-worker");
    const secondLease = await claim(fixture, second.id, "second-worker");
    const operation = { slot: "summary", payload: { body: "same" } };
    const firstBatch = await batchStore.freeze({
      runLease: firstLease, scope: fixture.scope, sourceKey: "source:first",
      sourceHash: hash("source:first"), operations: [operation],
    });
    const secondBatch = await batchStore.freeze({
      runLease: secondLease, scope: fixture.scope, sourceKey: "source:second",
      sourceHash: hash("source:second"), operations: [operation],
    });
    const operationId = firstBatch.operations[0]!.businessOperationId;
    assert.equal(secondBatch.operations[0]!.businessOperationId, operationId);

    await commandStore.apply(fixture.principal, fixture.run.id, {
      kind: "cancel", expectedVersion: await runVersion(fixture.run.id), commandKey: "cancel-first",
    });
    assert.deepEqual(await membership(firstBatch.id), {
      action_state: "skipped", skip_reason: "run_cancelled_before_dispatch",
    });
    assert.deepEqual(await membership(secondBatch.id), { action_state: "active", skip_reason: null });
    assert.equal((await operationRow(operationId)).status, "prepared");

    await commandStore.apply(fixture.principal, second.id, {
      kind: "cancel", expectedVersion: await runVersion(second.id), commandKey: "cancel-second",
    });
    assert.equal((await operationRow(operationId)).status, "cancelled");
    // Cancellation requests keep their capacity until the worker/sweeper settles the leases.
    const swept = await executionStore.sweep({ tenantId: fixture.scope.tenantId,
      integrationId: fixture.scope.integrationId, authorityGeneration: 1, executionModeGeneration: 1 });
    assert.equal(swept.cancelled, 2);
    const third = await createRun(fixture, "shared-cancel-third");
    const thirdLease = await claim(fixture, third.id, "third-worker");
    await batchStore.freeze({
      runLease: thirdLease, scope: fixture.scope, sourceKey: "source:third",
      sourceHash: hash("source:third"), operations: [operation],
    });
    assert.equal((await operationRow(operationId)).status, "prepared");
  });

  test("retry preserves the Job while recover rejects live leases and repairs an expired lease", async () => {
    const retry = await createFixture("retry-command");
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET status='retry_wait' WHERE id=$1",
      [retry.run.id],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET status='retry_wait' WHERE run_id=$1",
      [retry.run.id],
    );
    const before = await jobRow(retry.run.id);
    const receipt = await commandStore.apply(retry.principal, retry.run.id, {
      kind: "retry", expectedVersion: await runVersion(retry.run.id), commandKey: "retry-now",
    });
    const after = await jobRow(retry.run.id);
    assert.equal(after.id, before.id);
    assert.equal(after.dispatch_generation, before.dispatch_generation + 1);
    assert.equal(receipt.result.jobId, before.id);

    const expiredRetry = await createFixture("retry-expired");
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='retry_wait',deadline_at=created_at+interval '1 millisecond' WHERE id=$1`,
      [expiredRetry.run.id],
    );
    await adminPool.query("SELECT pg_sleep(0.01)");
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET status='retry_wait' WHERE run_id=$1",
      [expiredRetry.run.id],
    );
    const expiredRetryJob = await jobRow(expiredRetry.run.id);
    await assert.rejects(
      commandStore.apply(expiredRetry.principal, expiredRetry.run.id, {
        kind: "retry", expectedVersion: await runVersion(expiredRetry.run.id), commandKey: "expired-retry",
      }),
      /Expired Run deadline/,
    );
    assert.equal(await receiptCount(expiredRetry.run.id, "expired-retry"), 0);
    assert.deepEqual(await jobRow(expiredRetry.run.id), expiredRetryJob);

    const recover = await createFixture("recover-command");
    const lease = await claim(recover, recover.run.id, "recover-worker");
    await assert.rejects(
      commandStore.apply(recover.principal, recover.run.id, {
        kind: "recover", expectedVersion: await runVersion(recover.run.id), commandKey: "live",
      }),
      /live Run lease/,
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [recover.run.id],
    );
    const recovered = await commandStore.apply(recover.principal, recover.run.id, {
      kind: "recover", expectedVersion: await runVersion(recover.run.id), commandKey: "expired",
    });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.result.jobId, lease.jobId);
    assert.equal((await jobRow(recover.run.id)).status, "ready");

    const orphan = await createFixture("recover-orphan", 2);
    const orphanJob = await jobRow(orphan.run.id);
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET status='completed',completed_at=clock_timestamp() WHERE id=$1",
      [orphanJob.id],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET execution_attempt_count=1 WHERE id=$1",
      [orphan.run.id],
    );
    const orphanReceipt = await commandStore.apply(orphan.principal, orphan.run.id, {
      kind: "recover", expectedVersion: await runVersion(orphan.run.id), commandKey: "orphan",
    });
    assert.notEqual(orphanReceipt.result.jobId, orphanJob.id);
    assert.deepEqual(
      { attempt_count: (await jobRow(orphan.run.id)).attempt_count,
        max_attempts: (await jobRow(orphan.run.id)).max_attempts },
      { attempt_count: 1, max_attempts: 2 },
    );

    const exhaustedOrphan = await createFixture("recover-exhausted-orphan", 2);
    await adminPool.query(
      `UPDATE pr_agent_harness.job_queue
       SET status='completed',attempt_count=2,completed_at=clock_timestamp() WHERE run_id=$1`,
      [exhaustedOrphan.run.id],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET execution_attempt_count=2 WHERE id=$1",
      [exhaustedOrphan.run.id],
    );
    await assert.rejects(
      commandStore.apply(exhaustedOrphan.principal, exhaustedOrphan.run.id, {
        kind: "recover", expectedVersion: await runVersion(exhaustedOrphan.run.id),
        commandKey: "recover-exhausted-orphan",
      }),
      /attempt limit is exhausted/,
    );
    assert.equal(await receiptCount(exhaustedOrphan.run.id, "recover-exhausted-orphan"), 0);
    assert.equal(await readyJobCount(exhaustedOrphan.run.id), 0);

    const exhaustedActive = await createFixture("recover-exhausted-active", 2);
    await claim(exhaustedActive, exhaustedActive.run.id, "exhausted-worker");
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET execution_attempt_count=2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [exhaustedActive.run.id],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET attempt_count=2 WHERE run_id=$1 AND status='running'",
      [exhaustedActive.run.id],
    );
    await assert.rejects(
      commandStore.apply(exhaustedActive.principal, exhaustedActive.run.id, {
        kind: "recover", expectedVersion: await runVersion(exhaustedActive.run.id),
        commandKey: "recover-exhausted-active",
      }),
      /attempt limit is exhausted/,
    );
    assert.equal(await receiptCount(exhaustedActive.run.id, "recover-exhausted-active"), 0);
    assert.equal((await jobRow(exhaustedActive.run.id)).status, "running");

    const dead = await createFixture("recover-dead-letter");
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET status='dead_letter',completed_at=clock_timestamp() WHERE run_id=$1",
      [dead.run.id],
    );
    await assert.rejects(
      commandStore.apply(dead.principal, dead.run.id, {
        kind: "recover", expectedVersion: await runVersion(dead.run.id), commandKey: "dead-letter",
      }),
      /Dead-lettered Runs/,
    );
  });

  test("commands require the frozen execution authority before creating durable effects", async () => {
    const blockedRetry = await createFixture("authority-blocked-retry");
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET status='retry_wait' WHERE id=$1",
      [blockedRetry.run.id],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET status='retry_wait' WHERE run_id=$1",
      [blockedRetry.run.id],
    );
    const blockedJob = await jobRow(blockedRetry.run.id);
    await adminPool.query(
      "UPDATE pr_agent_harness.integration_bindings SET publication_state='draining' WHERE id=$1",
      [blockedRetry.scope.integrationId],
    );
    await assert.rejects(
      commandStore.apply(blockedRetry.principal, blockedRetry.run.id, {
        kind: "retry", expectedVersion: await runVersion(blockedRetry.run.id),
        commandKey: "blocked-retry",
      }),
      /execution authority/,
    );
    assert.equal(await receiptCount(blockedRetry.run.id, "blocked-retry"), 0);
    assert.deepEqual(await jobRow(blockedRetry.run.id), blockedJob);

    const generationResume = await createWaitingFixture("authority-generation-resume");
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET execution_mode_generation=execution_mode_generation+1 WHERE id=$1`,
      [generationResume.fixture.scope.integrationId],
    );
    await assert.rejects(
      commandStore.apply(generationResume.fixture.principal, generationResume.fixture.run.id, {
        kind: "resume",
        expectedVersion: await runVersion(generationResume.fixture.run.id),
        commandKey: "generation-resume",
        decision: {
          waitId: generationResume.waitId,
          waitVersion: 1,
          intentHash: generationResume.intentHash,
          operationVersion: generationResume.operation.version,
          decision: "confirm_occurred",
          evidence: {
            kind: "provider_confirmation",
            reference: "provider:generation",
            actualRevision: "head-sha",
          },
          remoteId: "remote-generation",
        },
      }),
      /execution authority/,
    );
    await assertResumeWasNotApplied(
      generationResume.fixture,
      generationResume.waitId,
      "generation-resume",
    );
  });

  test("rerun is atomic across admission failure and records the parent and new Job", async () => {
    const fixture = await createFixture("rerun-command");
    const failedInput = runInput(fixture, "rerun-failed");
    failedInput.admission = async () => { throw new Error("budget unavailable"); };
    await assert.rejects(
      commandStore.apply(fixture.principal, fixture.run.id, {
        kind: "rerun", expectedVersion: await runVersion(fixture.run.id), commandKey: "rerun-crash",
      }, failedInput),
      /budget unavailable/,
    );
    assert.equal(await receiptCount(fixture.run.id, "rerun-crash"), 0);

    const input = runInput(fixture, "rerun-success");
    const command = {
      kind: "rerun", expectedVersion: await runVersion(fixture.run.id), commandKey: "rerun-success",
    } as const;
    assert.equal(await commandStore.lookupReceipt(fixture.principal, fixture.run.id, command), undefined);
    const receipt = await commandStore.apply(fixture.principal, fixture.run.id, command, input);
    const newRunId = String(receipt.result.newRunId);
    const child = await adminPool.query<{ parent_run_id: string; job_count: number }>(
      `SELECT r.parent_run_id,
              (SELECT count(*)::int FROM pr_agent_harness.job_queue j WHERE j.run_id=r.id) AS job_count
       FROM pr_agent_harness.agent_runs r WHERE r.id=$1`,
      [newRunId],
    );
    assert.deepEqual(child.rows[0], { parent_run_id: fixture.run.id, job_count: 1 });
    const changedTrustedInput = runInput(fixture, "rerun-success");
    changedTrustedInput.runtimeConfig = { maxRunMs: 120_000, model: "new-deployment" };
    changedTrustedInput.runtimeVersionHash = hash("runtime:new-deployment");
    assert.equal(
      (await commandStore.apply(fixture.principal, fixture.run.id, command, changedTrustedInput)).id,
      receipt.id,
    );
    assert.equal(
      (await commandStore.lookupReceipt(fixture.principal, fixture.run.id, command))?.id,
      receipt.id,
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.integration_bindings SET active=false WHERE id=$1",
      [fixture.scope.integrationId],
    );
    await assert.rejects(
      commandStore.lookupReceipt(fixture.principal, fixture.run.id, command),
      { code: "RUN_NOT_FOUND" },
    );
  });

  test("resume consumes one exact wait and creates a manual job without mutating the operation", async () => {
    const { fixture, operationId, operation, waitId, intentHash } =
      await createWaitingFixture("resume-command", 2);
    const receipt = await commandStore.apply(fixture.principal, fixture.run.id, {
      kind: "resume",
      expectedVersion: await runVersion(fixture.run.id),
      commandKey: "resume-once",
      decision: {
        waitId,
        waitVersion: 1,
        intentHash,
        operationVersion: operation.version,
        decision: "confirm_occurred",
        evidence: {
          kind: "provider_confirmation", reference: "provider:confirmed", actualRevision: "head-sha",
        },
        remoteId: "remote-1",
      },
    });
    assert.equal(receipt.status, "accepted");
    assert.equal((await jobRow(fixture.run.id)).max_attempts, 2);
    assert.equal((await operationRow(operationId)).version, operation.version);
    const facts = await adminPool.query<{ wait_status: string; decision: string; job_kind: string; run_status: string }>(
      `SELECT w.status AS wait_status,d.decision,j.job_kind,r.status AS run_status
       FROM pr_agent_harness.run_waits w
       JOIN pr_agent_harness.run_wait_decisions d ON d.wait_id=w.id AND d.run_id=w.run_id
       JOIN pr_agent_harness.job_queue j ON j.command_receipt_id=d.command_receipt_id
       JOIN pr_agent_harness.agent_runs r ON r.id=w.run_id
       WHERE w.id=$1`,
      [waitId],
    );
    assert.deepEqual(facts.rows[0], {
      wait_status: "consumed",
      decision: "confirm_occurred",
      job_kind: "manual_resume",
      run_status: "waiting_for_reconciliation",
    });
    await assert.rejects(
      pool.query(
        `UPDATE pr_agent_harness.run_wait_decisions
         SET decision=decision WHERE tenant_id=$1 AND run_id=$2`,
        [fixture.scope.tenantId, fixture.run.id],
      ),
      /permission denied/,
    );
  });

  test("disabled capabilities stop new retry authorization but preserve safe manual and outcome completion", async () => {
    const previousFix = process.env.FEATURE_FIX;
    const previousPolicy = process.env.FIX_DEFAULT_POLICY_ID;
    process.env.FEATURE_FIX = "on";
    process.env.FIX_DEFAULT_POLICY_ID = "run-command-test";
    try {
      const safe = await createWaitingFixture("disabled-safe-resume", 2, ["confirm_occurred"]);
      await adminPool.query("UPDATE pr_agent_harness.agent_runs SET run_type='fix.propose.v1' WHERE id=$1",
        [safe.fixture.run.id]);
      await commandStore.apply(safe.fixture.principal, safe.fixture.run.id, {
        kind: "resume", expectedVersion: await runVersion(safe.fixture.run.id), commandKey: "safe-confirm",
        decision: { waitId: safe.waitId, waitVersion: 1, intentHash: safe.intentHash,
          operationVersion: safe.operation.version, decision: "confirm_occurred",
          evidence: { kind: "provider_confirmation", reference: "provider:safe",
            actualRevision: "head-sha" }, remoteId: "remote-safe" },
      });
      await adminPool.query("UPDATE pr_agent_harness.agent_runs SET status='waiting_for_user' WHERE id=$1",
        [safe.fixture.run.id]);
      const safeLease = await executionStore.claimManualResume({
        tenantId: safe.fixture.scope.tenantId, integrationId: safe.fixture.scope.integrationId,
        authorityGeneration: 1, executionModeGeneration: 1,
      }, "safe-resume-worker", await runtimeHash(safe.fixture.run.id), ["review.single.v1"]);
      assert.ok(safeLease);
      await executionStore.relinquishSettledLease(safeLease, "test_safe_resume");

      const retry = await createWaitingFixture("disabled-authorize-retry", 2, ["authorize_retry"]);
      await adminPool.query("UPDATE pr_agent_harness.agent_runs SET run_type='fix.propose.v1' WHERE id=$1",
        [retry.fixture.run.id]);
      await assert.rejects(commandStore.apply(retry.fixture.principal, retry.fixture.run.id, {
        kind: "resume", expectedVersion: await runVersion(retry.fixture.run.id), commandKey: "blocked-retry",
        decision: { waitId: retry.waitId, waitVersion: 1, intentHash: retry.intentHash,
          operationVersion: retry.operation.version, decision: "authorize_retry",
          evidence: { kind: "provider_confirmation", reference: "provider:not-occurred" } },
      }), { code: "CAPABILITY_DISABLED" });
      await assertResumeWasNotApplied(retry.fixture, retry.waitId, "blocked-retry");

      const outcome = await createWaitingFixture("disabled-outcome", 2);
      await adminPool.query(
        `UPDATE pr_agent_harness.agent_runs
         SET run_type='fix.propose.v1',publication_outcome_generation=1 WHERE id=$1`,
        [outcome.fixture.run.id],
      );
      const outcomeVersion = await runVersion(outcome.fixture.run.id);
      await adminPool.query(
        `INSERT INTO pr_agent_harness.job_queue
           (tenant_id,run_id,job_kind,status,expected_run_version,expected_batch_id,
            expected_operation_set_hash,outcome_generation,job_payload_json,max_attempts)
         VALUES ($1,$2,'publication_outcome','ready',$3,$4,$5,1,'{}',2)`,
        [outcome.fixture.scope.tenantId, outcome.fixture.run.id, outcomeVersion,
          outcome.batchId, outcome.operationSetHash],
      );
      const outcomeLease = await executionStore.claimPublicationOutcome({
        tenantId: outcome.fixture.scope.tenantId, integrationId: outcome.fixture.scope.integrationId,
        authorityGeneration: 1, executionModeGeneration: 1,
      }, "outcome-worker", await runtimeHash(outcome.fixture.run.id), ["review.single.v1"]);
      assert.ok(outcomeLease);
      await executionStore.transition(outcomeLease, { to: "succeeded",
        outcomeCode: "publication_completed" });
      assert.equal((await executionStore.load(outcome.fixture.scope.tenantId,
        outcome.fixture.run.id))?.status, "succeeded");
    } finally {
      if (previousFix === undefined) delete process.env.FEATURE_FIX;
      else process.env.FEATURE_FIX = previousFix;
      if (previousPolicy === undefined) delete process.env.FIX_DEFAULT_POLICY_ID;
      else process.env.FIX_DEFAULT_POLICY_ID = previousPolicy;
    }
  });

  test("resume locks the operation and rolls back when reconciliation wins the race", async () => {
    const { fixture, operationId, operation, waitId, intentHash } =
      await createWaitingFixture("resume-race");
    const blocker = await adminPool.connect();
    let resumeResult: Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT 1 FROM pr_agent_harness.repository_operations
         WHERE tenant_id=$1 AND business_operation_id=$2 FOR UPDATE`,
        [fixture.scope.tenantId, operationId],
      );
      resumeResult = commandStore.apply(fixture.principal, fixture.run.id, {
        kind: "resume", expectedVersion: await runVersion(fixture.run.id), commandKey: "resume-race",
        decision: {
          waitId, waitVersion: 1, intentHash, operationVersion: operation.version,
          decision: "confirm_occurred",
          evidence: {
            kind: "provider_confirmation", reference: "provider:race", actualRevision: "head-sha",
          },
          remoteId: "remote-race",
        },
      }).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForBlockedOperationQuery();
      await blocker.query(
        `UPDATE pr_agent_harness.repository_operations
         SET version=version+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND business_operation_id=$2`,
        [fixture.scope.tenantId, operationId],
      );
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const result = await resumeResult!;
    assert.equal(result.status, "rejected");
    assert.match(String(result.status === "rejected" ? result.error : ""), /changed before the decision/);
    await assertResumeWasNotApplied(fixture, waitId, "resume-race");
  });

  test("invalid occurred confirmation cannot consume a wait or create durable command state", async () => {
    const { fixture, operation, waitId, intentHash } = await createWaitingFixture("resume-invalid");
    await assert.rejects(
      commandStore.apply(fixture.principal, fixture.run.id, {
        kind: "resume", expectedVersion: await runVersion(fixture.run.id), commandKey: "resume-invalid",
        decision: {
          waitId, waitVersion: 1, intentHash, operationVersion: operation.version,
          decision: "confirm_occurred",
          evidence: { kind: "provider_confirmation", reference: "provider:invalid" },
        },
      } as unknown as RunCommand),
      (error: unknown) => error instanceof Error && error.name === "ZodError",
    );
    await assertResumeWasNotApplied(fixture, waitId, "resume-invalid");
  });

  test("expired Run deadline rejects resume without consuming durable state", async () => {
    const { fixture, operation, waitId, intentHash } = await createWaitingFixture("resume-expired");
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET deadline_at=created_at+interval '1 millisecond' WHERE id=$1`,
      [fixture.run.id],
    );
    await adminPool.query("SELECT pg_sleep(0.01)");
    await assert.rejects(
      commandStore.apply(fixture.principal, fixture.run.id, {
        kind: "resume", expectedVersion: await runVersion(fixture.run.id), commandKey: "resume-expired",
        decision: {
          waitId, waitVersion: 1, intentHash, operationVersion: operation.version,
          decision: "confirm_occurred",
          evidence: {
            kind: "provider_confirmation", reference: "provider:expired", actualRevision: "head-sha",
          },
          remoteId: "remote-expired",
        },
      }),
      /Expired Run deadline/,
    );
    await assertResumeWasNotApplied(fixture, waitId, "resume-expired");
  });

  async function createWaitingFixture(
    suffix: string,
    maxJobAttempts?: number,
    allowedDecisions: string[] = ["confirm_occurred"],
  ) {
    const fixture = await createFixture(suffix, maxJobAttempts);
    const lease = await claim(fixture, fixture.run.id, `${suffix}-worker`);
    const batch = await batchStore.freeze({
      runLease: lease,
      scope: fixture.scope,
      sourceKey: `source:${suffix}`,
      sourceHash: hash(`source:${suffix}`),
      operations: [{ slot: "summary", payload: { body: suffix } }],
    });
    const operationId = batch.operations[0]!.businessOperationId;
    const operation = await operationRow(operationId);
    const operationSetHash = await batchHash(batch.id);
    const intentHash = hash(`intent:${suffix}`);
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='waiting_for_reconciliation',lease_owner=NULL,lease_expires_at=NULL,
           waiting_batch_id=$2,waiting_operation_set_hash=$3,version=version+1
       WHERE id=$1`,
      [fixture.run.id, batch.id, operationSetHash],
    );
    await adminPool.query(
      `UPDATE pr_agent_harness.job_queue SET status='completed',completed_at=clock_timestamp()
       WHERE run_id=$1`,
      [fixture.run.id],
    );
    const wait = await adminPool.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.run_waits
         (tenant_id,run_id,batch_id,operation_set_hash,business_operation_id,
          operation_version,intent_hash,allowed_decisions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [fixture.scope.tenantId, fixture.run.id, batch.id, operationSetHash, operationId,
        operation.version, intentHash, JSON.stringify(allowedDecisions)],
    );
    return { fixture, operationId, operation, waitId: wait.rows[0]!.id, intentHash,
      batchId: batch.id, operationSetHash };
  }

  async function waitForBlockedOperationQuery(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await adminPool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
             AND query LIKE '%repository_operations%'
         ) AS blocked`,
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("resume did not block on the publication operation lock");
  }

  async function assertResumeWasNotApplied(
    fixture: { scope: { tenantId: string }; run: { id: string } },
    waitId: string,
    commandKey: string,
  ): Promise<void> {
    const result = await adminPool.query<{
      wait_status: string; receipt_count: number; job_count: number;
    }>(
      `SELECT w.status AS wait_status,
              (SELECT count(*)::int FROM pr_agent_harness.run_command_receipts r
               WHERE r.tenant_id=w.tenant_id AND r.run_id=w.run_id AND r.command_key=$3) AS receipt_count,
              (SELECT count(*)::int FROM pr_agent_harness.job_queue j
               WHERE j.tenant_id=w.tenant_id AND j.run_id=w.run_id
                 AND j.job_kind='manual_resume') AS job_count
       FROM pr_agent_harness.run_waits w
       WHERE w.tenant_id=$1 AND w.run_id=$2 AND w.id=$4`,
      [fixture.scope.tenantId, fixture.run.id, commandKey, waitId],
    );
    assert.deepEqual(result.rows[0], { wait_status: "open", receipt_count: 0, job_count: 0 });
  }

  async function createFixture(suffix: string, maxJobAttempts?: number) {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await adminPool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
          credential_ref,publication_state,publication_generation,quiescence_receipt,
          review_execution_mode,execution_mode_generation)
       VALUES ($1,$2,'github',$3,$4,$5,$6,'test','active',1,'{"approved":true}',
               'harness_async',1)`,
      [integrationId, tenantId, `https://${suffix}.example.test`, `acme/${suffix}`,
        String(++nextProviderId), String(nextProviderId + 10_000)],
    );
    const scope = {
      tenantId, integrationId, platform: "github" as const,
      origin: `https://${suffix}.example.test`, repository: `acme/${suffix}`,
      target: "pull:42", revision: "head-sha", authorityGeneration: 1,
    };
    const principal: RunPrincipal = {
      tenantId, integrationId, subjectId: "command-user", actorType: "user",
      permissions: ["runs:cancel","runs:resume","runs:retry","runs:recover","runs:rerun"],
    };
    const fixture = { scope, principal };
    const input = runInput(fixture, `${suffix}-initial`);
    if (maxJobAttempts !== undefined) {
      input.runtimeConfig = { ...input.runtimeConfig, maxJobAttempts };
    }
    const run = await runStore.createRun(input);
    return { ...fixture, run };
  }

  function runInput(
    fixture: { scope: { tenantId: string; integrationId: string } },
    key: string,
  ): CreateRunInput {
    const version = hash(`version:${key}`);
    return {
      tenantId: fixture.scope.tenantId,
      integrationId: fixture.scope.integrationId,
      actorType: "service",
      actorId: "test-intake",
      createScope: "test:run-command:v1",
      createKey: key,
      requestHash: hash(`request:${key}`),
      runType: "review",
      baseSha: "base-sha",
      headSha: "head-sha",
      workflowVersionHash: version,
      promptVersionHash: version,
      modelVersionHash: version,
      toolVersionHash: version,
      policyVersionHash: version,
      runtimeVersionHash: version,
      input: { key },
      authorityGeneration: 1,
      executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000 },
    };
  }

  async function createRun(fixture: { scope: { tenantId: string; integrationId: string } }, key: string) {
    return runStore.createRun(runInput(fixture, key));
  }

  async function claim(
    fixture: { scope: { tenantId: string; integrationId: string } },
    runId: string,
    owner: string,
  ) {
    const runtime = await adminPool.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE id=$1",
      [runId],
    );
    const lease = await executionStore.claim({
      tenantId: fixture.scope.tenantId,
      integrationId: fixture.scope.integrationId,
      authorityGeneration: 1,
      executionModeGeneration: 1,
    }, owner, runtime.rows[0]!.runtime_version_hash);
    assert.ok(lease);
    assert.equal(lease.runId, runId);
    return lease;
  }

  async function runVersion(runId: string): Promise<number> {
    const result = await adminPool.query<{ version: string }>(
      "SELECT version FROM pr_agent_harness.agent_runs WHERE id=$1",
      [runId],
    );
    return Number(result.rows[0]!.version);
  }

  async function runtimeHash(runId: string): Promise<string> {
    const result = await adminPool.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE id=$1",
      [runId],
    );
    return result.rows[0]!.runtime_version_hash;
  }

  async function jobRow(runId: string) {
    const result = await adminPool.query<{
      id: string; status: string; dispatch_generation: string;
      attempt_count: number; max_attempts: number;
    }>(
      `SELECT id,status,dispatch_generation,attempt_count,max_attempts
       FROM pr_agent_harness.job_queue
       WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );
    return { ...result.rows[0]!, dispatch_generation: Number(result.rows[0]!.dispatch_generation) };
  }

  async function readyJobCount(runId: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pr_agent_harness.job_queue
       WHERE run_id=$1 AND status='ready'`,
      [runId],
    );
    return result.rows[0]!.count;
  }

  async function operationRow(operationId: string) {
    const result = await adminPool.query<{ status: string; version: string }>(
      "SELECT status,version FROM pr_agent_harness.repository_operations WHERE business_operation_id=$1",
      [operationId],
    );
    return { status: result.rows[0]!.status, version: Number(result.rows[0]!.version) };
  }

  async function membership(batchId: string) {
    const result = await adminPool.query<{ action_state: string; skip_reason: string | null }>(
      "SELECT action_state,skip_reason FROM pr_agent_harness.publication_batch_operations WHERE batch_id=$1",
      [batchId],
    );
    return result.rows[0]!;
  }

  async function batchHash(batchId: string): Promise<string> {
    const result = await adminPool.query<{ operation_set_hash: string }>(
      "SELECT operation_set_hash FROM pr_agent_harness.publication_batches WHERE id=$1",
      [batchId],
    );
    return result.rows[0]!.operation_set_hash;
  }

  async function receiptCount(runId: string, commandKey: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pr_agent_harness.run_command_receipts
       WHERE run_id=$1 AND command_key=$2`,
      [runId, commandKey],
    );
    return result.rows[0]!.count;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
