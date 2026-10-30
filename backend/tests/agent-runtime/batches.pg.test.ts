import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";

import {
  PublicationBatchCoordinator,
  PublicationBatchScopeConflictError,
  PublicationBatchSourceConflictError,
  PublicationBatchStore,
} from "../../src/agent-runtime/publication/batches.js";
import {
  PendingPublicationError,
  buildPublicationIdentity,
  PgPublicationStore,
  PublicationDefiniteFailureError,
  PublicationService,
  PublicationSlotConflictError,
  StalePublicationError,
  type PublicationAdapter,
  type PublicationRequest,
} from "../../src/agent-runtime/publication/publication.js";
import { PgPublicationRecoverySchedule } from "../../src/agent-runtime/publication/recovery.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!/^harness_test_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a dedicated harness_test_* Docker database");
  }
}

if (!databaseUrl) {
  test.skip("PostgreSQL publication batch tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const roleName = `batch_app_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  let pool: Pool;
  let batchStore: PublicationBatchStore;
  let operationStore: PgPublicationStore;
  let controlRunStore: RunStore;
  let appDb: RuntimeDatabase;
  let nextProviderId = 1000;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid, uuid, text, text, text, bigint) TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid) TO ${roleName}`);
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.repository_operations, pr_agent_harness.publication_slots, pr_agent_harness.publication_batches TO ${roleName}`);
    await adminPool.query(`GRANT SELECT, INSERT, DELETE ON pr_agent_harness.publication_batch_operations TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,UPDATE ON pr_agent_harness.agent_runs,pr_agent_harness.job_queue TO ${roleName}`);
    await adminPool.query(`GRANT SELECT,INSERT ON pr_agent_harness.checkpoints,pr_agent_harness.run_publication_batches,pr_agent_harness.run_events TO ${roleName}`);
    await adminPool.query(`GRANT INSERT ON pr_agent_harness.audit_logs TO ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    pool = new Pool({ connectionString: appUrl.toString(), max: 12 });
    appDb = new RuntimeDatabase(pool);
    batchStore = new PublicationBatchStore(appDb);
    operationStore = new PgPublicationStore(appDb);
    controlRunStore = new RunStore(new RuntimeDatabase(adminPool));
  });

  after(async () => {
    await pool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("freeze is durable and repeated source delivery returns the original full batch", async () => {
    const first = await createScope("repeat");
    const input = {
      runLease: first.lease,
      scope: first.scope,
      sourceKey: "webhook:delivery-1",
      sourceHash: hash("delivery-1"),
      operations: [
        { slot: "summary", payload: { body: "original" } },
        { slot: "labels", payload: { labels: ["bug"] } },
      ],
    };
    const frozenCopies = await Promise.all(
      Array.from({ length: 5 }, () => batchStore.freeze(input)),
    );
    const frozen = frozenCopies[0]!;
    assert.equal(new Set(frozenCopies.map(({ id }) => id)).size, 1);
    assert.equal(
      await adminPool.query(
        "SELECT count(*)::integer AS count FROM pr_agent_harness.repository_operations WHERE tenant_id = $1 AND status <> 'prepared'",
        [first.scope.tenantId],
      ).then(({ rows }) => rows[0]?.count),
      0,
    );
    input.operations[0]!.payload.body = "caller-mutated";

    const repeated = await batchStore.freeze({
      ...input,
      operations: [{ slot: "ignored", payload: { body: "new model output" } }],
    });
    assert.equal(repeated.id, frozen.id);
    assert.equal(repeated.operations.length, 2);
    assert.deepEqual(repeated.operations[0]?.request.payload, { body: "original" });
    assert.equal(Object.isFrozen(repeated.operations[0]?.request.payload), true);
    assert.deepEqual(
      await batchStore.findBySource(first.scope, input.sourceKey, input.sourceHash),
      repeated,
    );
    const afterHeadMoved = await batchStore.findBySource(
      { ...first.scope, revision: "new-head-after-response-loss" },
      input.sourceKey,
      input.sourceHash,
    );
    assert.equal(afterHeadMoved?.scope.revision, "head-sha");
    await assert.rejects(
      batchStore.findBySource(
        { ...first.scope, target: "pull:99" },
        input.sourceKey,
        input.sourceHash,
      ),
      PublicationBatchScopeConflictError,
    );

    await assert.rejects(
      batchStore.findBySource(first.scope, input.sourceKey, hash("different")),
      PublicationBatchSourceConflictError,
    );
  });

  test("domain authorization runs after sealing for new and reused batches and rolls back denied freezes", async () => {
    const { scope, lease } = await createScope("domain-authorization");
    const input = { runLease: lease, scope, sourceKey: "domain:authorization", sourceHash: hash("authorization"),
      operations: [{ slot: "one", payload: { body: "one" } }] };
    let calls = 0;
    await assert.rejects(batchStore.freeze({ ...input, authorize: async (client, batch) => {
      calls++;
      const row = await client.query("SELECT seal_state FROM pr_agent_harness.publication_batches WHERE tenant_id=$1 AND id=$2", [scope.tenantId,batch.id]);
      assert.equal(row.rows[0]?.seal_state, "sealed");
      throw new Error("approval revoked");
    } }), /approval revoked/);
    assert.equal(await batchStore.findBySource(scope,input.sourceKey,input.sourceHash), undefined);
    const operations = await adminPool.query("SELECT 1 FROM pr_agent_harness.repository_operations WHERE tenant_id=$1", [scope.tenantId]);
    assert.equal(operations.rowCount, 0);
    const first = await batchStore.freeze({ ...input, authorize: async () => { calls++; } });
    const second = await batchStore.freeze({ ...input, authorize: async () => { calls++; } });
    assert.equal(first.id, second.id);
    assert.equal(calls, 3);
    await assert.rejects(batchStore.freeze({ ...input, authorize: async () => { throw new Error("replay denied"); } }), /replay denied/);
  });

  test("all operation slots and links roll back when one member cannot freeze", async () => {
    const { scope, lease } = await createScope("atomic");
    await assert.rejects(
      batchStore.freeze({
        runLease: lease,
        scope,
        sourceKey: "webhook:atomic",
        sourceHash: hash("atomic"),
        operations: [
          { slot: "same-slot", payload: { body: "one" } },
          { slot: "same-slot", payload: { body: "two" } },
        ],
      }),
      PublicationSlotConflictError,
    );
    assert.equal(
      await batchStore.findBySource(scope, "webhook:atomic", hash("atomic")),
      undefined,
    );
    const operations = await adminPool.query(
      "SELECT 1 FROM pr_agent_harness.repository_operations WHERE tenant_id = $1",
      [scope.tenantId],
    );
    assert.equal(operations.rowCount, 0);
  });

  test("recovery skips completed members and reconciles an unknown member", async () => {
    const { scope, lease } = await createScope("recover");
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:recover",
      sourceHash: hash("recover"),
      operations: [
        { slot: "first", payload: { body: "first" } },
        { slot: "second", payload: { body: "second" } },
      ],
    });
    const coordinator = new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    );
    const dispatches = new Map<string, number>();
    let lostMarker: string | undefined;
    const adapterFactory = async (operation: { slot: string }): Promise<PublicationAdapter> => ({
      dispatch: async (marker) => {
        dispatches.set(operation.slot, (dispatches.get(operation.slot) ?? 0) + 1);
        if (operation.slot === "second") {
          lostMarker = marker;
          throw new Error("response lost");
        }
        return { id: "remote-first" };
      },
      find: async (marker) => marker === lostMarker ? { id: "remote-second" } : null,
    });

    const waiting = await coordinator.execute(scope.tenantId, batch.id, adapterFactory, lease);
    assert.equal(waiting.status, "waiting_reconciliation");
    assert.deepEqual(Object.fromEntries(dispatches), { first: 1, second: 1 });
    assert.deepEqual(
      (await batchStore.listRecoverable(scope.tenantId, scope.integrationId, 10)).map(({ id }) => id),
      [],
    );

    const complete = await coordinator.execute(scope.tenantId, batch.id, adapterFactory, lease);
    assert.equal(complete.status, "succeeded");
    assert.deepEqual(Object.fromEntries(dispatches), { first: 1, second: 1 });
    assert.equal(
      (await batchStore.listRecoverable(scope.tenantId, scope.integrationId, 10)).length,
      0,
    );
  });

  test("Run-linked prepared dispatch requires its live lease and P0a recovery excludes the batch", async () => {
    const fixture = await createRunLinkedBatch("run-fenced");
    const coordinator = new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    );
    let dispatches = 0;
    const adapters = async (): Promise<PublicationAdapter> => ({
      dispatch: async () => ({ id: `remote-${++dispatches}` }),
      find: async () => null,
    });
    assert.deepEqual(
      await batchStore.listRecoverable(
        fixture.scope.tenantId,
        fixture.scope.integrationId,
        10,
      ),
      [],
    );
    await assert.rejects(
      coordinator.execute(fixture.scope.tenantId, fixture.batch.id, adapters),
      /requires an active Run lease/,
    );
    assert.equal(dispatches, 0);
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET lease_expires_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND id=$2`,
      [fixture.lease.tenantId, fixture.lease.runId],
    );
    await assert.rejects(
      coordinator.execute(fixture.scope.tenantId, fixture.batch.id, adapters, fixture.lease),
      { name: "RunLeaseLostError" },
    );
    assert.equal(dispatches, 0);

    const cancelled = await createRunLinkedBatch("run-cancelled");
    assert.equal(
      buildPublicationIdentity(cancelled.batch.operations[0]!.request).businessOperationId,
      buildPublicationIdentity({
        ...cancelled.batch.operations[0]!.request,
        executionLease: cancelled.lease,
      }).businessOperationId,
    );
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs SET cancel_requested_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [cancelled.lease.tenantId, cancelled.lease.runId],
    );
    await assert.rejects(
      coordinator.execute(cancelled.scope.tenantId, cancelled.batch.id, adapters, cancelled.lease),
      { name: "RunLeaseLostError" },
    );
    assert.equal(dispatches, 0);
  });

  test("Run-linked unknown publication still reconciles without reviving the Run", async () => {
    const fixture = await createRunLinkedBatch("run-reconcile");
    const operationId = fixture.batch.operations[0]!.businessOperationId;
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='unknown',attempt_count=1,dispatched_at=now(),
           last_error_code='response_lost',version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.scope.tenantId, operationId],
    );
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET cancel_requested_at=now(),status='cancelled',lease_owner=NULL,
           lease_expires_at=NULL,finished_at=now(),version=version+1
       WHERE tenant_id=$1 AND id=$2`,
      [fixture.lease.tenantId, fixture.lease.runId],
    );
    let dispatches = 0;
    const result = await new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    ).execute(fixture.scope.tenantId, fixture.batch.id, async () => ({
      dispatch: async () => ({ id: `forbidden-${++dispatches}` }),
      find: async () => ({ id: "reconciled-remote" }),
    }));
    assert.equal(result.status, "succeeded");
    assert.equal(dispatches, 0);
    assert.equal((await operationStore.get(fixture.scope.tenantId, operationId))?.remoteId,
      "reconciled-remote");
    const run = await adminPool.query<{ status: string }>(
      "SELECT status FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
      [fixture.lease.tenantId, fixture.lease.runId],
    );
    assert.equal(run.rows[0]?.status, "cancelled");
  });

  test("active Run dispatch is not reconciled by concurrent batch execution", async () => {
    const fixture = await createRunLinkedBatch("active-dispatch-direct");
    const request = {
      ...fixture.batch.operations[0]!.request,
      executionLease: fixture.lease,
    };
    let releaseDispatch!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const service = new PublicationService(operationStore);
    const publishing = service.publish(request, {
      dispatch: async () => {
        markStarted();
        await released;
        return { id: "active-dispatch-remote" };
      },
      find: async () => null,
    });
    await started;

    let reconciliationReads = 0;
    const concurrent = await new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    ).execute(fixture.scope.tenantId, fixture.batch.id, async () => ({
      dispatch: async () => ({ id: "must-not-dispatch" }),
      find: async () => {
        reconciliationReads += 1;
        return null;
      },
    }));
    assert.equal(concurrent.status, "waiting_reconciliation");
    releaseDispatch();
    const result = await publishing;
    assert.equal(result.remoteId, "active-dispatch-remote");
    assert.equal(reconciliationReads, 0);
  });

  test("Recovery cannot claim an in-flight operation owned by a live Run lease", async () => {
    const fixture = await createRunLinkedBatch("active-dispatch-recovery");
    const request = {
      ...fixture.batch.operations[0]!.request,
      executionLease: fixture.lease,
    };
    let releaseDispatch!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const service = new PublicationService(operationStore);
    const publishing = service.publish(request, {
      dispatch: async () => {
        markStarted();
        await released;
        return { id: "recovery-fenced-remote" };
      },
      find: async () => null,
    });
    await started;

    const schedule = new PgPublicationRecoverySchedule(appDb);
    const claims = await schedule.claim({
      id: fixture.scope.integrationId,
      tenantId: fixture.scope.tenantId,
      platform: fixture.scope.platform,
      origin: fixture.scope.origin,
      repository: fixture.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: fixture.scope.authorityGeneration!,
      version: 0,
      state: "active",
    }, "recovery-during-dispatch", 10);
    releaseDispatch();
    const settled = await publishing.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    assert.equal(claims.length, 0);
    assert.equal(settled.status, "fulfilled");
  });

  test("Recovery can claim a crashed dispatch after both the Run lease and deadline expire", async () => {
    const fixture = await createRunLinkedBatch("expired-dispatch-recovery");
    const operationId = fixture.batch.operations[0]!.businessOperationId;
    const prepared = await operationStore.prepareAndClaim({
      ...buildPublicationIdentity(fixture.batch.operations[0]!.request),
      executionLease: fixture.lease,
    });
    assert.equal(prepared.action, "dispatch");
    const schedule = new PgPublicationRecoverySchedule(appDb);
    const binding = {
      id: fixture.scope.integrationId,
      tenantId: fixture.scope.tenantId,
      platform: fixture.scope.platform,
      origin: fixture.scope.origin,
      repository: fixture.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: fixture.scope.authorityGeneration!,
      version: 0,
      state: "active" as const,
    };
    assert.equal((await schedule.claim(binding, "recovery-before-expiry", 10)).length, 0);

    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET lease_expires_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND id=$2`,
      [fixture.lease.tenantId, fixture.lease.runId],
    );
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET next_reconcile_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.scope.tenantId, operationId],
    );
    const claims = await schedule.claim(binding, "recovery-after-expiry", 10);
    assert.deepEqual(claims.map(({ businessOperationId }) => businessOperationId), [operationId]);
  });

  test("a stale lease snapshot cannot shorten the provider dispatch deadline", async () => {
    const fixture = await createRunLinkedBatch("stale-lease-provider-deadline");
    const operationId = fixture.batch.operations[0]!.businessOperationId;
    const staleLease = {
      ...fixture.lease,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const prepared = await operationStore.prepareAndClaim({
      ...buildPublicationIdentity(fixture.batch.operations[0]!.request),
      executionLease: staleLease,
      reconciliationGraceMs: 60_000,
    });
    assert.equal(prepared.action, "dispatch");
    const deadline = await adminPool.query<{ protected: boolean }>(
      `SELECT next_reconcile_at > now()+interval '30 seconds' AS protected
       FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.scope.tenantId, operationId],
    );
    assert.equal(deadline.rows[0]?.protected, true);
    await adminPool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET lease_expires_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND id=$2`,
      [fixture.lease.tenantId, fixture.lease.runId],
    );

    let reconciliationReads = 0;
    const adapter = {
      reconciliationGraceMs: 60_000,
      dispatch: async () => ({ id: "must-not-dispatch" }),
      find: async () => {
        reconciliationReads += 1;
        return null;
      },
    };
    const service = new PublicationService(operationStore);
    await assert.rejects(
      service.reconcileOperation(fixture.scope.tenantId, operationId, adapter),
      PendingPublicationError,
    );
    const batch = await new PublicationBatchCoordinator(batchStore, service).execute(
      fixture.scope.tenantId,
      fixture.batch.id,
      async () => adapter,
    );
    assert.equal(batch.status, "waiting_reconciliation");
    const schedule = new PgPublicationRecoverySchedule(appDb);
    const claims = await schedule.claim({
      id: fixture.scope.integrationId,
      tenantId: fixture.scope.tenantId,
      platform: fixture.scope.platform,
      origin: fixture.scope.origin,
      repository: fixture.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: fixture.scope.authorityGeneration!,
      version: 0,
      state: "active",
    }, "recovery-before-provider-deadline", 10);
    assert.equal(claims.length, 0);
    assert.equal(reconciliationReads, 0);
  });

  test("an exhausted recovery claim cannot manual-review an active Run dispatch", async () => {
    const fixture = await createRunLinkedBatch("active-run-exhausted-recovery");
    const operationId = fixture.batch.operations[0]!.businessOperationId;
    const prepared = await operationStore.prepareAndClaim({
      ...buildPublicationIdentity(fixture.batch.operations[0]!.request),
      executionLease: fixture.lease,
    });
    assert.equal(prepared.action, "dispatch");
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET reconcile_attempt_count=5,reconcile_claim_owner='crashed-recovery',
           reconcile_claim_expires_at=now()-interval '1 second',
           next_reconcile_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.scope.tenantId, operationId],
    );
    const schedule = new PgPublicationRecoverySchedule(appDb, { maxAttempts: 5 });
    const claims = await schedule.claim({
      id: fixture.scope.integrationId,
      tenantId: fixture.scope.tenantId,
      platform: fixture.scope.platform,
      origin: fixture.scope.origin,
      repository: fixture.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: fixture.scope.authorityGeneration!,
      version: 0,
      state: "active",
    }, "recovery-exhausted-live-run", 10);
    assert.equal(claims.length, 0);
    const operation = await operationStore.get(fixture.scope.tenantId, operationId);
    assert.equal(operation?.status, "in_flight");
  });

  test("unknown operation remains reconcilable while its Run lease is live", async () => {
    const fixture = await createRunLinkedBatch("active-run-unknown");
    const operationId = fixture.batch.operations[0]!.businessOperationId;
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='unknown',attempt_count=1,dispatched_at=now(),
           last_error_code='response_lost',version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.scope.tenantId, operationId],
    );
    let reconciliationReads = 0;
    const result = await new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    ).execute(fixture.scope.tenantId, fixture.batch.id, async () => ({
      dispatch: async () => ({ id: "must-not-dispatch" }),
      find: async () => {
        reconciliationReads += 1;
        return { id: "active-run-reconciled" };
      },
    }));
    assert.equal(result.status, "succeeded");
    assert.equal(reconciliationReads, 1);
  });

  test("attaching a batch waits on operations before taking the batch lock", async () => {
    const fixture = await createRunLinkedBatch("attach-lock-order");
    const operationId = fixture.batch.operations[0]!.businessOperationId;
    const blocker = await adminPool.connect();
    const probe = await adminPool.connect();
    let releaseBlocker = true;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT business_operation_id
         FROM pr_agent_harness.repository_operations
         WHERE tenant_id=$1 AND business_operation_id=$2
         FOR UPDATE`,
        [fixture.scope.tenantId, operationId],
      );
      const attaching = batchStore.attachExistingBatchToRun(fixture.lease, fixture.batch.id);
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const activity = await probe.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%FOR UPDATE OF ro%'
           ) AS waiting`,
        );
        if (activity.rows[0]?.waiting) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      assert.equal(blocked, true, "attach did not reach the operation lock barrier");

      await probe.query("BEGIN");
      await probe.query(
        `SELECT id FROM pr_agent_harness.publication_batches
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT`,
        [fixture.scope.tenantId, fixture.batch.id],
      );
      await probe.query("ROLLBACK");
      await blocker.query("COMMIT");
      releaseBlocker = false;
      assert.equal((await attaching).id, fixture.batch.id);
    } finally {
      if (releaseBlocker) await blocker.query("ROLLBACK").catch(() => undefined);
      await probe.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      probe.release();
    }
  });

  test("provider grace starts after a blocked claim acquires its final lock", async () => {
    const { scope, lease } = await createScope("claim-lock-wait-deadline");
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:claim-lock-wait-deadline",
      sourceHash: hash("claim-lock-wait-deadline"),
      operations: [{ slot: "summary", payload: { body: "lock-wait" } }],
    });
    const input = {
      ...buildPublicationIdentity(batch.operations[0]!.request),
      executionLease: lease,
      reconciliationGraceMs: 1_000,
    };
    const blocker = await adminPool.connect();
    const probe = await adminPool.connect();
    let claiming: ReturnType<PgPublicationStore["prepareAndClaim"]> | undefined;
    let releaseBlocker = true;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT active_business_operation_id
         FROM pr_agent_harness.publication_slots
         WHERE tenant_id=$1 AND integration_id=$2 AND target=$3 AND publication_slot=$4
         FOR UPDATE`,
        [scope.tenantId, scope.integrationId, scope.target, input.slot],
      );
      claiming = operationStore.prepareAndClaim(input);
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const activity = await probe.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND query LIKE '%publication_slots%'
           ) AS waiting`,
        );
        if (activity.rows[0]?.waiting) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      assert.equal(blocked, true, "claim did not reach the publication-slot lock barrier");
      await delay(1_200);
      await blocker.query("COMMIT");
      releaseBlocker = false;
      assert.equal((await claiming).action, "dispatch");
      const deadline = await probe.query<{ protected: boolean }>(
        `SELECT next_reconcile_at > clock_timestamp() AS protected
         FROM pr_agent_harness.repository_operations
         WHERE tenant_id=$1 AND business_operation_id=$2`,
        [scope.tenantId, input.businessOperationId],
      );
      assert.equal(deadline.rows[0]?.protected, true);
      assert.equal((await operationStore.prepareAndClaim(input)).action, "pending");
    } finally {
      if (releaseBlocker) await blocker.query("ROLLBACK").catch(() => undefined);
      await claiming?.catch(() => undefined);
      blocker.release();
      probe.release();
    }
  });

  test("draining blocks a new freeze but preserves tenant-scoped load and resolution", async () => {
    const { scope, lease } = await createScope("draining");
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:draining",
      sourceHash: hash("draining"),
      operations: [{ slot: "summary", payload: { body: "saved" } }],
    });
    await adminPool.query(
      "UPDATE pr_agent_harness.integration_bindings SET publication_state = 'draining' WHERE tenant_id = $1 AND id = $2",
      [scope.tenantId, scope.integrationId],
    );
    await assert.rejects(
      batchStore.freeze({
        runLease: lease,
        scope,
        sourceKey: "webhook:new-during-drain",
        sourceHash: hash("new-during-drain"),
        operations: [{ slot: "other", payload: { body: "blocked" } }],
      }),
      { name: "InactiveIntegrationBindingError" },
    );
    assert.equal((await batchStore.load(scope.tenantId, batch.id))?.id, batch.id);
    assert.equal((await batchStore.refreshOutcome(scope.tenantId, batch.id))?.status, "pending");
    assert.equal(await batchStore.load(randomUUID(), batch.id), undefined);
  });

  test("sealed membership, payload, and batch identity reject application mutation", async () => {
    const { scope, lease } = await createScope("sealed");
    const first = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:sealed-first",
      sourceHash: hash("sealed-first"),
      operations: [{ slot: "first", payload: { body: "immutable" } }],
    });
    const second = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:sealed-second",
      sourceHash: hash("sealed-second"),
      operations: [{ slot: "second", payload: { body: "other" } }],
    });
    const seal = await adminPool.query<{
      seal_state: string;
      operation_count: number;
      operation_set_hash: string;
    }>(
      "SELECT seal_state, operation_count, operation_set_hash FROM pr_agent_harness.publication_batches WHERE id = $1",
      [first.id],
    );
    assert.equal(seal.rows[0]?.seal_state, "sealed");
    assert.equal(seal.rows[0]?.operation_count, 1);
    assert.match(seal.rows[0]?.operation_set_hash ?? "", /^[0-9a-f]{64}$/);

    await assert.rejects(
      appDb.transaction(scope.tenantId, (client) => client.query(
        `INSERT INTO pr_agent_harness.publication_batch_operations
           (tenant_id, batch_id, ordinal, business_operation_id)
         VALUES ($1, $2, 1, $3)`,
        [scope.tenantId, first.id, second.operations[0]!.businessOperationId],
      )),
      /sealed publication batch membership is immutable/,
    );
    await assert.rejects(
      appDb.transaction(scope.tenantId, (client) => client.query(
        `UPDATE pr_agent_harness.repository_operations
         SET payload_json = '{"body":"tampered"}'::jsonb
         WHERE tenant_id = $1 AND business_operation_id = $2`,
        [scope.tenantId, first.operations[0]!.businessOperationId],
      )),
      /sealed publication operation identity and payload are immutable/,
    );
    await assert.rejects(
      appDb.transaction(scope.tenantId, (client) => client.query(
        `DELETE FROM pr_agent_harness.publication_batch_operations
         WHERE tenant_id = $1 AND batch_id = $2 AND ordinal = 0`,
        [scope.tenantId, first.id],
      )),
      /sealed publication batch membership is immutable/,
    );
    await assert.rejects(
      appDb.transaction(scope.tenantId, (client) => client.query(
        "UPDATE pr_agent_harness.publication_batches SET source_key = 'tampered' WHERE tenant_id = $1 AND id = $2",
        [scope.tenantId, first.id],
      )),
      /sealed publication batch identity is immutable/,
    );
  });

  test("a definite predecessor failure cancels later prepared members before authority rotation", async () => {
    const { scope, lease } = await createScope("predecessor");
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:predecessor",
      sourceHash: hash("predecessor"),
      operations: [
        { slot: "first", payload: { body: "reject" } },
        { slot: "second", payload: { body: "must-not-dispatch" } },
      ],
    });
    let dispatches = 0;
    const result = await new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    ).execute(scope.tenantId, batch.id, async (operation) => ({
      dispatch: async () => {
        dispatches += 1;
        throw new PublicationDefiniteFailureError(
          operation.businessOperationId,
          "provider_rejected",
          422,
        );
      },
      find: async () => null,
    }), lease);
    assert.equal(result.status, "failed_definite");
    assert.equal(dispatches, 1);
    const first = await operationStore.get(scope.tenantId, batch.operations[0]!.businessOperationId);
    const second = await operationStore.get(scope.tenantId, batch.operations[1]!.businessOperationId);
    assert.equal(first?.status, "failed_definite");
    assert.equal(second?.status, "cancelled");
    assert.equal(second?.outcomeCode, "publication_abandoned");
    assert.equal(second?.lastErrorCode, "batch_predecessor_failed");
    assert.equal(
      (await batchStore.listRecoverable(scope.tenantId, scope.integrationId, 10)).length,
      0,
    );

    await adminPool.query(
      "UPDATE pr_agent_harness.integration_bindings SET publication_state = 'blocked' WHERE tenant_id = $1 AND id = $2",
      [scope.tenantId, scope.integrationId],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.integration_bindings SET publication_state = 'active', publication_generation = 2 WHERE tenant_id = $1 AND id = $2",
      [scope.tenantId, scope.integrationId],
    );
    const replacementScope = { ...scope, authorityGeneration: 2 };
    const replacementLease = await createLeaseForScope(replacementScope, "predecessor-replacement");
    const replacement = await batchStore.freeze({
      runLease: replacementLease,
      scope: replacementScope,
      sourceKey: "webhook:predecessor-replacement",
      sourceHash: hash("predecessor-replacement"),
      operations: [
        { slot: "first", payload: { body: "replacement-one" } },
        { slot: "second", payload: { body: "replacement-two" } },
      ],
    });
    assert.equal(replacement.operations.length, 2);
  });

  test("a failed member does not terminalize a batch while another member may have effects", async () => {
    const { scope, lease } = await createScope("mixed-outcome");
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:mixed-outcome",
      sourceHash: hash("mixed-outcome"),
      operations: [
        { slot: "first", payload: { body: "failed" } },
        { slot: "second", payload: { body: "possibly-published" } },
      ],
    });
    await adminPool.query(
      `
        UPDATE pr_agent_harness.repository_operations
        SET status = 'failed_definite', outcome_code = 'rejected', resolved_at = now(),
            last_error_code = 'provider_rejected', version = version + 1
        WHERE tenant_id = $1 AND business_operation_id = $2
      `,
      [scope.tenantId, batch.operations[0]!.businessOperationId],
    );
    await adminPool.query(
      `
        UPDATE pr_agent_harness.repository_operations
        SET status = 'unknown', dispatched_at = now(), last_error_code = 'response_lost',
            version = version + 1
        WHERE tenant_id = $1 AND business_operation_id = $2
      `,
      [scope.tenantId, batch.operations[1]!.businessOperationId],
    );
    const waiting = await batchStore.refreshOutcome(scope.tenantId, batch.id);
    assert.equal(waiting?.status, "waiting_reconciliation");
    assert.equal(
      (await operationStore.get(scope.tenantId, batch.operations[1]!.businessOperationId))?.status,
      "unknown",
    );
    assert.deepEqual(
      (await batchStore.listRecoverable(scope.tenantId, scope.integrationId, 10)).map(({ id }) => id),
      [],
    );
  });

  test("restart treats succeeded stale as terminal and never advances the frozen batch", async () => {
    const { scope, lease } = await createScope("stale-predecessor");
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:stale-predecessor",
      sourceHash: hash("stale-predecessor"),
      operations: [
        { slot: "first", payload: { body: "published-before-head-moved" } },
        { slot: "second", payload: { body: "must-not-dispatch" } },
      ],
    });
    const service = new PublicationService(operationStore);
    let revisionReads = 0;
    await assert.rejects(
      service.publish({ ...batch.operations[0]!.request, executionLease: lease }, {
        dispatch: async () => ({ id: "remote-stale" }),
        find: async () => null,
        currentRevision: async () => ++revisionReads === 1 ? scope.revision : "new-head",
      }),
      StalePublicationError,
    );

    let adaptersConstructed = 0;
    const restarted = await new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    ).execute(scope.tenantId, batch.id, async () => {
      adaptersConstructed += 1;
      return {
        dispatch: async () => ({ id: "must-not-dispatch" }),
        find: async () => null,
      };
    }, lease);
    assert.equal(restarted.status, "failed_definite");
    assert.equal(adaptersConstructed, 0);
    const first = await operationStore.get(scope.tenantId, batch.operations[0]!.businessOperationId);
    const second = await operationStore.get(scope.tenantId, batch.operations[1]!.businessOperationId);
    assert.equal(first?.status, "succeeded");
    assert.equal(first?.outcomeCode, "stale");
    assert.equal(first?.remoteId, "remote-stale");
    assert.equal(second?.status, "cancelled");
  });

  test("a failed batch skips a shared operation without corrupting another batch", async () => {
    const { scope, lease } = await createScope("shared-operation");
    const failedBatch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: "webhook:shared-failed",
      sourceHash: hash("shared-failed"),
      operations: [
        { slot: "first", payload: { body: "reject-this-batch" } },
        { slot: "shared", payload: { body: "shared-publication" } },
      ],
    });
    const sharedOperationId = failedBatch.operations[1]!.businessOperationId;
    const coordinator = new PublicationBatchCoordinator(
      batchStore,
      new PublicationService(operationStore),
    );
    const [failed, validBatch] = await Promise.all([
      coordinator.execute(scope.tenantId, failedBatch.id, async (operation) => ({
        dispatch: async () => {
          throw new PublicationDefiniteFailureError(
            operation.businessOperationId,
            "provider_rejected",
            422,
          );
        },
        find: async () => null,
      }), lease),
      batchStore.freeze({
        runLease: lease,
        scope,
        sourceKey: "webhook:shared-valid",
        sourceHash: hash("shared-valid"),
        operations: [{ slot: "shared", payload: { body: "shared-publication" } }],
      }),
    ]);
    assert.equal(validBatch.operations[0]!.businessOperationId, sharedOperationId);
    assert.equal(failed.status, "failed_definite");
    assert.equal(failed.operations[1]?.skipped, true);
    assert.equal((await operationStore.get(scope.tenantId, sharedOperationId))?.status, "prepared");

    let sharedDispatches = 0;
    const completed = await coordinator.execute(scope.tenantId, validBatch.id, async () => ({
      dispatch: async () => ({ id: `shared-${++sharedDispatches}` }),
      find: async () => null,
    }), lease);
    assert.equal(completed.status, "succeeded");
    assert.equal(sharedDispatches, 1);
    assert.equal(completed.operations[0]?.skipped, false);
    const shared = await operationStore.get(scope.tenantId, sharedOperationId);
    assert.equal(shared?.status, "succeeded");
    assert.equal(shared?.outcomeCode, "current");
    assert.equal((await batchStore.refreshOutcome(scope.tenantId, failedBatch.id))?.status, "failed_definite");
  });

  async function createScope(suffix: string): Promise<{ scope: PublicationRequest["scope"]; lease: RunLease }> {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await controlRunStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: `acme/batch-${suffix}`,
    });
    await adminPool.query(
      `
        UPDATE pr_agent_harness.integration_bindings
        SET publication_state = 'active', publication_generation = 1,
            review_execution_mode = 'harness_async', execution_mode_generation = 1,
            provider_repository_id = $3, provider_actor_id = $4,
            credential_ref = 'env:GITHUB_TOKEN',
            quiescence_receipt = '{"approved":true}'::jsonb
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, integrationId, String(++nextProviderId), String(nextProviderId + 10_000)],
    );
    const scope: PublicationRequest["scope"] = {
      tenantId,
      integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: `acme/batch-${suffix}`,
      target: "pull:42",
      revision: "head-sha",
      authorityGeneration: 1,
    };
    const lease = await createLeaseForScope(scope, suffix);
    return { scope, lease };
  }

  async function createLeaseForScope(scope: PublicationRequest["scope"], suffix: string): Promise<RunLease> {
    const version = hash(`version:${suffix}`);
    await controlRunStore.createRun({
      tenantId: scope.tenantId,
      integrationId: scope.integrationId,
      actorType: "service",
      actorId: "batch-test",
      createScope: "test:publication-batch:v1",
      createKey: suffix,
      requestHash: hash(`request:${suffix}`),
      runType: "review",
      baseSha: "base-sha",
      headSha: scope.revision,
      workflowVersionHash: version,
      promptVersionHash: version,
      modelVersionHash: version,
      toolVersionHash: version,
      policyVersionHash: version,
      runtimeVersionHash: version,
      input: { suffix },
      authorityGeneration: scope.authorityGeneration!,
      executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000 },
    });
    const lease = await new RunExecutionStore(new RuntimeDatabase(adminPool)).claim({
      tenantId: scope.tenantId,
      integrationId: scope.integrationId,
      authorityGeneration: scope.authorityGeneration!,
      executionModeGeneration: 1,
    }, `batch-worker-${suffix}`, version);
    assert.ok(lease);
    return lease;
  }

  async function createRunLinkedBatch(suffix: string): Promise<{
    scope: PublicationRequest["scope"];
    lease: RunLease;
    batch: Awaited<ReturnType<PublicationBatchStore["freeze"]>>;
  }> {
    const { scope, lease } = await createScope(suffix);
    const batch = await batchStore.freeze({
      runLease: lease,
      scope,
      sourceKey: `webhook:${suffix}`,
      sourceHash: hash(`source:${suffix}`),
      operations: [{ slot: "summary", payload: { body: suffix } }],
    });
    return { scope, lease, batch };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
