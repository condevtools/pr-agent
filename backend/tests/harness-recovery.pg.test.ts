import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import type { PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import { PublicationControlStore } from "../src/agent-runtime/publication/control.js";
import {
  buildPublicationIdentity,
  PendingPublicationError,
  PgPublicationStore,
  preparePublicationInTransaction,
  PublicationService,
  type PublicationRequest,
} from "../src/agent-runtime/publication/publication.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import {
  firstRecoverablePreparedOperation,
  PgPublicationRecoverySchedule,
} from "../src/agent-runtime/publication/recovery.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!/^harness_test_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a dedicated harness_test_* Docker database");
  }
}

if (!databaseUrl) {
  test.skip("PostgreSQL recovery tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 3 });
  const roleName = `recovery_app_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  let poolA: Pool;
  let poolB: Pool;
  let dbA: RuntimeDatabase;
  let storeA: PgPublicationStore;
  let serviceA: PublicationService;
  let scheduleA: PgPublicationRecoverySchedule;
  let scheduleB: PgPublicationRecoverySchedule;
  let runStore: RunStore;
  let controlStore: PublicationControlStore;
  let nextProviderId = 70_000;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(
      `CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`,
    );
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(
      `GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName}`,
    );
    await adminPool.query(
      `GRANT SELECT ON pr_agent_harness.publication_batch_operations,
       pr_agent_harness.run_publication_batches TO ${roleName}`,
    );
    await adminPool.query(
      `GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.repository_operations,
       pr_agent_harness.publication_slots TO ${roleName}`,
    );
    await adminPool.query(`GRANT INSERT ON pr_agent_harness.audit_logs TO ${roleName}`);

    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    poolA = new Pool({ connectionString: appUrl.toString(), max: 2 });
    poolB = new Pool({ connectionString: appUrl.toString(), max: 2 });
    dbA = new RuntimeDatabase(poolA);
    storeA = new PgPublicationStore(dbA);
    serviceA = new PublicationService(storeA);
    scheduleA = new PgPublicationRecoverySchedule(dbA, {
      claimTtlMs: 30_000,
      initialBackoffMs: 1_000,
      maxBackoffMs: 50_000,
      maxAttempts: 5,
    });
    scheduleB = new PgPublicationRecoverySchedule(new RuntimeDatabase(poolB), {
      claimTtlMs: 30_000,
      initialBackoffMs: 1_000,
      maxBackoffMs: 50_000,
      maxAttempts: 5,
    });
    const adminDb = new RuntimeDatabase(adminPool);
    runStore = new RunStore(adminDb);
    controlStore = new PublicationControlStore(adminDb);
  });

  after(async () => {
    await poolB?.end();
    await poolA?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("separate runtime connections claim an operation once and enforce generation", async () => {
    const fixture = await createUnknown("claim-once");
    const [left, right] = await Promise.all([
      scheduleA.claim(fixture.binding, "worker-a", 10),
      scheduleB.claim(fixture.binding, "worker-b", 10),
    ]);
    assert.equal(left.length + right.length, 1);
    const claimed = [...left, ...right][0]!;
    assert.equal(
      (await scheduleA.claim({ ...fixture.binding, generation: 2 }, "wrong-generation", 10)).length,
      0,
    );
    assert.equal(await scheduleA.finish(claimed), "scheduled");
  });

  test("expired claims can be reclaimed and the old claim is version-fenced", async () => {
    const fixture = await createUnknown("claim-expiry");
    const first = (await scheduleA.claim(fixture.binding, "old-worker", 1))[0]!;
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET reconcile_claim_expires_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [fixture.binding.tenantId, fixture.operationId],
    );
    const second = (await scheduleB.claim(fixture.binding, "new-worker", 1))[0]!;
    assert.ok(second.claimVersion > first.claimVersion);
    assert.equal(await scheduleA.finish(first), "lost");
    assert.equal(await scheduleB.finish(second), "scheduled");
  });

  test("database-time backoff reaches manual review on the fifth unknown scan without dispatch", async () => {
    const fixture = await createUnknown("unknown-exhaustion");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (attempt > 1) await makeDue(fixture.binding.tenantId, fixture.operationId);
      const claim = (await scheduleA.claim(fixture.binding, `unknown-${attempt}`, 1))[0]!;
      const outcome = await scheduleA.finish(claim);
      assert.equal(outcome, attempt === 5 ? "manual_review" : "scheduled");
      if (attempt === 1) {
        const timing = await recoveryRow(fixture.binding.tenantId, fixture.operationId);
        assert.ok(timing.delay_ms >= 999 && timing.delay_ms <= 1_001);
      }
    }
    const operation = await operationRow(fixture.binding.tenantId, fixture.operationId);
    assert.equal(operation.status, "manual_review");
    assert.equal(operation.reconcile_attempt_count, 5);
    assert.equal(operation.attempt_count, 1);
    assert.equal(operation.last_error_code, "reconcile_attempts_exhausted");
  });

  test("prepared preflight scheduling backs off and exhausts without a dispatch claim", async () => {
    const fixture = await createPrepared("prepared-exhaustion");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (attempt > 1) await makeDue(fixture.binding.tenantId, fixture.operationId);
      const claim = await scheduleA.claimPrepared(
        fixture.binding,
        fixture.operationId,
        `prepared-${attempt}`,
      );
      assert.ok(claim);
      const outcome = await scheduleA.finishPrepared(claim!);
      assert.equal(outcome, attempt === 5 ? "manual_review" : "scheduled");
    }
    const operation = await operationRow(fixture.binding.tenantId, fixture.operationId);
    assert.equal(operation.status, "manual_review");
    assert.equal(operation.reconcile_attempt_count, 5);
    assert.equal(operation.attempt_count, 0);
    assert.equal(operation.last_error_code, "preflight_attempts_exhausted");
  });

  test("crashed workers still consume the durable budget and the next claim exits manual", async () => {
    const unknown = await createUnknown("crash-budget-unknown");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = (await scheduleA.claim(unknown.binding, `crashed-unknown-${attempt}`, 1))[0];
      assert.ok(claim);
      await expireClaim(unknown.binding.tenantId, unknown.operationId);
    }
    assert.deepEqual(
      await scheduleA.claim(unknown.binding, "unknown-after-budget", 1),
      [],
    );
    const exhaustedUnknown = await operationRow(unknown.binding.tenantId, unknown.operationId);
    assert.equal(exhaustedUnknown.status, "manual_review");
    assert.equal(exhaustedUnknown.reconcile_attempt_count, 5);
    assert.equal(exhaustedUnknown.attempt_count, 1);

    const prepared = await createPrepared("crash-budget-prepared");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await scheduleA.claimPrepared(
        prepared.binding,
        prepared.operationId,
        `crashed-prepared-${attempt}`,
      );
      assert.ok(claim);
      await expireClaim(prepared.binding.tenantId, prepared.operationId);
    }
    assert.equal(
      await scheduleA.claimPrepared(
        prepared.binding,
        prepared.operationId,
        "prepared-after-budget",
      ),
      undefined,
    );
    const exhaustedPrepared = await operationRow(prepared.binding.tenantId, prepared.operationId);
    assert.equal(exhaustedPrepared.status, "manual_review");
    assert.equal(exhaustedPrepared.reconcile_attempt_count, 5);
    assert.equal(exhaustedPrepared.attempt_count, 0);
  });

  test("manual authorize retry resets recovery schedule and stale claim state", async () => {
    const fixture = await createUnknown("manual-retry-reset");
    const unknown = (await storeA.get(fixture.binding.tenantId, fixture.operationId))!;
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET dispatched_at = now() - interval '3 minutes'
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [fixture.binding.tenantId, fixture.operationId],
    );
    const confirmation = await controlStore.apply({
      tenantId: fixture.binding.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: unknown.version,
      commandKey: "recovery-confirm-absent",
      decision: "confirm_not_occurred",
      actor: { type: "user", id: "recovery-admin" },
      evidence: { kind: "provider_confirmation", reference: "provider-search:absent" },
    });
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET reconcile_attempt_count = 4,
           next_reconcile_at = now() + interval '50 seconds',
           reconcile_claim_owner = 'stale-worker',
           reconcile_claim_version = reconcile_claim_version + 1,
           reconcile_claim_expires_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [fixture.binding.tenantId, fixture.operationId],
    );
    await controlStore.apply({
      tenantId: fixture.binding.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: confirmation.resultingVersion,
      commandKey: "recovery-authorize-retry",
      decision: "authorize_retry",
      actor: { type: "user", id: "recovery-admin" },
      evidence: { kind: "provider_confirmation", reference: "provider-search:absent" },
    });
    const operation = await operationRow(fixture.binding.tenantId, fixture.operationId);
    assert.equal(operation.status, "prepared");
    assert.equal(operation.reconcile_attempt_count, 0);
    assert.equal(operation.next_reconcile_at, null);
    assert.equal(operation.reconcile_claim_owner, null);
    assert.equal(operation.reconcile_claim_expires_at, null);
  });

  test("an earlier unknown operation prevents claiming a later prepared batch member", async () => {
    const first = await createUnknown("ordered-batch-head");
    const secondRequest: PublicationRequest = {
      ...first.request,
      slot: "labels",
      payload: { labels: ["bug"] },
    };
    const secondIdentity = buildPublicationIdentity(secondRequest);
    await dbA.transaction(first.binding.tenantId, (client) =>
      preparePublicationInTransaction(client, secondIdentity));
    const batch = {
      id: randomUUID(),
      scope: first.request.scope,
      sourceKey: "ordered-batch-head",
      sourceHash: "d".repeat(64),
      status: "pending" as const,
      operations: [
        { ordinal: 0, businessOperationId: first.operationId, request: first.request },
        { ordinal: 1, businessOperationId: secondIdentity.businessOperationId, request: secondRequest },
      ],
    };
    const recoverable = await firstRecoverablePreparedOperation(
      (tenantId, operationId) => storeA.get(tenantId, operationId),
      first.binding,
      batch,
    );
    assert.equal(recoverable, undefined);
    const later = await operationRow(first.binding.tenantId, secondIdentity.businessOperationId);
    assert.equal(later.status, "prepared");
    assert.equal(later.attempt_count, 0);
  });

  async function createUnknown(suffix: string) {
    const fixture = await createBinding(suffix);
    const identity = buildPublicationIdentity(fixture.request);
    await assert.rejects(
      serviceA.publish(fixture.request, {
        dispatch: async () => { throw new Error("response lost after write"); },
        find: async () => null,
      }),
      PendingPublicationError,
    );
    return { ...fixture, operationId: identity.businessOperationId };
  }

  async function createPrepared(suffix: string) {
    const fixture = await createBinding(suffix);
    const identity = buildPublicationIdentity(fixture.request);
    await dbA.transaction(fixture.binding.tenantId, (client) =>
      preparePublicationInTransaction(client, identity));
    return { ...fixture, operationId: identity.businessOperationId };
  }

  async function createBinding(suffix: string): Promise<{
    binding: PublicationBinding;
    request: PublicationRequest;
  }> {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    const providerRepositoryId = nextProviderId++;
    const providerActorId = nextProviderId++;
    await runStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: `acme/recovery-${suffix}`,
    });
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET provider_repository_id=$3,provider_actor_id=$4,credential_ref='env:GITHUB_TOKEN',
           publication_state='active',publication_generation=1,
           quiescence_receipt='{"verified":true}'::jsonb
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId, String(providerRepositoryId), String(providerActorId)],
    );
    const binding: PublicationBinding = {
      id: integrationId,
      tenantId,
      platform: "github",
      origin: "https://github.example.test",
      repository: `acme/recovery-${suffix}`,
      providerRepositoryId,
      providerActorId,
      credentialRef: "env:GITHUB_TOKEN",
      generation: 1,
      version: 0,
      state: "active",
    };
    return {
      binding,
      request: {
        scope: {
          tenantId,
          integrationId,
          platform: "github",
          origin: binding.origin,
          repository: binding.repository,
          target: "pull:42",
          revision: "head-sha",
          authorityGeneration: 1,
        },
        slot: "review-report",
        payload: { body: `recovery-${suffix}` },
      },
    };
  }

  async function makeDue(tenantId: string, operationId: string): Promise<void> {
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET next_reconcile_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [tenantId, operationId],
    );
  }

  async function expireClaim(tenantId: string, operationId: string): Promise<void> {
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET reconcile_claim_expires_at=now()-interval '1 second',next_reconcile_at=NULL
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, operationId],
    );
  }

  async function recoveryRow(tenantId: string, operationId: string) {
    const result = await adminPool.query<{
      delay_ms: number;
    }>(
      `SELECT EXTRACT(EPOCH FROM (next_reconcile_at - updated_at))*1000 AS delay_ms
       FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, operationId],
    );
    return { delay_ms: Number(result.rows[0]!.delay_ms) };
  }

  async function operationRow(tenantId: string, operationId: string) {
    const result = await adminPool.query<{
      status: string;
      attempt_count: number;
      reconcile_attempt_count: number;
      last_error_code: string | null;
      next_reconcile_at: Date | null;
      reconcile_claim_owner: string | null;
      reconcile_claim_expires_at: Date | null;
    }>(
      `SELECT status,attempt_count,reconcile_attempt_count,last_error_code,
              next_reconcile_at,reconcile_claim_owner,reconcile_claim_expires_at
       FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, operationId],
    );
    return result.rows[0]!;
  }
}
