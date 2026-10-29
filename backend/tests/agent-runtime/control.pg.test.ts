import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import {
  PublicationControlCommandConflictError,
  PublicationControlRecoveryClaimError,
  PublicationControlStateError,
  PublicationControlStore,
  type PublicationControlDecision,
} from "../../src/agent-runtime/publication/control.js";
import { PgPublicationRecoverySchedule } from "../../src/agent-runtime/publication/recovery.js";
import {
  buildPublicationIdentity,
  PgPublicationStore,
  preparePublicationInTransaction,
  type PublicationRequest,
} from "../../src/agent-runtime/publication/publication.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!/^harness_test_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a dedicated harness_test_* Docker database");
  }
}

if (!databaseUrl) {
  test.skip("PostgreSQL publication control tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const roleName = `control_admin_${randomUUID().replaceAll("-", "")}`;
  const runtimeRoleName = `control_runtime_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  const runtimePassword = randomUUID();
  let pool: Pool;
  let runtimePool: Pool;
  let db: RuntimeDatabase;
  let controlStore: PublicationControlStore;
  let operationStore: PgPublicationStore;
  let controlRunStore: RunStore;
  let recoverySchedule: PgPublicationRecoverySchedule;
  let nextProviderId = 20_000;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`CREATE ROLE ${runtimeRoleName} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}, ${runtimeRoleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName}, ${runtimeRoleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.publication_batch_operations,
      pr_agent_harness.run_publication_batches, pr_agent_harness.agent_runs TO ${roleName}`);
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.repository_operations, pr_agent_harness.publication_slots TO ${roleName}`);
    await adminPool.query(`GRANT SELECT, INSERT ON pr_agent_harness.publication_command_receipts TO ${roleName}`);
    await adminPool.query(`GRANT INSERT ON pr_agent_harness.audit_logs TO ${roleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.repository_operations, pr_agent_harness.publication_command_receipts TO ${runtimeRoleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid, uuid, text, text, text, bigint) TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_legacy_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(uuid, uuid, bigint) TO ${roleName}`);

    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    pool = new Pool({ connectionString: appUrl.toString(), max: 8 });
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRoleName;
    runtimeUrl.password = runtimePassword;
    runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
    db = new RuntimeDatabase(pool);
    controlStore = new PublicationControlStore(db);
    operationStore = new PgPublicationStore(db);
    recoverySchedule = new PgPublicationRecoverySchedule(db);
    controlRunStore = new RunStore(new RuntimeDatabase(adminPool));
  });

  after(async () => {
    await runtimePool?.end();
    await pool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoleName}`);
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("confirm occurred is version-fenced, evidence-backed, and receipt-idempotent", async () => {
    const { request, operationId } = await createOperation("occurred", true);
    const current = await operationStore.get(request.scope.tenantId, operationId);
    assert.equal(current?.status, "unknown");
    const command = {
      tenantId: request.scope.tenantId,
      businessOperationId: operationId,
      expectedVersion: current!.version,
      commandKey: "manual:occurred:1",
      decision: "confirm_occurred" as const,
      actor: { type: "user" as const, id: "admin@example.test" },
      evidence: {
        kind: "provider_confirmation" as const,
        reference: "github-comment:987",
        actualRevision: request.scope.revision,
      },
      remoteId: "987",
    };
    const receipt = await controlStore.apply(command);
    assert.equal(receipt.resultingStatus, "succeeded");
    assert.deepEqual(await controlStore.apply(command), receipt);
    const resolved = await operationStore.get(request.scope.tenantId, operationId);
    assert.equal(resolved?.outcomeCode, "current");
    assert.equal(resolved?.remoteId, "987");

    await assert.rejects(
      controlStore.apply({ ...command, commandKey: "manual:occurred:stale-version" }),
      { name: "PublicationControlVersionConflictError" },
    );

    await assert.rejects(
      controlStore.apply({ ...command, remoteId: "988" }),
      PublicationControlCommandConflictError,
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.integration_bindings SET publication_state = 'blocked' WHERE tenant_id = $1 AND id = $2",
      [request.scope.tenantId, request.scope.integrationId],
    );
    await assert.rejects(controlStore.apply(command), { name: "PublicationControlAuthorityError" });
  });

  test("confirm occurred records stale when provider evidence names a different revision", async () => {
    const { request, operationId } = await createOperation("occurred-stale", true);
    const operation = (await operationStore.get(request.scope.tenantId, operationId))!;
    await controlStore.apply({
      tenantId: request.scope.tenantId,
      businessOperationId: operationId,
      expectedVersion: operation.version,
      commandKey: "manual:occurred-stale",
      decision: "confirm_occurred",
      actor: { type: "user", id: "admin@example.test" },
      evidence: {
        kind: "provider_confirmation",
        reference: "github-comment:stale",
        actualRevision: "new-head",
      },
      remoteId: "stale-remote",
    });
    assert.equal(
      (await operationStore.get(request.scope.tenantId, operationId))?.outcomeCode,
      "stale",
    );
  });

  test("retry requires confirmed absence, cooldown, new version, and stops at three attempts", async () => {
    const { request, identity, operationId } = await createOperation("retry", true);
    let operation = (await operationStore.get(request.scope.tenantId, operationId))!;
    const confirmation = await controlStore.apply({
      tenantId: request.scope.tenantId,
      businessOperationId: operationId,
      expectedVersion: operation.version,
      commandKey: "manual:not-occurred:1",
      decision: "confirm_not_occurred",
      actor: { type: "user", id: "admin@example.test" },
      evidence: { kind: "provider_confirmation", reference: "provider-audit:absent-1" },
    });
    assert.equal(confirmation.resultingStatus, "manual_review");
    operation = (await operationStore.get(request.scope.tenantId, operationId))!;
    assert.equal(operation.outcomeCode, "not_occurred_confirmed");

    const authorize = async (sequence: number) => controlStore.apply({
      tenantId: request.scope.tenantId,
      businessOperationId: operationId,
      expectedVersion: operation.version,
      commandKey: `manual:retry:${sequence}`,
      decision: "authorize_retry",
      actor: { type: "user", id: "admin@example.test" },
      evidence: { kind: "provider_confirmation", reference: `change-ticket:${sequence}` },
    });
    await adminPool.query(
      "UPDATE pr_agent_harness.repository_operations SET dispatched_at = now() WHERE tenant_id = $1 AND business_operation_id = $2",
      [request.scope.tenantId, operationId],
    );
    await assert.rejects(authorize(1), PublicationControlStateError);
    await adminPool.query(
      "UPDATE pr_agent_harness.repository_operations SET dispatched_at = now() - interval '3 minutes' WHERE tenant_id = $1 AND business_operation_id = $2",
      [request.scope.tenantId, operationId],
    );
    assert.equal((await authorize(1)).resultingStatus, "prepared");
    assert.equal((await operationStore.prepareAndClaim(identity)).action, "dispatch");
    await makeUnknownAndOld(request.scope.tenantId, operationId);

    for (const sequence of [2, 3]) {
      operation = (await operationStore.get(request.scope.tenantId, operationId))!;
      await controlStore.apply({
        tenantId: request.scope.tenantId,
        businessOperationId: operationId,
        expectedVersion: operation.version,
        commandKey: `manual:not-occurred:${sequence}`,
        decision: "confirm_not_occurred",
        actor: { type: "user", id: "admin@example.test" },
        evidence: { kind: "provider_confirmation", reference: `provider-audit:absent-${sequence}` },
      });
      operation = (await operationStore.get(request.scope.tenantId, operationId))!;
      if (sequence === 2) {
        await authorize(sequence);
        assert.equal((await operationStore.prepareAndClaim(identity)).action, "dispatch");
        await makeUnknownAndOld(request.scope.tenantId, operationId);
      } else {
        await assert.rejects(authorize(sequence), PublicationControlStateError);
      }
    }
    assert.equal((await operationStore.get(request.scope.tenantId, operationId))?.attemptCount, 3);
  });

  test("in-flight commands are refused and prepared no-effect operations can be abandoned", async () => {
    const inFlight = await createOperation("in-flight", true, false);
    const active = (await operationStore.get(inFlight.request.scope.tenantId, inFlight.operationId))!;
    await assert.rejects(
      controlStore.apply({
        tenantId: inFlight.request.scope.tenantId,
        businessOperationId: inFlight.operationId,
        expectedVersion: active.version,
        commandKey: "manual:in-flight",
        decision: "abandon_publication",
        actor: { type: "service", id: "operator-cli" },
        evidence: { kind: "provider_confirmation", reference: "operator:attempted-while-active" },
      }),
      PublicationControlStateError,
    );

    const prepared = await createOperation("prepared", false);
    const operation = (await operationStore.get(prepared.request.scope.tenantId, prepared.operationId))!;
    const receipt = await controlStore.apply({
      tenantId: prepared.request.scope.tenantId,
      businessOperationId: prepared.operationId,
      expectedVersion: operation.version,
      commandKey: "manual:abandon-prepared",
      decision: "abandon_publication",
      actor: { type: "service", id: "operator-cli" },
      evidence: { kind: "provider_confirmation", reference: "operator:no-dispatch" },
    });
    assert.equal(receipt.resultingStatus, "failed_definite");
    assert.equal(
      (await operationStore.get(prepared.request.scope.tenantId, prepared.operationId))?.outcomeCode,
      "publication_abandoned",
    );
  });

  test("active recovery claim fences manual decisions and advances the required version", async () => {
    const fixture = await createOperation("recovery-fence", true);
    const before = (await operationStore.get(
      fixture.request.scope.tenantId,
      fixture.operationId,
    ))!;
    const binding = {
      id: fixture.request.scope.integrationId,
      tenantId: fixture.request.scope.tenantId,
      platform: "github" as const,
      origin: fixture.request.scope.origin,
      repository: fixture.request.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: 1,
      version: 0,
      state: "active" as const,
    };
    const claim = (await recoverySchedule.claim(binding, "recovery-worker", 1))[0]!;
    assert.equal(claim.operationVersion, before.version + 1);
    const command = {
      tenantId: fixture.request.scope.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: before.version,
      commandKey: "manual:recovery-fenced",
      decision: "confirm_not_occurred" as const,
      actor: { type: "user" as const, id: "admin@example.test" },
      evidence: { kind: "provider_confirmation" as const, reference: "provider:absent" },
    };
    await assert.rejects(controlStore.apply(command), PublicationControlRecoveryClaimError);
    assert.equal(await recoverySchedule.finish(claim), "scheduled");
    await assert.rejects(controlStore.apply(command), { name: "PublicationControlVersionConflictError" });
    const current = (await operationStore.get(
      fixture.request.scope.tenantId,
      fixture.operationId,
    ))!;
    const receipt = await controlStore.apply({
      ...command,
      expectedVersion: current.version,
      commandKey: "manual:recovery-after-finish",
    });
    assert.equal(receipt.resultingStatus, "manual_review");
  });

  test("an authorized receipt replay survives a later active recovery claim", async () => {
    const fixture = await createOperation("receipt-recovery-replay", true);
    const operation = (await operationStore.get(
      fixture.request.scope.tenantId,
      fixture.operationId,
    ))!;
    const command = {
      tenantId: fixture.request.scope.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: operation.version,
      commandKey: "manual:receipt-before-recovery-claim",
      decision: "confirm_not_occurred" as const,
      actor: { type: "user" as const, id: "admin@example.test" },
      evidence: { kind: "provider_confirmation" as const, reference: "provider:absent" },
    };
    const receipt = await controlStore.apply(command);
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='unknown', outcome_code=NULL, resolved_at=NULL,
           next_reconcile_at=now(), version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.request.scope.tenantId, fixture.operationId],
    );
    const binding = {
      id: fixture.request.scope.integrationId,
      tenantId: fixture.request.scope.tenantId,
      platform: "github" as const,
      origin: fixture.request.scope.origin,
      repository: fixture.request.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: 1,
      version: 0,
      state: "active" as const,
    };
    assert.equal((await recoverySchedule.claim(binding, "receipt-replay-worker", 1)).length, 1);
    assert.deepEqual(await controlStore.apply(command), receipt);
  });

  test("expired recovery claim no longer blocks a version-current manual decision", async () => {
    const fixture = await createOperation("recovery-expired", true);
    const binding = {
      id: fixture.request.scope.integrationId,
      tenantId: fixture.request.scope.tenantId,
      platform: "github" as const,
      origin: fixture.request.scope.origin,
      repository: fixture.request.scope.repository,
      providerRepositoryId: 1,
      providerActorId: 1,
      credentialRef: "env:GITHUB_TOKEN",
      generation: 1,
      version: 0,
      state: "active" as const,
    };
    const claim = (await recoverySchedule.claim(binding, "expiring-worker", 1))[0]!;
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET reconcile_claim_expires_at=now()-interval '1 second'
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.request.scope.tenantId, fixture.operationId],
    );
    assert.equal(await recoverySchedule.finish(claim), "lost");
    const receipt = await controlStore.apply({
      tenantId: fixture.request.scope.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: claim.operationVersion,
      commandKey: "manual:expired-claim",
      decision: "confirm_not_occurred",
      actor: { type: "user", id: "admin@example.test" },
      evidence: { kind: "provider_confirmation", reference: "provider:absent" },
    });
    assert.equal(receipt.resultingStatus, "manual_review");
  });

  test("confirmed no-effect prepared failure can be authorized without dispatch cooldown", async () => {
    const fixture = await createOperation("prepared-no-effect-retry", false);
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='manual_review',last_error_code='preflight_attempts_exhausted',version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [fixture.request.scope.tenantId, fixture.operationId],
    );
    let operation = (await operationStore.get(
      fixture.request.scope.tenantId,
      fixture.operationId,
    ))!;
    const confirmed = await controlStore.apply({
      tenantId: fixture.request.scope.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: operation.version,
      commandKey: "manual:prepared-confirm-absent",
      decision: "confirm_not_occurred",
      actor: { type: "user", id: "admin@example.test" },
      evidence: { kind: "provider_confirmation", reference: "provider:absent" },
    });
    operation = (await operationStore.get(
      fixture.request.scope.tenantId,
      fixture.operationId,
    ))!;
    assert.equal(operation.attemptCount, 0);
    const retried = await controlStore.apply({
      tenantId: fixture.request.scope.tenantId,
      businessOperationId: fixture.operationId,
      expectedVersion: confirmed.resultingVersion,
      commandKey: "manual:prepared-authorize-retry",
      decision: "authorize_retry",
      actor: { type: "user", id: "admin@example.test" },
      evidence: { kind: "provider_confirmation", reference: "change:approved" },
    });
    assert.equal(retried.resultingStatus, "prepared");
  });

  test("runtime role can read receipts but cannot apply manual control", async () => {
    const readable = await createOperation("runtime-readable", false);
    await controlStore.apply({
      tenantId: readable.request.scope.tenantId,
      businessOperationId: readable.operationId,
      expectedVersion: 0,
      commandKey: "manual:runtime-readable",
      decision: "abandon_publication",
      actor: { type: "user", id: "admin@example.test" },
      evidence: { kind: "provider_confirmation", reference: "operator:no-dispatch" },
    });
    const runtimeDb = new RuntimeDatabase(runtimePool);
    assert.equal(
      await runtimeDb.transaction(readable.request.scope.tenantId, async (client) =>
        (await client.query(
          "SELECT count(*)::integer AS count FROM pr_agent_harness.publication_command_receipts WHERE command_key = $1",
          ["manual:runtime-readable"],
        )).rows[0]?.count
      ),
      1,
    );
    assert.equal(
      await runtimeDb.transaction(randomUUID(), async (client) =>
        (await client.query(
          "SELECT count(*)::integer AS count FROM pr_agent_harness.publication_command_receipts",
        )).rows[0]?.count
      ),
      0,
    );

    const prepared = await createOperation("runtime-denied", false);
    const runtimeStore = new PublicationControlStore(runtimeDb);
    await assert.rejects(
      runtimeStore.apply({
        tenantId: prepared.request.scope.tenantId,
        businessOperationId: prepared.operationId,
        expectedVersion: 0,
        commandKey: "manual:runtime-denied",
        decision: "abandon_publication",
        actor: { type: "service", id: "runtime" },
        evidence: { kind: "provider_confirmation", reference: "untrusted-runtime" },
      }),
      /permission denied/,
    );
  });

  test("runtime validation rejects an unknown decision before SQL", async () => {
    await assert.rejects(
      controlStore.apply({
        tenantId: randomUUID(),
        businessOperationId: "a".repeat(64),
        expectedVersion: 0,
        commandKey: "manual:invalid",
        decision: "force_retry" as PublicationControlDecision,
        actor: { type: "service", id: "operator-cli" },
        evidence: { kind: "provider_confirmation", reference: "invalid-command" },
      }),
      /invalid publication control decision/,
    );
  });

  async function createOperation(suffix: string, claim: boolean, makeUnknown = true) {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await controlRunStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: `acme/control-${suffix}`,
    });
    await adminPool.query(
      `
        UPDATE pr_agent_harness.integration_bindings
        SET publication_state = 'active', publication_generation = 1,
            provider_repository_id = $3, provider_actor_id = $4,
            credential_ref = 'env:GITHUB_TOKEN',
            quiescence_receipt = '{"approved":true}'::jsonb
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, integrationId, String(++nextProviderId), String(nextProviderId + 10_000)],
    );
    const request: PublicationRequest = {
      scope: {
        tenantId,
        integrationId,
        platform: "github",
        origin: "https://github.example.test",
        repository: `acme/control-${suffix}`,
        target: "pull:42",
        revision: "head-sha",
        authorityGeneration: 1,
      },
      slot: "review-report",
      payload: { body: `control-${suffix}` },
    };
    const identity = buildPublicationIdentity(request);
    if (claim) {
      await operationStore.prepareAndClaim(identity);
      if (makeUnknown) await makeUnknownAndOld(tenantId, identity.businessOperationId);
    } else {
      await db.transaction(tenantId, (client) => preparePublicationInTransaction(client, identity));
    }
    return { request, identity, operationId: identity.businessOperationId };
  }

  async function makeUnknownAndOld(tenantId: string, operationId: string): Promise<void> {
    await adminPool.query(
      `
        UPDATE pr_agent_harness.repository_operations
        SET status = 'unknown', dispatched_at = now() - interval '3 minutes', updated_at = now()
        WHERE tenant_id = $1 AND business_operation_id = $2
      `,
      [tenantId, operationId],
    );
  }
}
