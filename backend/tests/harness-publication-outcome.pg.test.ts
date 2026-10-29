import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore, type PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import { ModelBudgetStore, getModelExecutionPolicy, reserveRunBudgetInTransaction } from "../src/agent-runtime/budget/model-budget-store.js";
import { PublicationBatchCoordinator, PublicationBatchStore } from "../src/agent-runtime/publication/batches.js";
import { PublicationControlStateError, PublicationControlStore } from "../src/agent-runtime/publication/control.js";
import { PublicationOutcomeCoordinator, PublicationOutcomeHandler } from "../src/agent-runtime/publication/outcome.js";
import { PgPublicationStore, PublicationService, type PublicationAdapter } from "../src/agent-runtime/publication/publication.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import { RunControlStore } from "../src/agent-runtime/runs/control-store.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import { RunExecutionStore } from "../src/agent-runtime/execution/store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Publication outcome PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const db = new RuntimeDatabase(pool);
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const version = hash("publication-outcome-runtime-v1");
  const origin = "https://github.example.test";
  const repository = "acme/outcome";
  const policy = getModelExecutionPolicy("openai", "fixture-model", {
    NODE_ENV: "test",
    HARNESS_MODEL_PRICING_JSON: JSON.stringify({
      version: "publication-outcome-zero-v1", currency: "USD", periodKey: "publication-outcome-tests",
      tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
      runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
      models: { "openai:fixture-model": { rates: {
        inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0,
        cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
        thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0,
      }, maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3 } },
    }),
  });
  const runStore = new RunStore(db);
  const executionStore = new RunExecutionStore(db, { leaseTtlMs: 60_000 });
  const budgetStore = new ModelBudgetStore(db);
  const batchStore = new PublicationBatchStore(db);
  const batchCoordinator = new PublicationBatchCoordinator(
    batchStore,
    new PublicationService(new PgPublicationStore(db)),
  );
  const controlStore = new PublicationControlStore(db);
  const outcomeCoordinator = new PublicationOutcomeCoordinator({ db, batchStore });
  const runControl = new RunControlStore(db);
  let binding: PublicationBinding;

  before(async () => {
    await migrateRuntime(pool);
    const authority = new PublicationAuthorityStore(db);
    await runStore.registerIntegration({
      tenantId, id: integrationId, platform: "github", origin, repository,
    });
    await authority.configure({
      tenantId, integrationId, providerRepositoryId: 77, providerActorId: 88,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0,
    });
    binding = await authority.transition({
      tenantId, integrationId, expectedVersion: 1, action: "activate",
      actor: "publication-outcome-test", actorType: "service",
      quiescenceEvidence: "isolated Docker database",
    });
    await pool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET review_execution_mode='harness_async',execution_mode_generation=1
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );
    binding = { ...binding, reviewExecutionMode: "harness_async", executionModeGeneration: 1 };
  });

  after(async () => {
    await pool.end();
  });

  test("resolved outcome schedules once, claims once, and never revives a terminal Run", async () => {
    const fixture = await createWaitingFixture("resolved-once", "unknown");
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='succeeded',outcome_code='current',remote_id='remote-1',resolved_at=now(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, fixture.operationId],
    );
    await batchStore.refreshOutcome(tenantId, fixture.batchId);

    const [left, right] = await Promise.all([
      outcomeCoordinator.tick(binding),
      outcomeCoordinator.tick(binding),
    ]);
    assert.equal(left.scheduled + right.scheduled, 1);

    const claims = await Promise.all([
      executionStore.claimPublicationOutcome(claimBinding(), "outcome-a", version),
      executionStore.claimPublicationOutcome(claimBinding(), "outcome-b", version),
    ]);
    const lease = claims.find((item): item is RunLease => item !== undefined);
    assert.ok(lease);
    assert.equal(claims.filter(Boolean).length, 1);
    await handler().execute(lease);
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "succeeded");

    await pool.query(
      `UPDATE pr_agent_harness.agent_runs SET next_outcome_scan_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, fixture.runId],
    );
    const observed = await outcomeCoordinator.tick(binding);
    assert.equal(observed.scheduled, 0);
    assert.equal(observed.observedTerminal, 1);
    await outcomeCoordinator.tick(binding);
    const evidence = await pool.query<{ jobs: number; observations: number }>(
      `SELECT
         (SELECT count(*)::int FROM pr_agent_harness.job_queue
          WHERE tenant_id=$1 AND run_id=$2 AND job_kind='publication_outcome') jobs,
         (SELECT count(*)::int FROM pr_agent_harness.run_events
          WHERE tenant_id=$1 AND run_id=$2 AND event_type='publication.outcome_observed') observations`,
      [tenantId, fixture.runId],
    );
    assert.deepEqual(evidence.rows[0], { jobs: 1, observations: 1 });
  });

  test("manual not-occurred decision is replay-safe and creates a fresh authorization wait", async () => {
    const fixture = await createWaitingFixture("manual-replay", "manual_review");
    assert.equal((await outcomeCoordinator.tick(binding)).scheduled, 1);
    const outcomeLease = await executionStore.claimPublicationOutcome(
      claimBinding(), "manual-outcome", version,
    );
    assert.ok(outcomeLease);
    await handler().execute(outcomeLease);
    const waitingRun = await executionStore.load(tenantId, fixture.runId);
    assert.equal(waitingRun?.status, "waiting_for_user");
    const wait = await openWait(fixture.runId);

    await assert.rejects(
      controlStore.apply({
        tenantId, businessOperationId: fixture.operationId,
        expectedVersion: wait.operationVersion, commandKey: "legacy-linked-command",
        decision: "confirm_not_occurred", actor: { type: "user", id: "operator" },
        evidence: { kind: "provider_confirmation", reference: "manual check" },
      }),
      PublicationControlStateError,
    );

    await runControl.apply({
      subjectId: "operator", actorType: "user", tenantId, integrationId,
      permissions: ["runs:resume"],
    }, fixture.runId, {
      kind: "resume", commandKey: "resume-not-occurred",
      expectedVersion: waitingRun!.version,
      decision: {
        waitId: wait.id, waitVersion: wait.version, intentHash: wait.intentHash,
        operationVersion: wait.operationVersion, decision: "confirm_not_occurred",
        evidence: { kind: "provider_confirmation", reference: "provider search found nothing" },
      },
    });
    const manualLease = await executionStore.claimManualResume(
      claimBinding(), "manual-resume", version,
    );
    assert.ok(manualLease);

    const firstApply = await executionStore.withLease(manualLease, (client) =>
      controlStore.applyLeased(client, manualLease, {
        waitId: String(manualLease.jobPayload?.waitId),
        commandReceiptId: String(manualLease.jobPayload?.commandReceiptId),
      }));
    assert.equal(firstApply.receipt.resultingStatus, "manual_review");
    await handler().execute(manualLease);

    const nextWait = await openWait(fixture.runId);
    assert.notEqual(nextWait.id, wait.id);
    assert.equal(nextWait.operationVersion, firstApply.receipt.resultingVersion);
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "waiting_for_user");
    const evidence = await pool.query<{ receipt_count: number; dispatch_count: number; outcome_code: string }>(
      `SELECT
         (SELECT count(*)::int FROM pr_agent_harness.publication_command_receipts
          WHERE tenant_id=$1 AND command_key=$3) receipt_count,
         (SELECT attempt_count FROM pr_agent_harness.repository_operations
          WHERE tenant_id=$1 AND business_operation_id=$2) dispatch_count,
         (SELECT outcome_code FROM pr_agent_harness.repository_operations
          WHERE tenant_id=$1 AND business_operation_id=$2) outcome_code`,
      [tenantId, fixture.operationId, String(manualLease.jobPayload?.commandReceiptId)],
    );
    assert.deepEqual(evidence.rows[0], {
      receipt_count: 1, dispatch_count: 1, outcome_code: "not_occurred_confirmed",
    });

    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET dispatched_at=now()-interval '121 seconds'
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, fixture.operationId],
    );
    const retryRun = await executionStore.load(tenantId, fixture.runId);
    await runControl.apply({
      subjectId: "operator", actorType: "user", tenantId, integrationId,
      permissions: ["runs:resume"],
    }, fixture.runId, {
      kind: "resume", commandKey: "resume-authorize-retry",
      expectedVersion: retryRun!.version,
      decision: {
        waitId: nextWait.id, waitVersion: nextWait.version, intentHash: nextWait.intentHash,
        operationVersion: nextWait.operationVersion, decision: "authorize_retry",
        evidence: { kind: "provider_confirmation", reference: "retry approved after cooldown" },
      },
    });
    const retryLease = await executionStore.claimManualResume(
      claimBinding(), "manual-authorized-retry", version,
    );
    assert.ok(retryLease);
    let dispatches = 0;
    await handler(async (): Promise<PublicationAdapter> => ({
      dispatch: async () => ({ id: `retry-${++dispatches}` }),
      find: async () => null,
      currentRevision: async () => "head",
    })).execute(retryLease);
    assert.equal(dispatches, 1);
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "succeeded");
  });

  test("due-time rotation drains backlog and observes a terminal Run through its unique batch link", async () => {
    const terminal = await createWaitingFixture("terminal-link-only", "unknown");
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='cancelled',finished_at=now(),waiting_batch_id=NULL,
           waiting_operation_set_hash=NULL,next_outcome_scan_at=clock_timestamp()-interval '2 seconds'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, terminal.runId],
    );
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='succeeded',outcome_code='current',remote_id='terminal-remote',
           resolved_at=now(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, terminal.operationId],
    );
    await batchStore.refreshOutcome(tenantId, terminal.batchId);

    const actionable = await createWaitingFixture("backlog-actionable", "unknown", 2);
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='succeeded',outcome_code='current',remote_id='actionable-remote',
           resolved_at=now(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, actionable.operationId],
    );
    await batchStore.refreshOutcome(tenantId, actionable.batchId);
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET next_outcome_scan_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, actionable.runId],
    );

    assert.deepEqual(await outcomeCoordinator.tick(binding, 1), {
      scheduled: 0, observedTerminal: 1,
    });
    assert.deepEqual(await outcomeCoordinator.tick(binding, 1), {
      scheduled: 1, observedTerminal: 0,
    });
    const evidence = await pool.query<{ observations: number; max_attempts: number }>(
      `SELECT
         (SELECT count(*)::int FROM pr_agent_harness.run_events
          WHERE tenant_id=$1 AND run_id=$2 AND event_type='publication.outcome_observed') observations,
         (SELECT max_attempts FROM pr_agent_harness.job_queue
          WHERE tenant_id=$1 AND run_id=$3 AND job_kind='publication_outcome') max_attempts`,
      [tenantId, terminal.runId, actionable.runId],
    );
    assert.deepEqual(evidence.rows[0], { observations: 1, max_attempts: 2 });
    const lease = await executionStore.claimPublicationOutcome(
      claimBinding(), "backlog-cleanup", version,
    );
    assert.ok(lease);
    await handler().execute(lease);
  });

  test("terminal linked publication allows resolution only and records one observation without revival", async () => {
    const fixture = await createWaitingFixture("cancelled-manual-resolution", "unknown");
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='cancelled',finished_at=now(),waiting_batch_id=NULL,
           waiting_operation_set_hash=NULL,next_outcome_scan_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, fixture.runId],
    );
    const operation = await batchStore.loadOperation(tenantId, fixture.operationId);
    assert.ok(operation);
    const actor = { type: "user" as const, id: "terminal-operator" };
    const evidence = { kind: "provider_confirmation" as const, reference: "provider search" };
    const notOccurred = await controlStore.apply({
      tenantId, businessOperationId: fixture.operationId, expectedVersion: operation.version,
      commandKey: "terminal-confirm-not-occurred", decision: "confirm_not_occurred",
      actor, evidence,
    });
    assert.equal(notOccurred.resultingStatus, "manual_review");
    await assert.rejects(controlStore.apply({
      tenantId, businessOperationId: fixture.operationId,
      expectedVersion: notOccurred.resultingVersion,
      commandKey: "terminal-retry-forbidden", decision: "authorize_retry", actor, evidence,
    }), PublicationControlStateError);
    const abandoned = await controlStore.apply({
      tenantId, businessOperationId: fixture.operationId,
      expectedVersion: notOccurred.resultingVersion,
      commandKey: "terminal-abandon", decision: "abandon_publication", actor, evidence,
    });
    assert.equal(abandoned.resultingStatus, "failed_definite");
    assert.equal((await batchStore.refreshOutcome(tenantId, fixture.batchId))?.status, "failed_definite");
    assert.deepEqual(await outcomeCoordinator.tick(binding), {
      scheduled: 0, observedTerminal: 1,
    });
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "cancelled");
  });

  test("direct control rechecks Run links after the operation lock when a new nonterminal batch attaches", async () => {
    const fixture = await createWaitingFixture("control-attach-race", "unknown");
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='cancelled',finished_at=now(),waiting_batch_id=NULL,waiting_operation_set_hash=NULL
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, fixture.runId],
    );
    const attached = await runStore.createRun({
      tenantId, integrationId, actorType: "service", actorId: "publication-outcome-test",
      createScope: "publication-outcome.pg.v1", createKey: "control-attach-race-new-run",
      requestHash: hash("request:control-attach-race-new-run"), runType: "review.single.v1",
      baseSha: "base", headSha: "head", workflowVersionHash: version,
      promptVersionHash: version, modelVersionHash: version, toolVersionHash: version,
      policyVersionHash: policy.hash, runtimeVersionHash: version, input: { race: true },
      authorityGeneration: binding.generation, executionModeGeneration: 1,
      runtimeConfig: { modelPolicy: policy, maxJobAttempts: 3 },
      limits: { ...policy.runLimits, maxJobAttempts: 3 },
      admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId, runId, policy }),
    });
    const attachedLease = await executionStore.claim(claimBinding(), "attach-race", version);
    assert.ok(attachedLease);
    assert.equal(attachedLease.runId, attached.id);
    const before = await batchStore.loadOperation(tenantId, fixture.operationId);
    assert.ok(before);

    const attachClient = await pool.connect();
    let controlSettled = false;
    try {
      await attachClient.query("BEGIN");
      await attachClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await attachClient.query(
        `SELECT 1 FROM pr_agent_harness.repository_operations
         WHERE tenant_id=$1 AND business_operation_id=$2 FOR UPDATE`,
        [tenantId, fixture.operationId],
      );
      const control = controlStore.apply({
        tenantId, businessOperationId: fixture.operationId, expectedVersion: before.version,
        commandKey: "attach-race-direct-control", decision: "abandon_publication",
        actor: { type: "user", id: "race-operator" },
        evidence: { kind: "provider_confirmation", reference: "concurrent provider check" },
      }).finally(() => { controlSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(controlSettled, false);
      const batch = await attachClient.query<{ id: string }>(
        `INSERT INTO pr_agent_harness.publication_batches
           (tenant_id,integration_id,platform,origin,repository,target,revision,
            authority_generation,source_key,source_hash)
         VALUES ($1,$2,'github',$3,$4,'pull:1','head',$5,$6,$7) RETURNING id`,
        [tenantId, integrationId, origin, repository, binding.generation,
          "control-attach-race-new-batch", hash("control-attach-race-new-batch")],
      );
      const batchId = batch.rows[0]!.id;
      await attachClient.query(
        `INSERT INTO pr_agent_harness.publication_batch_operations
           (tenant_id,batch_id,ordinal,business_operation_id) VALUES ($1,$2,0,$3)`,
        [tenantId, batchId, fixture.operationId],
      );
      const operationSetHash = hash(`0:${fixture.operationId}`);
      await attachClient.query(
        `UPDATE pr_agent_harness.publication_batches
         SET seal_state='sealed',sealed_at=now(),operation_count=1,operation_set_hash=$3
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, batchId, operationSetHash],
      );
      await attachClient.query(
        `INSERT INTO pr_agent_harness.run_publication_batches
           (tenant_id,run_id,batch_id,lease_epoch,operation_set_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, attached.id, batchId, attachedLease.epoch, operationSetHash],
      );
      await attachClient.query("COMMIT");
      await assert.rejects(control, PublicationControlStateError);
    } catch (error) {
      await attachClient.query("ROLLBACK");
      throw error;
    } finally {
      attachClient.release();
    }
    const after = await batchStore.loadOperation(tenantId, fixture.operationId);
    assert.equal(after?.status, before.status);
    assert.equal(after?.version, before.version);
    const receipts = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pr_agent_harness.publication_command_receipts
       WHERE tenant_id=$1 AND command_key='attach-race-direct-control'`,
      [tenantId],
    );
    assert.equal(receipts.rows[0]!.count, 0);
  });

  test("manual special job exhausts its frozen attempt cap and preserves the command receipt", async () => {
    const fixture = await createWaitingFixture("manual-attempt-cap", "manual_review", 2);
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs SET next_outcome_scan_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, fixture.runId],
    );
    assert.equal((await outcomeCoordinator.tick(binding)).scheduled, 1);
    const outcomeLease = await executionStore.claimPublicationOutcome(
      claimBinding(), "attempt-cap-outcome", version,
    );
    assert.ok(outcomeLease);
    await handler().execute(outcomeLease);
    const wait = await openWait(fixture.runId);
    const waitingRun = await executionStore.load(tenantId, fixture.runId);
    await runControl.apply({
      subjectId: "operator", actorType: "user", tenantId, integrationId,
      permissions: ["runs:resume"],
    }, fixture.runId, {
      kind: "resume", commandKey: "attempt-cap-abandon", expectedVersion: waitingRun!.version,
      decision: {
        waitId: wait.id, waitVersion: wait.version, intentHash: wait.intentHash,
        operationVersion: wait.operationVersion, decision: "abandon_publication",
        evidence: { kind: "provider_confirmation", reference: "durable decision" },
      },
    });
    const first = await executionStore.claimManualResume(claimBinding(), "attempt-cap-1", version);
    assert.ok(first);
    await executionStore.retrySpecialJob(first, 1, "deterministic_fixture_error");
    await pool.query(
      `UPDATE pr_agent_harness.job_queue SET available_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, first.jobId],
    );
    const second = await executionStore.claimManualResume(claimBinding(), "attempt-cap-2", version);
    assert.ok(second);
    await executionStore.retrySpecialJob(second, 1, "deterministic_fixture_error");
    assert.equal(
      await executionStore.claimManualResume(claimBinding(), "attempt-cap-3", version),
      undefined,
    );
    const receiptId = String(second.jobPayload?.commandReceiptId);
    const result = await pool.query<{
      run_status: string; job_status: string; attempt_count: number; max_attempts: number;
      receipt_status: string; result_json: Record<string, unknown>; decision: string; dlq_count: number;
    }>(
      `SELECT r.status AS run_status,j.status AS job_status,j.attempt_count,j.max_attempts,
              c.status AS receipt_status,c.result_json,d.decision,
              (SELECT count(*)::int FROM pr_agent_harness.dead_letter_jobs dl
               WHERE dl.tenant_id=r.tenant_id AND dl.job_id=j.id) AS dlq_count
       FROM pr_agent_harness.agent_runs r
       JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.id=$3
       JOIN pr_agent_harness.run_command_receipts c
         ON c.tenant_id=r.tenant_id AND c.run_id=r.id AND c.id=$4
       JOIN pr_agent_harness.run_wait_decisions d
         ON d.tenant_id=c.tenant_id AND d.run_id=c.run_id AND d.command_receipt_id=c.id
       WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, fixture.runId, second.jobId, receiptId],
    );
    assert.deepEqual(result.rows[0], {
      run_status: "failed", job_status: "dead_letter", attempt_count: 2, max_attempts: 2,
      receipt_status: "completed",
      result_json: { status: "failed", reasonCode: "deterministic_fixture_error" },
      decision: "abandon_publication", dlq_count: 1,
    });
  });

  async function createWaitingFixture(
    key: string,
    status: "unknown" | "manual_review",
    maxJobAttempts = 3,
  ) {
    const created = await runStore.createRun({
      tenantId, integrationId, actorType: "service", actorId: "publication-outcome-test",
      createScope: "publication-outcome.pg.v1", createKey: key, requestHash: hash(`request:${key}`),
      runType: "review.single.v1", baseSha: "base", headSha: "head",
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: policy.hash, runtimeVersionHash: version,
      input: { key }, authorityGeneration: binding.generation, executionModeGeneration: 1,
      runtimeConfig: { modelPolicy: policy, maxJobAttempts },
      limits: { ...policy.runLimits, maxJobAttempts },
      admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId, runId, policy }),
    });
    const lease = await executionStore.claim(claimBinding(), `fixture-${key}`, version);
    assert.ok(lease);
    const batch = await batchStore.freeze({
      runLease: lease,
      scope: { tenantId, integrationId, platform: "github", origin, repository,
        target: "pull:1", revision: lease.headSha, authorityGeneration: binding.generation },
      sourceKey: `outcome:${key}`, sourceHash: hash(`source:${key}`),
      operations: [{ slot: `comment:${key}`, payload: { body: key } }],
    });
    const operationId = batch.operations[0]!.businessOperationId;
    await pool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status=$3,attempt_count=1,dispatched_at=now(),last_error_code='response_unknown',
           version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, operationId, status],
    );
    await batchStore.refreshOutcome(tenantId, batch.id);
    await executionStore.transition(lease, {
      to: "waiting_for_reconciliation", reasonCode: "fixture_publication_pending",
    });
    return { runId: created.id, batchId: batch.id, operationId };
  }

  function handler(
    createAdapter: ConstructorParameters<typeof PublicationOutcomeHandler>[0]["createAdapter"] =
      async (): Promise<PublicationAdapter> => ({
        dispatch: async () => { throw new Error("test adapter must not dispatch"); },
        find: async () => null,
      }),
  ): PublicationOutcomeHandler {
    return new PublicationOutcomeHandler({
      store: executionStore, budget: budgetStore, batchStore, batchCoordinator,
      control: controlStore, createAdapter,
    });
  }

  function claimBinding() {
    return {
      tenantId, integrationId, authorityGeneration: binding.generation,
      executionModeGeneration: binding.executionModeGeneration ?? 0,
    };
  }

  async function openWait(runId: string): Promise<{
    id: string; version: number; intentHash: string; operationVersion: number;
  }> {
    const result = await pool.query<{
      id: string; version: string; intent_hash: string; operation_version: string;
    }>(
      `SELECT id,version,intent_hash,operation_version FROM pr_agent_harness.run_waits
       WHERE tenant_id=$1 AND run_id=$2 AND status='open'`,
      [tenantId, runId],
    );
    assert.equal(result.rowCount, 1);
    return {
      id: result.rows[0]!.id, version: Number(result.rows[0]!.version),
      intentHash: result.rows[0]!.intent_hash,
      operationVersion: Number(result.rows[0]!.operation_version),
    };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
