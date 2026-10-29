import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import {
  createBudgetedModelExecutionContext,
  getModelExecutionPolicy,
  ModelBudgetExceededError,
  ModelBudgetStore,
  reserveRunBudgetInTransaction,
  type ModelExecutionPolicy,
} from "../src/agent-runtime/budget/model-budget-store.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import { RunExecutionStore } from "../src/agent-runtime/execution/store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (!databaseUrl) {
  test.skip("PostgreSQL model budget tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 25 });
  const db = new RuntimeDatabase(pool);
  const runStore = new RunStore(db);
  const executionStore = new RunExecutionStore(db);
  const budgetStore = new ModelBudgetStore(db);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const integrationId = randomUUID();
  const policy = buildPolicy();
  const version = hash("version");
  let acceptedRunIds: string[] = [];

  before(async () => {
    await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(pool);
    await runStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: "acme/model-budget",
    });
  });

  after(async () => {
    await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await pool.end();
  });

  test("100 concurrent Run admissions cannot overshoot the shared tenant envelope", async () => {
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
      runStore.createRun(runInput(`budget-${index}`))));
    const accepted = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runStore.createRun>>> =>
      result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    acceptedRunIds = accepted.map((result) => result.value.id);

    assert.equal(accepted.length, 10);
    assert.equal(rejected.length, 90);
    assert.ok(rejected.every((result) => result.reason instanceof ModelBudgetExceededError));

    const account = await pool.query<{
      reserved_input_tokens: string;
      reserved_output_tokens: string;
      reserved_cost_micros: string;
    }>(
      `SELECT reserved_input_tokens,reserved_output_tokens,reserved_cost_micros
       FROM pr_agent_harness.tenant_budget_accounts WHERE tenant_id=$1`,
      [tenantId],
    );
    assert.deepEqual(account.rows[0], {
      reserved_input_tokens: "1000",
      reserved_output_tokens: "1000",
      reserved_cost_micros: "10000",
    });
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pr_agent_harness.run_budget_envelopes
       WHERE tenant_id=$1`,
      [tenantId],
    );
    assert.equal(count.rows[0]?.count, 10);
  });

  test("known settlement is idempotent and parser-independent; missing usage remains pending", async () => {
    const lease = await activateRun(acceptedRunIds[0]!);
    const step = await executionStore.beginStep(lease, {
      stepKey: "model:known",
      kind: "model",
      inputHash: hash("known-input"),
    });
    const call = await budgetStore.prepare({
      lease,
      stepId: step.id,
      stepAttemptId: step.attemptId,
      physicalOrdinal: 1,
      intent: intent("known"),
      policy,
    });
    await budgetStore.markDispatched(call, lease);
    const result = {
      value: "not-json",
      rawResponse: { text: "not-json" },
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, original: {} },
      providerRequestId: "request-known",
    };
    await budgetStore.settleKnown({ call, lease, policy, result });
    await budgetStore.settleKnown({ call, lease, policy, result });

    const usage = await pool.query<{ count: number; cost_micros: string }>(
      `SELECT count(*)::int AS count,max(cost_micros)::text AS cost_micros
       FROM pr_agent_harness.usage_records WHERE tenant_id=$1 AND model_call_id=$2`,
      [tenantId, call.id],
    );
    assert.deepEqual(usage.rows[0], { count: 1, cost_micros: "14" });

    const unavailable = await budgetStore.prepare({
      lease,
      stepId: step.id,
      stepAttemptId: step.attemptId,
      physicalOrdinal: 2,
      intent: intent("usage-missing"),
      policy,
    });
    await budgetStore.markDispatched(unavailable, lease);
    await budgetStore.settleKnown({
      call: unavailable,
      lease,
      policy,
      result: { value: { ok: true }, rawResponse: { ok: true } },
    });
    const pending = await pool.query<{ call_status: string; reservation_status: string }>(
      `SELECT mc.status AS call_status,br.status AS reservation_status
       FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       WHERE mc.tenant_id=$1 AND mc.id=$2`,
      [tenantId, unavailable.id],
    );
    assert.deepEqual(pending.rows[0], {
      call_status: "succeeded",
      reservation_status: "pending",
    });
  });

  test("response loss keeps the old reservation and a recovered worker uses a new bounded physical call", async () => {
    const lease = await activateRun(acceptedRunIds[1]!);
    const step = await executionStore.beginStep(lease, {
      stepKey: "model:response-loss",
      kind: "model",
      inputHash: hash("response-loss"),
    });
    const firstCall = await budgetStore.prepare({
      lease,
      stepId: step.id,
      stepAttemptId: step.attemptId,
      physicalOrdinal: 1,
      intent: intent("response-loss"),
      policy,
    });
    await budgetStore.markDispatched(firstCall, lease);

    let sameAttemptTransports = 0;
    const sameAttempt = createBudgetedModelExecutionContext({
      store: budgetStore, lease, stepId: step.id, stepAttemptId: step.attemptId, policy,
    });
    await assert.rejects(
      sameAttempt.execute(intent("response-loss"), async () => {
        sameAttemptTransports += 1;
        return { value: {}, rawResponse: {} };
      }),
      /requires reconciliation/,
    );
    assert.equal(sameAttemptTransports, 0);

    const replacementLease = await replaceLease(lease);
    const replacementStep = await executionStore.beginStep(replacementLease, {
      stepKey: "model:response-loss",
      kind: "model",
      inputHash: hash("response-loss"),
    });
    assert.notEqual(replacementStep.attemptId, step.attemptId);

    let transports = 0;
    const recovered = createBudgetedModelExecutionContext({
      store: budgetStore,
      lease: replacementLease,
      stepId: replacementStep.id,
      stepAttemptId: replacementStep.attemptId,
      policy,
    });
    const value = await recovered.execute(intent("response-loss"), async () => {
      transports += 1;
      return {
        value: { recovered: true },
        rawResponse: { recovered: true },
        usage: { inputTokens: 5, outputTokens: 2, original: {} },
      };
    });
    assert.deepEqual(value, { recovered: true });
    assert.equal(transports, 1);
    const calls = await pool.query<{ step_attempt_id: string; physical_ordinal: number; status: string; reservation_status: string }>(
      `SELECT mc.step_attempt_id,mc.physical_ordinal,mc.status,br.status AS reservation_status
       FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       WHERE mc.tenant_id=$1 AND mc.run_id=$2 ORDER BY mc.created_at,mc.id`,
      [tenantId, lease.runId],
    );
    assert.deepEqual(calls.rows, [
      { step_attempt_id: step.attemptId, physical_ordinal: 1, status: "unknown", reservation_status: "pending" },
      { step_attempt_id: replacementStep.attemptId, physical_ordinal: 1, status: "succeeded", reservation_status: "settled" },
    ]);
  });

  test("a known response is reused across step attempts without another charge", async () => {
    const lease = await activateRun(acceptedRunIds[5]!);
    const step = await executionStore.beginStep(lease, {
      stepKey: "model:known-reuse",
      kind: "model",
      inputHash: hash("known-reuse"),
    });
    const first = createBudgetedModelExecutionContext({
      store: budgetStore, lease, stepId: step.id, stepAttemptId: step.attemptId, policy,
    });
    const firstValue = await first.execute(intent("known-reuse"), async () => ({
      value: { persisted: true },
      rawResponse: { persisted: true },
      usage: { inputTokens: 7, outputTokens: 3, original: {} },
    }));
    assert.deepEqual(firstValue, { persisted: true });

    const replacementLease = await replaceLease(lease);
    const replacementStep = await executionStore.beginStep(replacementLease, {
      stepKey: "model:known-reuse",
      kind: "model",
      inputHash: hash("known-reuse"),
    });
    let transports = 0;
    const recovered = createBudgetedModelExecutionContext({
      store: budgetStore,
      lease: replacementLease,
      stepId: replacementStep.id,
      stepAttemptId: replacementStep.attemptId,
      policy,
    });
    const reused = await recovered.execute(intent("known-reuse"), async () => {
      transports += 1;
      return { value: { duplicate: true }, rawResponse: { duplicate: true } };
    });
    assert.deepEqual(reused, { persisted: true });
    assert.equal(transports, 0);
    const ledger = await pool.query<{ calls: number; reservations: number; cost_micros: string }>(
      `SELECT count(DISTINCT mc.id)::int AS calls,count(DISTINCT br.model_call_id)::int AS reservations,
              max(ur.cost_micros)::text AS cost_micros
       FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       LEFT JOIN pr_agent_harness.usage_records ur ON ur.model_call_id=mc.id
       WHERE mc.tenant_id=$1 AND mc.run_id=$2`,
      [tenantId, lease.runId],
    );
    assert.deepEqual(ledger.rows[0], { calls: 1, reservations: 1, cost_micros: "10" });
  });

  test("pre-dispatch crashes release unused reservations before admitting a replacement attempt", async () => {
    let lease = await activateRun(acceptedRunIds[7]!);
    let step = await executionStore.beginStep(lease, {
      stepKey: "model:prepared-crash", kind: "model", inputHash: hash("prepared-crash"),
    });
    for (let attempt = 0; attempt <= policy.maxPhysicalCallsPerStep; attempt += 1) {
      await budgetStore.prepare({ lease, stepId: step.id, stepAttemptId: step.attemptId,
        physicalOrdinal: 1, intent: intent("prepared-crash"), policy });
      lease = await replaceLease(lease);
      step = await executionStore.beginStep(lease, {
        stepKey: "model:prepared-crash", kind: "model", inputHash: hash("prepared-crash"),
      });
    }
    let dispatched = 0;
    const context = createBudgetedModelExecutionContext({ store: budgetStore, lease,
      stepId: step.id, stepAttemptId: step.attemptId, policy });
    await context.execute(intent("prepared-crash"), async () => {
      dispatched += 1;
      return { value: { recovered: true }, rawResponse: { recovered: true },
        usage: { inputTokens: 7, outputTokens: 3, original: {} } };
    });
    assert.equal(dispatched, 1);
    const ledger = await pool.query<{ released: number; settled: number; pending: number }>(
      `SELECT count(*) FILTER (WHERE status='released')::int AS released,
              count(*) FILTER (WHERE status='settled')::int AS settled,
              count(*) FILTER (WHERE status IN ('reserved','pending'))::int AS pending
       FROM pr_agent_harness.model_budget_reservations WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, lease.runId],
    );
    assert.deepEqual(ledger.rows[0], { released: policy.maxPhysicalCallsPerStep + 1, settled: 1, pending: 0 });
  });

  test("physical-call cap is cumulative across replacement step attempts", async () => {
    let lease = await activateRun(acceptedRunIds[6]!);
    let step = await executionStore.beginStep(lease, {
      stepKey: "model:cumulative-cap",
      kind: "model",
      inputHash: hash("cumulative-cap"),
    });
    for (let attempt = 1; attempt <= policy.maxPhysicalCallsPerStep; attempt += 1) {
      const call = await budgetStore.prepare({
        lease,
        stepId: step.id,
        stepAttemptId: step.attemptId,
        physicalOrdinal: 1,
        intent: intent(`cumulative-cap-${attempt}`),
        policy,
      });
      await budgetStore.markDispatched(call, lease);
      if (attempt < policy.maxPhysicalCallsPerStep) {
        lease = await replaceLease(lease);
        step = await executionStore.beginStep(lease, {
          stepKey: "model:cumulative-cap",
          kind: "model",
          inputHash: hash("cumulative-cap"),
        });
      }
    }
    lease = await replaceLease(lease);
    step = await executionStore.beginStep(lease, {
      stepKey: "model:cumulative-cap",
      kind: "model",
      inputHash: hash("cumulative-cap"),
    });
    await assert.rejects(
      budgetStore.prepare({
        lease,
        stepId: step.id,
        stepAttemptId: step.attemptId,
        physicalOrdinal: 1,
        intent: intent("cumulative-cap-overflow"),
        policy,
      }),
      ModelBudgetExceededError,
    );
    const ledger = await pool.query<{ calls: number; retained: number }>(
      `SELECT count(*)::int AS calls,
              count(*) FILTER (WHERE br.status IN ('pending','reserved'))::int AS retained
       FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       WHERE mc.tenant_id=$1 AND mc.run_id=$2`,
      [tenantId, lease.runId],
    );
    assert.deepEqual(ledger.rows[0], {
      calls: policy.maxPhysicalCallsPerStep,
      retained: policy.maxPhysicalCallsPerStep,
    });
  });

  test("a lost lease cannot settle or release a dispatched call, but can preserve it as unknown", async () => {
    const lease = await activateRun(acceptedRunIds[3]!);
    const step = await executionStore.beginStep(lease, {
      stepKey: "model:lost-lease",
      kind: "model",
      inputHash: hash("lost-lease"),
    });
    const call = await budgetStore.prepare({
      lease,
      stepId: step.id,
      stepAttemptId: step.attemptId,
      physicalOrdinal: 1,
      intent: intent("lost-lease"),
      policy,
    });
    await budgetStore.markDispatched(call, lease);
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET lease_owner='replacement-worker',lease_epoch=lease_epoch+1
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, lease.runId],
    );
    await assert.rejects(
      budgetStore.settleKnown({
        call,
        lease,
        policy,
        result: {
          value: { late: true },
          rawResponse: { late: true },
          usage: { inputTokens: 1, outputTokens: 1, original: {} },
        },
      }),
      /lease is no longer valid/i,
    );
    await budgetStore.settleUnknown({ call, lease, errorCode: "lease_lost_after_dispatch" });
    const state = await pool.query<{ call_status: string; reservation_status: string }>(
      `SELECT mc.status AS call_status,br.status AS reservation_status
       FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       WHERE mc.tenant_id=$1 AND mc.id=$2`,
      [tenantId, call.id],
    );
    assert.deepEqual(state.rows[0], {
      call_status: "unknown",
      reservation_status: "pending",
    });
  });

  test("provider actual overrun is recorded and blocks future calls", async () => {
    const lease = await activateRun(acceptedRunIds[4]!);
    const step = await executionStore.beginStep(lease, {
      stepKey: "model:overrun",
      kind: "model",
      inputHash: hash("overrun"),
    });
    const call = await budgetStore.prepare({
      lease,
      stepId: step.id,
      stepAttemptId: step.attemptId,
      physicalOrdinal: 1,
      intent: intent("overrun"),
      policy,
    });
    await budgetStore.markDispatched(call, lease);
    await budgetStore.settleKnown({
      call,
      lease,
      policy,
      result: {
        value: { overrun: true },
        rawResponse: { overrun: true },
        usage: { inputTokens: 150, outputTokens: 150, original: {} },
      },
    });
    await assert.rejects(
      budgetStore.prepare({
        lease,
        stepId: step.id,
        stepAttemptId: step.attemptId,
        physicalOrdinal: 2,
        intent: intent("after-overrun"),
        policy,
      }),
      ModelBudgetExceededError,
    );
    const envelope = await pool.query<{ actual_input_tokens: string; actual_output_tokens: string; overdrawn: boolean }>(
      `SELECT actual_input_tokens,actual_output_tokens,overdrawn
       FROM pr_agent_harness.run_budget_envelopes WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, lease.runId],
    );
    assert.deepEqual(envelope.rows[0], {
      actual_input_tokens: "150",
      actual_output_tokens: "150",
      overdrawn: true,
    });
  });

  test("terminal maintenance releases safe envelopes but retains unknown cost", async () => {
    const safeRun = acceptedRunIds[2]!;
    const unknownRun = acceptedRunIds[1]!;
    const safeLease = await activateRun(safeRun);
    const safeStep = await executionStore.beginStep(safeLease, {
      stepKey: "model:never-dispatched",
      kind: "model",
      inputHash: hash("never-dispatched"),
    });
    const prepared = await budgetStore.prepare({
      lease: safeLease,
      stepId: safeStep.id,
      stepAttemptId: safeStep.attemptId,
      physicalOrdinal: 1,
      intent: intent("never-dispatched"),
      policy,
    });
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='failed',lease_owner=NULL,lease_expires_at=NULL,finished_at=now()
       WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
      [tenantId, [safeRun, unknownRun]],
    );
    const result = await budgetStore.closeTerminalBudgets(tenantId);
    assert.ok(result.closed >= 1);
    assert.ok(result.pending >= 1);
    const envelopes = await pool.query<{ run_id: string; status: string }>(
      `SELECT run_id,status FROM pr_agent_harness.run_budget_envelopes
       WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY run_id`,
      [tenantId, [safeRun, unknownRun]],
    );
    const byRun = new Map(envelopes.rows.map((row) => [row.run_id, row.status]));
    assert.equal(byRun.get(safeRun), "closed");
    assert.equal(byRun.get(unknownRun), "pending_reconciliation");
    const released = await pool.query<{ call_status: string; reservation_status: string }>(
      `SELECT mc.status AS call_status,br.status AS reservation_status
       FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       WHERE mc.tenant_id=$1 AND mc.id=$2`,
      [tenantId, prepared.id],
    );
    assert.deepEqual(released.rows[0], {
      call_status: "failed_definite",
      reservation_status: "released",
    });
    assert.deepEqual(await budgetStore.closeTerminalBudgets(tenantId), { closed: 0, pending: 1 });
  });

  test("RLS does not expose another tenant model ledger", async () => {
    const role = `model_budget_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
      await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA pr_agent_harness TO ${role}`);
      const url = new URL(databaseUrl);
      url.username = role;
      url.password = password;
      const tenantPool = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        const result = await new RuntimeDatabase(tenantPool).transaction(otherTenantId, (client) =>
          client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pr_agent_harness.model_calls",
          ));
        assert.equal(result.rows[0]?.count, 0);
      } finally {
        await tenantPool.end();
      }
    } finally {
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });

  function runInput(key: string) {
    return {
      tenantId,
      integrationId,
      actorType: "service" as const,
      actorId: "budget-test",
      createScope: "budget:test:v1",
      createKey: key,
      requestHash: hash(key),
      runType: "review",
      baseSha: "base",
      headSha: "head",
      workflowVersionHash: version,
      promptVersionHash: version,
      modelVersionHash: version,
      toolVersionHash: version,
      policyVersionHash: policy.hash,
      runtimeVersionHash: version,
      input: { key },
      limits: { maxStepAttempts: 10 },
      admission: (client: Parameters<typeof reserveRunBudgetInTransaction>[0], runId: string) =>
        reserveRunBudgetInTransaction(client, { tenantId, runId, policy }),
    };
  }

  async function activateRun(runId: string): Promise<RunLease> {
    const run = await pool.query<{ deadline_at: Date }>(
      `UPDATE pr_agent_harness.agent_runs
       SET status='running',lease_owner='model-budget-worker',lease_epoch=lease_epoch+1,
           lease_expires_at=now()+interval '5 minutes',execution_attempt_count=execution_attempt_count+1
       WHERE tenant_id=$1 AND id=$2 RETURNING deadline_at`,
      [tenantId, runId],
    );
    const job = await pool.query<{ id: string; attempt_count: number }>(
      `UPDATE pr_agent_harness.job_queue
       SET status='running',attempt_count=attempt_count+1,claimed_run_epoch=1
       WHERE tenant_id=$1 AND run_id=$2 RETURNING id,attempt_count`,
      [tenantId, runId],
    );
    return {
      tenantId,
      runId,
      integrationId,
      jobId: job.rows[0]!.id,
      owner: "model-budget-worker",
      epoch: 1,
      jobAttempt: job.rows[0]!.attempt_count,
      authorityGeneration: 0,
      executionModeGeneration: 0,
      deadlineAt: run.rows[0]!.deadline_at.toISOString(),
      baseSha: "base",
      headSha: "head",
      workflowVersionHash: version,
      promptVersionHash: version,
      modelVersionHash: version,
      toolVersionHash: version,
      policyVersionHash: policy.hash,
      runtimeVersionHash: version,
      input: {},
      limits: { maxStepAttempts: 10 },
      runtimeConfig: {},
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async function replaceLease(lease: RunLease): Promise<RunLease> {
    const nextEpoch = lease.epoch + 1;
    const run = await pool.query<{ deadline_at: Date }>(
      `UPDATE pr_agent_harness.agent_runs
       SET lease_owner='replacement-worker',lease_epoch=$3,
           lease_expires_at=now()+interval '5 minutes',execution_attempt_count=execution_attempt_count+1
       WHERE tenant_id=$1 AND id=$2 RETURNING deadline_at`,
      [tenantId, lease.runId, nextEpoch],
    );
    const job = await pool.query<{ attempt_count: number }>(
      `UPDATE pr_agent_harness.job_queue
       SET attempt_count=attempt_count+1,claimed_run_epoch=$3
       WHERE tenant_id=$1 AND id=$2 RETURNING attempt_count`,
      [tenantId, lease.jobId, nextEpoch],
    );
    return {
      ...lease,
      owner: "replacement-worker",
      epoch: nextEpoch,
      jobAttempt: job.rows[0]!.attempt_count,
      deadlineAt: run.rows[0]!.deadline_at.toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  function intent(name: string) {
    return {
      provider: "openai" as const,
      model: "model-a",
      requestKind: "chat-completion",
      requestHash: hash(name),
      inputTokenUpperBound: 20,
      maxOutputTokens: 10,
    };
  }
}

function buildPolicy(): ModelExecutionPolicy {
  return getModelExecutionPolicy("openai", "model-a", {
    HARNESS_MODEL_PRICING_JSON: JSON.stringify({
      version: "test-pricing-v1",
      currency: "USD",
      periodKey: "test-period",
      tenantLimits: { inputTokens: 1_000, outputTokens: 1_000, costMicros: 10_000 },
      runLimits: { inputTokens: 100, outputTokens: 100, costMicros: 1_000 },
      models: {
        "openai:model-a": {
          rates: {
            inputMicrosPerMillion: 1_000_000,
            cachedInputMicrosPerMillion: 1_000_000,
            cacheWriteInputMicrosPerMillion: 1_000_000,
            outputMicrosPerMillion: 1_000_000,
            thoughtOutputMicrosPerMillion: 1_000_000,
            toolInputMicrosPerMillion: 1_000_000,
          },
          maxOutputTokens: 20,
          maxPhysicalCallsPerStep: 4,
        },
      },
    }),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
