import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore, type CreateRunInput } from "../../src/agent-runtime/postgres/run-store.js";
import {
  buildPublicationIdentity,
  PgPublicationStore,
  preparePublicationInTransaction,
  type PreparedOperationInput,
  type PublicationRequest,
} from "../../src/agent-runtime/publication/publication.js";
import { PgPublicationRecoverySchedule } from "../../src/agent-runtime/publication/recovery.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Provider-access fencing requires the Docker PostgreSQL test runner", () => {});
} else {
  if (!decodeURIComponent(new URL(databaseUrl).pathname.slice(1)).startsWith("harness_test_")) {
    throw new Error("Disposable harness_test_* database required");
  }

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const role = `provider_access_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const repository = `example/provider-access-${integrationId}`;
  const runtimeHash = hash("provider-access-runtime");
  const binding: PublicationBinding = {
    id: integrationId,
    tenantId,
    platform: "github",
    origin: "https://api.github.com",
    repository,
    providerRepositoryId: 91_001,
    providerActorId: 91_002,
    credentialRef: "github-app:91003",
    generation: 1,
    version: 2,
    state: "active",
    reviewExecutionMode: "harness_async",
    executionModeGeneration: 1,
    reviewExecutionState: "active",
    providerAccessState: "verified",
    providerAccessVersion: 0,
    capabilities: {
      reviewSingle: true,
      reviewDeep: true,
      fix: false,
      evolution: false,
      defaultReviewWorkflow: "review.single.v1",
    },
  };
  let runtimePool: Pool;
  let runtimeDb: RuntimeDatabase;
  let runs: RunStore;
  let publications: PgPublicationStore;
  let recovery: PgPublicationRecoverySchedule;

  before(async () => {
    await admin.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(admin);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`REVOKE INSERT,UPDATE,DELETE ON pr_agent_harness.integration_bindings FROM ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION
      pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint),
      pr_agent_harness.lock_dispatchable_publication_authority(uuid,uuid,text,text,text,bigint),
      pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) TO ${role}`);
    await admin.query(
      `INSERT INTO pr_agent_harness.integration_bindings
        (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
         credential_ref,publication_state,publication_generation,authority_version,
         quiescence_receipt,review_execution_mode,execution_mode_generation,
         review_execution_state,provider_access_state,provider_access_version)
       VALUES ($1,$2,'github','https://api.github.com',$3,'91001','91002','github-app:91003',
         'active',1,2,'{"verified":true}'::jsonb,'harness_async',1,'active','verified',0)`,
      [integrationId, tenantId, repository],
    );
    const roleUrl = new URL(databaseUrl);
    roleUrl.username = role;
    roleUrl.password = password;
    runtimePool = new Pool({ connectionString: roleUrl.toString(), max: 4 });
    runtimeDb = new RuntimeDatabase(runtimePool);
    runs = new RunStore(runtimeDb);
    publications = new PgPublicationStore(runtimeDb);
    recovery = new PgPublicationRecoverySchedule(runtimeDb, {
      claimTtlMs: 30_000,
      initialBackoffMs: 1_000,
      maxBackoffMs: 5_000,
      maxAttempts: 5,
    });
  });

  after(async () => {
    await runtimePool?.end();
    await admin.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  test("draining preserves dispatch and recovery claims for already prepared work", async () => {
    await runs.createRun(runInput("draining-run"));
    const lease = await new RunExecutionStore(runtimeDb).claim({
      tenantId,
      integrationId,
      authorityGeneration: 1,
      executionModeGeneration: 1,
    }, "draining-worker", runtimeHash);
    assert.ok(lease);
    const workerPrepared = publicationIdentity("draining-worker", lease);
    const recoveryPrepared = publicationIdentity("draining-recovery");
    await runtimeDb.transaction(tenantId, async (client) => {
      await preparePublicationInTransaction(client, workerPrepared);
      await preparePublicationInTransaction(client, recoveryPrepared);
    });
    await admin.query(
      `UPDATE pr_agent_harness.integration_bindings SET publication_state='draining'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );

    assert.equal((await publications.prepareAndClaim(workerPrepared)).action, "dispatch");
    assert.ok(await recovery.claimPrepared(
      binding, recoveryPrepared.businessOperationId, "draining-recovery-worker"));

    await admin.query(
      `DELETE FROM pr_agent_harness.publication_slots
       WHERE tenant_id=$1 AND active_business_operation_id=ANY($2::text[])`,
      [tenantId, [workerPrepared.businessOperationId, recoveryPrepared.businessOperationId]],
    );
    await admin.query(
      `DELETE FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=ANY($2::text[])`,
      [tenantId, [workerPrepared.businessOperationId, recoveryPrepared.businessOperationId]],
    );
    await admin.query(
      `UPDATE pr_agent_harness.integration_bindings SET publication_state='active'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );
    await admin.query(
      `UPDATE pr_agent_harness.agent_runs SET lease_expires_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, lease.runId],
    );
  });

  test("revocation fences new work and prepared dispatch without blocking reconciliation", async () => {
    await runs.createRun(runInput("leased-run"));
    const lease = await new RunExecutionStore(runtimeDb).claim({
      tenantId,
      integrationId,
      authorityGeneration: 1,
      executionModeGeneration: 1,
    }, "provider-access-worker", runtimeHash);
    assert.ok(lease);

    const prepared = publicationIdentity("prepared", lease);
    const inFlight = publicationIdentity("in-flight");
    const unknown = publicationIdentity("unknown");
    await runtimeDb.transaction(tenantId, async (client) => {
      await preparePublicationInTransaction(client, prepared);
      await preparePublicationInTransaction(client, inFlight);
      await preparePublicationInTransaction(client, unknown);
    });
    await admin.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status=CASE business_operation_id WHEN $3 THEN 'in_flight' ELSE 'unknown' END,
           attempt_count=1,dispatched_at=now(),next_reconcile_at=now()-interval '1 second',
           version=version+1,updated_at=now()
       WHERE tenant_id=$1 AND business_operation_id=ANY($2::text[])`,
      [tenantId, [inFlight.businessOperationId, unknown.businessOperationId], inFlight.businessOperationId],
    );
    await admin.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET provider_access_state='revoked',provider_access_version=provider_access_version+1,
           provider_access_reason='installation suspended',provider_access_checked_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );

    await assert.rejects(
      runs.createRun(runInput("post-revocation")),
      /active asynchronous review execution authority not found/u,
    );

    const workerAttempt = await Promise.allSettled([publications.prepareAndClaim(prepared)]);
    if (workerAttempt[0]!.status === "fulfilled") {
      assert.notEqual(workerAttempt[0]!.value.action, "dispatch");
    }
    const preparedRow = await admin.query<{ status: string; attempt_count: number }>(
      `SELECT status,attempt_count FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, prepared.businessOperationId],
    );
    assert.deepEqual(preparedRow.rows[0], { status: "prepared", attempt_count: 0 });
    assert.equal(
      await recovery.claimPrepared(binding, prepared.businessOperationId, "prepared-recovery"),
      undefined,
    );

    const claims = await recovery.claim(binding, "reconciliation-worker", 10);
    assert.deepEqual(new Set(claims.map((claim) => claim.businessOperationId)),
      new Set([inFlight.businessOperationId, unknown.businessOperationId]));
    assert.equal((await publications.getForReconciliation(
      tenantId, inFlight.businessOperationId))?.status, "in_flight");
    assert.equal((await publications.getForReconciliation(
      tenantId, unknown.businessOperationId))?.status, "unknown");
  });

  function runInput(key: string): CreateRunInput {
    return {
      tenantId,
      integrationId,
      actorType: "service",
      actorId: "provider-access-test",
      createScope: "test:provider-access:v1",
      createKey: key,
      requestHash: hash(`request:${key}`),
      runType: "review.single.v1",
      baseSha: "base-sha",
      headSha: "head-sha",
      workflowVersionHash: runtimeHash,
      promptVersionHash: runtimeHash,
      modelVersionHash: runtimeHash,
      toolVersionHash: runtimeHash,
      policyVersionHash: runtimeHash,
      runtimeVersionHash: runtimeHash,
      input: { key },
      authorityGeneration: 1,
      bindingAuthorityVersion: 2,
      executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000 },
    };
  }

  function publicationIdentity(suffix: string, lease?: RunLease): PreparedOperationInput {
    const request: PublicationRequest = {
      scope: {
        tenantId,
        integrationId,
        platform: "github",
        origin: binding.origin,
        repository,
        target: `pull:${suffix}`,
        revision: "head-sha",
        authorityGeneration: 1,
      },
      slot: `review-${suffix}`,
      payload: { body: suffix },
      ...(lease ? { executionLease: lease } : {}),
    };
    return buildPublicationIdentity(request);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
