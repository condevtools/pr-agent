import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import {
  buildPublicationIdentity,
  PendingPublicationError,
  PgPublicationStore,
  PublicationDefiniteFailureError,
  PublicationService,
  PublicationSlotConflictError,
} from "../../src/agent-runtime/publication/publication.js";
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
  test.skip("PostgreSQL publication tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const roleName = `publication_app_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  let pool: Pool;
  let store: PgPublicationStore;
  let controlRunStore: RunStore;
  let nextProviderRepositoryId = 900_000;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.publication_batch_operations, pr_agent_harness.run_publication_batches, pr_agent_harness.agent_runs TO ${roleName}`);
    await adminPool.query(`GRANT UPDATE ON pr_agent_harness.agent_runs TO ${roleName}`);
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.repository_operations, pr_agent_harness.publication_slots TO ${roleName}`);
    await adminPool.query(`GRANT INSERT ON pr_agent_harness.audit_logs TO ${roleName}`);
    await adminPool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_current_binding_capability(uuid,uuid,text),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    pool = new Pool({ connectionString: appUrl.toString(), max: 12 });
    const db = new RuntimeDatabase(pool);
    store = new PgPublicationStore(db);
    controlRunStore = new RunStore(new RuntimeDatabase(adminPool));
  });

  after(async () => {
    await pool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("concurrent prepare grants exactly one dispatch attempt", async () => {
    const request = await createRequest("parallel");
    const identity = buildPublicationIdentity(request);
    const prepared = await Promise.all(
      Array.from({ length: 8 }, () => store.prepareAndClaim(identity)),
    );
    assert.equal(prepared.filter((item) => item.action === "dispatch").length, 1);
    assert.equal(prepared.filter((item) => item.action === "pending").length, 7);
    assert.deepEqual(new Set(prepared.map((item) => item.operation.attemptCount)), new Set([1]));
    assert.deepEqual(prepared[0]?.operation.payload, request.payload);
    assert.equal(Object.isFrozen(prepared[0]?.operation.payload), true);
  });

  test("frozen payload survives caller mutation and is used for dispatch", async () => {
    const request = await createRequest("frozen-payload");
    const mutablePayload = { body: "original", provider: { projectId: 73 } };
    const publicationRequest = { ...request, payload: mutablePayload };
    const service = new PublicationService(store);
    let dispatchedPayload: Readonly<Record<string, unknown>> | undefined;
    const result = await service.publish(publicationRequest, {
      preflight: async () => {
        mutablePayload.body = "mutated";
        mutablePayload.provider.projectId = 99;
      },
      dispatch: async (_marker, payload) => {
        dispatchedPayload = payload;
        return {
          id: "frozen-1",
          evidence: { providerActorId: 20, targetVerified: true, bodyHash: "c".repeat(64) },
        };
      },
      find: async () => null,
    });

    assert.equal(result.remoteId, "frozen-1");
    assert.deepEqual(dispatchedPayload, { body: "original", provider: { projectId: 73 } });
    const persisted = await store.get(request.scope.tenantId, result.businessOperationId);
    assert.deepEqual(persisted?.payload, dispatchedPayload);
    assert.notEqual(persisted?.payload, dispatchedPayload);
    const evidence = await adminPool.query<{ evidence_json: Record<string, unknown> }>(
      `SELECT evidence_json FROM pr_agent_harness.repository_operations
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [request.scope.tenantId, result.businessOperationId],
    );
    assert.deepEqual(evidence.rows[0]?.evidence_json, {
      providerActorId: 20,
      targetVerified: true,
      bodyHash: "c".repeat(64),
    });
  });

  test("a Run-linked in-flight dispatch is not reconciled before its provider deadline", async () => {
    const request = await createRequest("unlinked-dispatch-grace");
    const service = new PublicationService(store);
    let releaseDispatch!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const publishing = service.publish(request, {
      reconciliationGraceMs: 30_000,
      dispatch: async () => {
        markStarted();
        await released;
        return { id: "unlinked-dispatch-remote" };
      },
      find: async () => null,
    });
    await started;
    let reconciliationReads = 0;
    await assert.rejects(
      service.publish(request, {
        reconciliationGraceMs: 30_000,
        dispatch: async () => ({ id: "must-not-dispatch" }),
        find: async () => {
          reconciliationReads += 1;
          return null;
        },
      }),
      PendingPublicationError,
    );
    releaseDispatch();
    assert.equal((await publishing).remoteId, "unlinked-dispatch-remote");
    assert.equal(reconciliationReads, 0);
  });

  test("definite rejection is terminal for the same ID and releases the slot", async () => {
    const request = await createRequest("definite-rejection");
    const service = new PublicationService(store);
    const operationId = buildPublicationIdentity(request).businessOperationId;
    await assert.rejects(
      service.publish(request, {
        dispatch: async () => {
          throw new PublicationDefiniteFailureError(operationId, "provider_validation", 422);
        },
        find: async () => null,
      }),
      PublicationDefiniteFailureError,
    );
    await assert.rejects(
      service.publish(request, {
        dispatch: async () => ({ id: "must-not-dispatch" }),
        find: async () => null,
      }),
      PublicationDefiniteFailureError,
    );
    const replacement = await service.publish(
      { ...request, payload: { body: "replacement" } },
      { dispatch: async () => ({ id: "replacement" }), find: async () => null },
    );
    assert.equal(replacement.remoteId, "replacement");
  });

  test("independent unresolved listing and payload-less reconciliation fail closed", async () => {
    const request = await createRequest("independent-reconcile");
    const identity = buildPublicationIdentity(request);
    await store.prepareAndClaim(identity);
    assert.deepEqual(
      (await store.listUnresolved(request.scope.tenantId, request.scope.integrationId, 10)).map(
        (operation) => operation.businessOperationId,
      ),
      [identity.businessOperationId],
    );
    await adminPool.query(
      `UPDATE pr_agent_harness.repository_operations
       SET payload_json = NULL, next_reconcile_at=now()-interval '1 second'
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [request.scope.tenantId, identity.businessOperationId],
    );
    let dispatches = 0;
    await assert.rejects(
      new PublicationService(store).reconcileOperation(
        request.scope.tenantId,
        identity.businessOperationId,
        {
          dispatch: async () => ({ id: ++dispatches }),
          find: async () => ({ id: "must-not-query" }),
        },
      ),
      PendingPublicationError,
    );
    assert.equal(dispatches, 0);
    assert.equal(
      (await store.get(request.scope.tenantId, identity.businessOperationId))?.status,
      "manual_review",
    );
  });

  test("response loss reconciles the same operation without a second dispatch", async () => {
    const request = await createRequest("response-loss");
    const service = new PublicationService(store);
    let dispatches = 0;
    let remoteMarker: string | undefined;
    const adapter = {
      dispatch: async (marker: string) => {
        dispatches += 1;
        remoteMarker = marker;
        throw new Error("socket closed after write");
      },
      find: async (marker: string) => marker === remoteMarker
        ? { id: "comment-9", evidence: { providerActorId: 20, targetVerified: true } }
        : null,
      currentRevision: async () => request.scope.revision,
    };

    await assert.rejects(service.publish(request, adapter), PendingPublicationError);
    const result = await service.publish(request, adapter);
    assert.equal(dispatches, 1);
    assert.equal(result.reconciled, true);
    assert.equal(result.remoteId, "comment-9");
    const reconciledEvidence = await adminPool.query<{ evidence_json: Record<string, unknown> }>(
      `SELECT evidence_json FROM pr_agent_harness.repository_operations
       WHERE tenant_id = $1 AND business_operation_id = $2`,
      [request.scope.tenantId, result.businessOperationId],
    );
    assert.deepEqual(reconciledEvidence.rows[0]?.evidence_json, {
      providerActorId: 20,
      targetVerified: true,
    });
    const audits = await adminPool.query<{ action: string; decision: string }>(
      `
        SELECT action, decision
        FROM pr_agent_harness.audit_logs
        WHERE tenant_id = $1 AND resource_ref = $2
        ORDER BY created_at ASC
      `,
      [request.scope.tenantId, result.businessOperationId],
    );
    assert.deepEqual(
      audits.rows.map(({ action, decision }) => [action, decision]),
      [
        ["publication.dispatch_claimed", "allowed"],
        ["publication.resolved", "error"],
        ["publication.resolved", "allowed"],
      ],
    );
  });

  test("an unresolved slot blocks changed content and revision", async () => {
    const request = await createRequest("slot");
    await store.prepareAndClaim(buildPublicationIdentity(request));
    await assert.rejects(
      store.prepareAndClaim(
        buildPublicationIdentity({ ...request, payload: { body: "changed" } }),
      ),
      PublicationSlotConflictError,
    );
    await assert.rejects(
      store.prepareAndClaim(
        buildPublicationIdentity({
          ...request,
          scope: { ...request.scope, revision: "new-head" },
          executionLease: await createLease(
            { ...request, scope: { ...request.scope, revision: "new-head" } },
            "slot-new-head",
          ),
        }),
      ),
      PublicationSlotConflictError,
    );
  });

  test("tenant context cannot read another tenant publication", async () => {
    const request = await createRequest("tenant-a");
    const identity = buildPublicationIdentity(request);
    await store.prepareAndClaim(identity);
    assert.equal(
      await store.get(randomUUID(), identity.businessOperationId),
      undefined,
    );
  });

  test("a binding cannot be reused with a forged repository scope", async () => {
    const request = await createRequest("trusted-scope");
    await assert.rejects(
      store.prepareAndClaim(
        buildPublicationIdentity({
          ...request,
          scope: { ...request.scope, repository: "acme/forged" },
        }),
      ),
      { name: "InactiveIntegrationBindingError" },
    );
  });

  test("enrolled authority requires the exact frozen generation", async () => {
    const request = await createRequest("authority-generation");
    await adminPool.query(
      `
        UPDATE pr_agent_harness.integration_bindings
        SET publication_generation = 3
        WHERE tenant_id = $1 AND id = $2
      `,
      [request.scope.tenantId, request.scope.integrationId],
    );
    await assert.rejects(
      store.prepareAndClaim(buildPublicationIdentity(request)),
      { name: "InactiveIntegrationBindingError" },
    );
    await assert.rejects(
      store.prepareAndClaim(
        buildPublicationIdentity({
          ...request,
          scope: { ...request.scope, authorityGeneration: 2 },
        }),
      ),
      /execution lease does not match/,
    );
    const prepared = await store.prepareAndClaim(
      buildPublicationIdentity({
        ...request,
        scope: { ...request.scope, authorityGeneration: 3 },
        executionLease: await createLease(
          { ...request, scope: { ...request.scope, authorityGeneration: 3 } },
          "authority-generation-3",
        ),
      }),
    );
    assert.equal(prepared.action, "dispatch");
    assert.equal(prepared.operation.scope.authorityGeneration, 3);
  });

  async function createRequest(suffix: string) {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await controlRunStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: `acme/${suffix}`,
    });
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET provider_repository_id=$3, provider_actor_id='900002',
           credential_ref='test-credential', publication_state='active',
           publication_generation=1, review_execution_mode='harness_async',
           execution_mode_generation=1, quiescence_receipt='{"verified":true}'::jsonb
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId, String(nextProviderRepositoryId++)],
    );
    const request = {
      scope: {
        tenantId,
        integrationId,
        platform: "github" as const,
        origin: "https://github.example.test",
        repository: `acme/${suffix}`,
        target: "pull:42",
        revision: "head-sha",
        authorityGeneration: 1,
      },
      slot: "review-report",
      payload: { body: `review-${suffix}` },
    };
    return { ...request, executionLease: await createLease(request, suffix) };
  }

  async function createLease(
    request: { scope: { tenantId: string; integrationId: string; revision: string; authorityGeneration: number } },
    suffix: string,
  ): Promise<RunLease> {
    const version = "a".repeat(64);
    await controlRunStore.createRun({
      tenantId: request.scope.tenantId,
      integrationId: request.scope.integrationId,
      actorType: "service",
      actorId: "publication-test",
      createScope: "test:publication:v1",
      createKey: suffix,
      requestHash: "b".repeat(64),
      runType: "review",
      baseSha: "base-sha",
      headSha: request.scope.revision,
      workflowVersionHash: version,
      promptVersionHash: version,
      modelVersionHash: version,
      toolVersionHash: version,
      policyVersionHash: version,
      runtimeVersionHash: version,
      input: { suffix },
      authorityGeneration: request.scope.authorityGeneration,
      executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000 },
    });
    const lease = await new RunExecutionStore(new RuntimeDatabase(adminPool)).claim({
      tenantId: request.scope.tenantId,
      integrationId: request.scope.integrationId,
      authorityGeneration: request.scope.authorityGeneration,
      executionModeGeneration: 1,
    }, `publication-worker-${suffix}`, version);
    assert.ok(lease);
    return lease;
  }
}
