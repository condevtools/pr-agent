import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore } from "../src/harness/authority.js";
import { HarnessDatabase } from "../src/harness/postgres/database.js";
import { migrateHarness } from "../src/harness/postgres/migrations.js";
import { HarnessRunStore, type CreateRunInput } from "../src/harness/postgres/run-store.js";
import { PublicationBatchCoordinator, PublicationBatchStore } from "../src/harness/publication-batches.js";
import { PgPublicationStore, PublicationService } from "../src/harness/publication.js";
import { RunExecutionStore } from "../src/harness/run-execution-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Execution rollout PostgreSQL tests require the dedicated Docker database", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }
  const adminPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const roleName = `execution_rollout_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  let pool: Pool;
  let authority: PublicationAuthorityStore;
  let runStore: HarnessRunStore;
  let executionStore: RunExecutionStore;
  let batchStore: PublicationBatchStore;
  let batchCoordinator: PublicationBatchCoordinator;
  let providerId = 150_000;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateHarness(adminPool);
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
    await adminPool.query(`GRANT EXECUTE ON FUNCTION
      pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint),
      pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_active_legacy_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_legacy_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.skip_failed_batch_successors(uuid,uuid) TO ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = password;
    pool = new Pool({ connectionString: appUrl.toString(), max: 8 });
    authority = new PublicationAuthorityStore(new HarnessDatabase(adminPool));
    const runtimeDb = new HarnessDatabase(pool);
    runStore = new HarnessRunStore(runtimeDb);
    executionStore = new RunExecutionStore(runtimeDb);
    batchStore = new PublicationBatchStore(runtimeDb);
    batchCoordinator = new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(new PgPublicationStore(runtimeDb)),
    );
  });

  after(async () => {
    await pool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("execution state defaults active and drain is version-CAS idempotent only by receipt", async () => {
    const binding = await seedBinding("rollout-cas", "legacy_sync", 0);
    assert.equal(binding.reviewExecutionState, "active");
    const results = await Promise.allSettled([
      authority.drainExecution(adminCommand(binding, "first drain")),
      authority.drainExecution(adminCommand(binding, "competing drain")),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    const drained = await authority.get(binding.tenantId, binding.id);
    assert.equal(drained.reviewExecutionState, "draining");
    assert.equal(drained.version, binding.version + 1);
    const receipt = await adminPool.query<{ execution_drain_receipt: Record<string, unknown> }>(
      "SELECT execution_drain_receipt FROM pr_agent_harness.integration_bindings WHERE id=$1",
      [binding.id],
    );
    assert.equal(receipt.rows[0]!.execution_drain_receipt.fromMode, "legacy_sync");
  });

  test("drain blocks new admission and claim while an existing lease can finish freezing", async () => {
    const binding = await seedBinding("rollout-inflight", "harness_async", 1);
    const first = await runStore.createRun(runInput(binding, "first", "head-first"));
    await runStore.createRun(runInput(binding, "second", "head-second"));
    const lease = await claim(binding, "inflight-worker");
    assert.equal(lease.runId, first.id);
    const drained = await authority.drainExecution(adminCommand(binding, "stop new async work"));
    await assert.rejects(
      runStore.createRun(runInput(drained, "late", "head-late")),
      /execution authority/,
    );
    assert.equal(await executionStore.claim(claimBinding(drained), "late-worker", lease.runtimeVersionHash), undefined);
    const batch = await batchStore.freeze({
      runLease: lease,
      scope: scope(binding, "42", lease.headSha),
      sourceKey: "inflight-source",
      sourceHash: hash("inflight-source"),
      operations: [{ slot: "summary", payload: { body: "finish during drain" } }],
    });
    assert.equal(batch.operations.length, 1);
  });

  test("a drain winning the binding lock still permits one frozen legacy dispatch claim", async () => {
    const binding = await seedBinding("rollout-dispatch-race", "legacy_sync", 0);
    const batch = await batchStore.freeze({
      scope: scope(binding, "race", "head-race"), executionModeGeneration: 0,
      sourceKey: "dispatch-race", sourceHash: hash("dispatch-race"),
      operations: [{ slot: "summary", payload: { body: "dispatch once" } }],
    });
    const blocker = await adminPool.connect();
    let dispatches = 0;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM pr_agent_harness.integration_bindings WHERE id=$1 FOR UPDATE",
        [binding.id],
      );
      await blocker.query(
        `UPDATE pr_agent_harness.integration_bindings
         SET review_execution_state='draining',authority_version=authority_version+1 WHERE id=$1`,
        [binding.id],
      );
      const execution = batchCoordinator.execute(
        binding.tenantId,
        batch.id,
        async () => ({
          dispatch: async () => { dispatches += 1; return { id: "race-remote" }; },
          find: async () => null,
        }),
        undefined,
        0,
      );
      await waitForBlockedAuthorityQuery();
      await blocker.query("COMMIT");
      assert.equal((await execution).status, "succeeded");
      assert.equal((await batchCoordinator.execute(
        binding.tenantId,
        batch.id,
        async () => ({
          dispatch: async () => { dispatches += 1; return { id: "unexpected" }; },
          find: async () => ({ id: "race-remote" }),
        }),
        undefined,
        0,
      )).status, "succeeded");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    assert.equal(dispatches, 1);
    assert.deepEqual(await publicationIdentityCounts(binding.id), { operations: 1, slots: 1 });
  });

  test("switch fails closed for nonterminal Runs and unresolved operations, and late legacy freeze is fenced", async () => {
    const runBlocked = await seedBinding("rollout-run-blocked", "harness_async", 1);
    await runStore.createRun(runInput(runBlocked, "pending", "head-pending"));
    const runDrained = await authority.drainExecution(adminCommand(runBlocked, "drain with pending run"));
    await assert.rejects(
      authority.switchExecution(switchCommand(runDrained, "legacy_sync", "must not switch")),
      /Nonterminal Runs/,
    );
    assert.deepEqual(await executionIdentity(runBlocked.id), {
      mode: "harness_async", state: "draining", generation: 1,
    });
    const resumed = await authority.resumeExecution({
      tenantId: runDrained.tenantId, integrationId: runDrained.id,
      expectedVersion: runDrained.version, actor: "rollout-admin", actorType: "service",
      evidence: "abort blocked drain",
    });
    assert.equal(resumed.reviewExecutionState, "active");
    assert.equal(resumed.reviewExecutionMode, "harness_async");
    assert.equal(resumed.executionModeGeneration, 1);
    await assert.rejects(
      authority.resumeExecution({
        tenantId: runDrained.tenantId, integrationId: runDrained.id,
        expectedVersion: runDrained.version, actor: "rollout-admin", actorType: "service",
        evidence: "stale resume",
      }),
      /version conflict/,
    );

    const operationBlocked = await seedBinding("rollout-operation-blocked", "legacy_sync", 0);
    await batchStore.freeze({
      scope: scope(operationBlocked, "43", "head-operation"),
      executionModeGeneration: 0,
      sourceKey: "unresolved-source", sourceHash: hash("unresolved-source"),
      operations: [{ slot: "summary", payload: { body: "unresolved" } }],
    });
    const operationDrained = await authority.drainExecution(adminCommand(operationBlocked, "drain unresolved"));
    await assert.rejects(
      authority.switchExecution(switchCommand(operationDrained, "harness_async", "must remain legacy")),
      /Unresolved publication operations/,
    );
    assert.deepEqual(await executionIdentity(operationBlocked.id), {
      mode: "legacy_sync", state: "draining", generation: 0,
    });

    const switchedBinding = await seedBinding("rollout-late-legacy", "legacy_sync", 0);
    const switched = await drainAndSwitch(switchedBinding, "harness_async");
    assert.equal(switched.executionModeGeneration, 1);
    await assert.rejects(
      batchStore.freeze({
        scope: scope(switchedBinding, "44", "head-late-legacy"),
        executionModeGeneration: 0,
        sourceKey: "late-legacy", sourceHash: hash("late-legacy"),
        operations: [{ slot: "summary", payload: { body: "late" } }],
      }),
      { name: "InactiveIntegrationBindingError" },
    );
    assert.equal(await batchCount(switchedBinding.id), 0);
  });

  test("a terminal legacy batch attaches once to a same-revision async Run", async () => {
    const legacy = await seedBinding("rollout-attach", "legacy_sync", 0);
    const batch = await batchStore.freeze({
      scope: scope(legacy, "45", "head-shared"), executionModeGeneration: 0,
      sourceKey: "shared-source", sourceHash: hash("shared-source"),
      operations: [{ slot: "summary", payload: { body: "already published" } }],
    });
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='succeeded',outcome_code='current',remote_id='remote-existing',
           resolved_at=clock_timestamp(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [legacy.tenantId, batch.operations[0]!.businessOperationId],
    );
    assert.equal((await batchStore.refreshOutcome(legacy.tenantId, batch.id))?.status, "succeeded");
    const asyncBinding = await drainAndSwitch(legacy, "harness_async");
    await assert.rejects(
      batchStore.assertLegacyBatchExecution(batch, 0),
      { name: "InactiveIntegrationBindingError" },
    );
    const same = await runStore.createRun(runInput(asyncBinding, "same-revision", "head-shared"));
    const sameLease = await claim(asyncBinding, "attach-worker");
    assert.equal(sameLease.runId, same.id);
    await batchStore.attachExistingBatchToRun(sameLease, batch.id);
    await batchStore.attachExistingBatchToRun(sameLease, batch.id);
    assert.deepEqual(await attachmentCounts(same.id, batch.id), { links: 1, checkpoints: 1 });

    const competing = await runStore.createRun(runInput(asyncBinding, "competing-revision", "head-shared"));
    const competingLease = await claim(asyncBinding, "competing-worker");
    assert.equal(competingLease.runId, competing.id);
    await assert.rejects(
      batchStore.attachExistingBatchToRun(competingLease, batch.id),
      /publication batch is already owned by another Run/,
    );
    assert.deepEqual(await attachmentCounts(competing.id, batch.id), { links: 0, checkpoints: 0 });

    const wrong = await runStore.createRun(runInput(asyncBinding, "wrong-revision", "head-other"));
    const wrongLease = await claim(asyncBinding, "wrong-worker");
    assert.equal(wrongLease.runId, wrong.id);
    await assert.rejects(
      batchStore.attachExistingBatchToRun(wrongLease, batch.id),
      /does not match the executing Run revision/,
    );
    assert.deepEqual(await attachmentCounts(wrong.id, batch.id), { links: 0, checkpoints: 0 });
    assert.deepEqual(await publicationIdentityCounts(legacy.id), { operations: 1, slots: 1 });
  });

  async function seedBinding(suffix: string, mode: "legacy_sync" | "harness_async", generation: number) {
    const tenantId = randomUUID();
    const id = randomUUID();
    const numericId = ++providerId;
    await adminPool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
          credential_ref,publication_state,publication_generation,quiescence_receipt,
          review_execution_mode,execution_mode_generation)
       VALUES ($1,$2,'github',$3,$4,$5,$6,'env:GITHUB_TOKEN','active',1,
               '{"approved":true}',$7,$8)`,
      [id, tenantId, `https://${suffix}.example.test`, `acme/${suffix}`, String(numericId),
        String(numericId + 100_000), mode, generation],
    );
    return authority.get(tenantId, id);
  }

  function adminCommand(binding: Awaited<ReturnType<typeof seedBinding>>, evidence: string) {
    return { tenantId: binding.tenantId, integrationId: binding.id,
      expectedVersion: binding.version, actor: "rollout-admin", actorType: "service" as const, evidence };
  }

  function switchCommand(binding: Awaited<ReturnType<typeof seedBinding>>,
    mode: "legacy_sync" | "harness_async", evidence: string) {
    return { ...adminCommand(binding, evidence), mode };
  }

  async function drainAndSwitch(binding: Awaited<ReturnType<typeof seedBinding>>, mode: "legacy_sync" | "harness_async") {
    const drained = await authority.drainExecution(adminCommand(binding, `drain before ${mode}`));
    return authority.switchExecution(switchCommand(drained, mode, `switch to ${mode}`));
  }

  function scope(binding: Awaited<ReturnType<typeof seedBinding>>, target: string, revision: string) {
    return { tenantId: binding.tenantId, integrationId: binding.id, platform: binding.platform,
      origin: binding.origin, repository: binding.repository, target, revision,
      authorityGeneration: binding.generation };
  }

  function runInput(binding: Awaited<ReturnType<typeof seedBinding>>, key: string, headSha: string): CreateRunInput {
    const version = hash(`version:${key}`);
    return {
      tenantId: binding.tenantId, integrationId: binding.id,
      actorType: "service", actorId: "rollout-test", createScope: "rollout:test", createKey: key,
      requestHash: hash(`request:${key}`), runType: "review", baseSha: "base-sha", headSha,
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: { key }, authorityGeneration: binding.generation,
      executionModeGeneration: binding.executionModeGeneration ?? 0,
      runtimeConfig: { maxRunMs: 60_000 },
    };
  }

  async function claim(binding: Awaited<ReturnType<typeof seedBinding>>, owner: string) {
    const result = await adminPool.query<{ runtime_version_hash: string }>(
      `SELECT runtime_version_hash FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND integration_id=$2 AND status='queued' ORDER BY created_at LIMIT 1`,
      [binding.tenantId, binding.id],
    );
    const lease = await executionStore.claim(claimBinding(binding), owner, result.rows[0]!.runtime_version_hash);
    assert.ok(lease);
    return lease;
  }

  function claimBinding(binding: Awaited<ReturnType<typeof seedBinding>>) {
    return { tenantId: binding.tenantId, integrationId: binding.id,
      authorityGeneration: binding.generation,
      executionModeGeneration: binding.executionModeGeneration ?? 0 };
  }

  async function executionIdentity(integrationId: string) {
    const result = await adminPool.query<{ review_execution_mode: "legacy_sync" | "harness_async";
      review_execution_state: "active" | "draining"; execution_mode_generation: string }>(
      `SELECT review_execution_mode,review_execution_state,execution_mode_generation
       FROM pr_agent_harness.integration_bindings WHERE id=$1`,
      [integrationId],
    );
    return { mode: result.rows[0]!.review_execution_mode, state: result.rows[0]!.review_execution_state,
      generation: Number(result.rows[0]!.execution_mode_generation) };
  }

  async function waitForBlockedAuthorityQuery(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await adminPool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
             AND query LIKE '%lock_resumable_legacy_review_execution_authority%'
         ) AS blocked`,
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("legacy dispatch did not block on the execution authority lock");
  }

  async function batchCount(integrationId: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pr_agent_harness.publication_batches WHERE integration_id=$1",
      [integrationId],
    );
    return result.rows[0]!.count;
  }

  async function attachmentCounts(runId: string, batchId: string) {
    const result = await adminPool.query<{ links: number; checkpoints: number }>(
      `SELECT
         (SELECT count(*)::int FROM pr_agent_harness.run_publication_batches
          WHERE run_id=$1 AND batch_id=$2) AS links,
         (SELECT count(*)::int FROM pr_agent_harness.checkpoints
          WHERE run_id=$1 AND publication_batch_id=$2) AS checkpoints`,
      [runId, batchId],
    );
    return result.rows[0]!;
  }

  async function publicationIdentityCounts(integrationId: string) {
    const result = await adminPool.query<{ operations: number; slots: number }>(
      `SELECT
         (SELECT count(*)::int FROM pr_agent_harness.repository_operations WHERE integration_id=$1) AS operations,
         (SELECT count(*)::int FROM pr_agent_harness.publication_slots WHERE integration_id=$1) AS slots`,
      [integrationId],
    );
    return result.rows[0]!;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
