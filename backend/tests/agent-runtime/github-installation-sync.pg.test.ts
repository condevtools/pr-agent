import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { GitHubInstallationSyncStore } from
  "../../src/agent-runtime/authority/github-installation-sync.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { buildPublicationIdentity, preparePublicationInTransaction } from
  "../../src/agent-runtime/publication/publication.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("GitHub installation sync requires isolated Docker PostgreSQL", () => {});
} else {
  if (!new URL(databaseUrl).pathname.slice(1).startsWith("harness_test_")) {
    throw new Error("Disposable harness_test_* database required");
  }
  const owner = new Pool({ connectionString: databaseUrl });
  const password = randomUUID();
  let restricted: Pool;
  let store: GitHubInstallationSyncStore;

  before(async () => {
    const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_onboarding'");
    const ddl = await owner.query<{ sql: string }>(exists.rowCount
      ? "SELECT format('ALTER ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text) AS sql"
      : "SELECT format('CREATE ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text) AS sql",
    [password]);
    await owner.query(ddl.rows[0]!.sql);
    await migrateRuntime(owner);
    await owner.query("ALTER ROLE pr_agent_onboarding SET statement_timeout='15s'");
    await owner.query("ALTER ROLE pr_agent_onboarding SET lock_timeout='5s'");
    const url = new URL(databaseUrl);
    url.username = "pr_agent_onboarding";
    url.password = password;
    restricted = new Pool({ connectionString: url.toString(), max: 4 });
    store = new GitHubInstallationSyncStore(new RuntimeDatabase(restricted));
  });

  after(async () => {
    await restricted?.end();
    await owner.end();
  });

  test("duplicate delivery coalesces once and stale snapshot cannot beat a restriction", async () => {
    const first = await store.requestSync({ appId: 41, installationId: 51, accountId: 61,
      deliveryId: "positive-1", eventClass: "positive", reason: "installation created" });
    const duplicate = await store.requestSync({ appId: 41, installationId: 51, accountId: 61,
      deliveryId: "positive-1", eventClass: "positive", reason: "installation created" });
    assert.deepEqual(first, { accepted: true, requestedEpoch: 1 });
    assert.deepEqual(duplicate, { accepted: false, requestedEpoch: 1 });

    const claim = await store.claim({ appId: 41, ownerId: "sync-a", leaseSeconds: 60 });
    assert.equal(claim?.claimEpoch, 1);
    const restrictedResult = await store.restrictAndRequest({ appId: 41, installationId: 51,
      accountId: 61, state: "revoked", reason: "installation suspended", deliveryId: "negative-1" });
    assert.equal(restrictedResult.requestedEpoch, 2);
    await assert.rejects(store.applyCompleteSnapshot(claim!, {
      accountId: 61, providerActorId: 71, completedAt: new Date(), repositories: [],
      snapshotHash: hashIds([]),
    }), /stale|lease|epoch/iu);
    const state = await owner.query(`SELECT requested_epoch,restrictive_epoch,applied_epoch,status
      FROM pr_agent_harness.github_installation_sync_state
      WHERE github_app_id=41 AND installation_id=51`);
    assert.deepEqual(state.rows[0], {
      requested_epoch: "2", restrictive_epoch: "2", applied_epoch: "0", status: "pending",
    });
    const current = (await store.claim({ appId: 41, ownerId: "sync-a-current", leaseSeconds: 60 }))!;
    await store.applyCompleteSnapshot(current, { accountId: 61, providerActorId: 71,
      completedAt: new Date(), repositories: [], snapshotHash: hashIds([]) });
  });

  test("restrictive account conflicts preserve ownership while fencing the installation", async () => {
    const tenantId = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.github_account_tenant_mappings
      (github_app_id,github_account_id,tenant_id,mapping_source)
      VALUES (154,164,$1,'auto_created')`, [tenantId]);
    await owner.query(`INSERT INTO pr_agent_harness.github_installation_sync_state
      (github_app_id,installation_id,github_account_id,requested_epoch,applied_epoch,status)
      VALUES (154,174,164,1,1,'idle')`);
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,quiescence_receipt,
       review_execution_mode,execution_mode_generation,review_execution_state,
       github_app_id,github_account_id,provider_access_state)
      VALUES ($1,$2,'github','https://api.github.com','conflict/account','184','194','github-app:174',
        'active',1,2,'{"protocol":"fixture"}'::jsonb,'harness_async',1,'active',154,164,'verified')`,
    [randomUUID(), tenantId]);
    const result = await store.restrictAndRequest({ appId: 154, installationId: 174, accountId: 165,
      state: "revoked", reason: "signed installation deletion", deliveryId: "account-conflict-negative" });
    assert.equal(result.accepted, true);
    assert.equal(result.changedBindings, 1);
    const state = await owner.query(`SELECT github_account_id::integer,requested_epoch::integer,
      last_error_code FROM pr_agent_harness.github_installation_sync_state
      WHERE github_app_id=154 AND installation_id=174`);
    assert.deepEqual(state.rows[0], { github_account_id: 164, requested_epoch: 2,
      last_error_code: "installation_account_identity_conflict" });
    assert.equal((await owner.query(`SELECT provider_access_state
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=154`)).rows[0]!.provider_access_state,
    "revoked");
    assert.equal((await owner.query(`SELECT count(*)::integer count FROM pr_agent_harness.audit_logs
      WHERE tenant_id=$1 AND action='github.installation.account_identity'
        AND reason_code='installation_account_identity_conflict'`, [tenantId])).rows[0]!.count, 1);
    assert.equal((await owner.query(`SELECT count(*)::integer count
      FROM pr_agent_harness.github_provider_lifecycle_receipts
      WHERE github_app_id=154 AND delivery_id='account-conflict-negative'`)).rows[0]!.count, 1);
    await assert.rejects(store.requestSync({ appId: 154, installationId: 174, accountId: 165,
      deliveryId: "account-conflict-positive", eventClass: "positive", reason: "must remain blocked" }),
    /account identity conflict/u);
    await owner.query("DELETE FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id=154");
    await owner.query("DELETE FROM pr_agent_harness.github_account_tenant_mappings WHERE github_app_id=154");
  });

  test("sync and deferred claims cannot steal another GitHub App's backlog", async () => {
    for (const appId of [1540, 1541]) {
      await store.requestSync({ appId, installationId: appId + 10, accountId: appId + 20,
        deliveryId: `app-scoped-sync-${appId}`, eventClass: "positive", reason: "fixture" });
    }
    const secondSync = (await store.claim({ appId: 1541,
      ownerId: "app-scoped-sync-second", leaseSeconds: 60 }))!;
    assert.equal(secondSync.appId, 1541);
    const firstSync = (await store.claim({ appId: 1540,
      ownerId: "app-scoped-sync-first", leaseSeconds: 60 }))!;
    assert.equal(firstSync.appId, 1540);
    await store.completeRestrictedSnapshot(secondSync, { state: "unknown",
      reason: "test fixture closes scoped sync", completedAt: new Date() });
    await store.completeRestrictedSnapshot(firstSync, { state: "unknown",
      reason: "test fixture closes scoped sync", completedAt: new Date() });

    for (const appId of [1542, 1543]) {
      await store.defer({ appId, installationId: appId + 10, accountId: appId + 20,
        repositoryId: appId + 30, repository: `example/app-scoped-${appId}`,
        pullNumber: 1, action: "opened", deliveryId: `app-scoped-pr-${appId}`,
        sourceHash: createHash("sha256").update(String(appId)).digest("hex") });
    }
    const secondDeferred = (await store.claimDeferred({ appId: 1543,
      ownerId: "app-scoped-deferred-second", leaseSeconds: 60 }))!;
    assert.equal(secondDeferred.appId, 1543);
    const firstDeferred = (await store.claimDeferred({ appId: 1542,
      ownerId: "app-scoped-deferred-first", leaseSeconds: 60 }))!;
    assert.equal(firstDeferred.appId, 1542);
    assert.equal(await store.completeDeferred(secondDeferred, { outcome: "skipped" }), true);
    assert.equal(await store.completeDeferred(firstDeferred, { outcome: "skipped" }), true);
    for (const appId of [1542, 1543]) {
      const claim = (await store.claim({ appId, ownerId: `app-scoped-cleanup-${appId}`,
        leaseSeconds: 60 }))!;
      await store.completeRestrictedSnapshot(claim, { state: "unknown",
        reason: "test fixture closes deferred sync", completedAt: new Date() });
    }
  });

  test("confirmed deleted installations leave discovery until positive work advances the epoch", async () => {
    await store.requestSync({ appId: 56, installationId: 66, accountId: 76,
      deliveryId: "deleted-installation", eventClass: "positive", reason: "fixture" });
    const claim = (await store.claim({ appId: 56,
      ownerId: "deleted-installation", leaseSeconds: 60 }))!;
    await store.completeRestrictedSnapshot(claim, { state: "revoked",
      reason: "provider_snapshot_deleted", completedAt: new Date() });
    assert.deepEqual(await store.listKnownInstallations(56), []);
    await store.requestSync({ appId: 56, installationId: 66, accountId: 76,
      deliveryId: "deleted-installation-positive-retry", eventClass: "positive",
      reason: "live lifecycle evidence" });
    assert.deepEqual(await store.listKnownInstallations(56), [{ installationId: 66, accountId: 76 }]);
    const retry = (await store.claim({ appId: 56,
      ownerId: "deleted-installation-retry", leaseSeconds: 60 }))!;
    await store.completeRestrictedSnapshot(retry, { state: "unknown",
      reason: "test fixture cleanup", completedAt: new Date() });
  });

  test("discovery cancellation stops before enqueueing the remaining installations", async () => {
    const controller = new AbortController();
    const originalRequestSync = store.requestSync.bind(store);
    let requests = 0;
    store.requestSync = async (input) => {
      const result = await originalRequestSync(input);
      requests += 1;
      if (requests === 1) controller.abort();
      return result;
    };
    try {
      await assert.rejects(store.discoveryRequests([
        { appId: 1550, installationId: 1560, accountId: 1570 },
        { appId: 1550, installationId: 1561, accountId: 1570 },
      ], "cancelled-discovery", controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError");
    } finally {
      store.requestSync = originalRequestSync;
    }
    assert.equal(requests, 1);
    const rows = await owner.query(`SELECT installation_id::integer
      FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id=1550`);
    assert.deepEqual(rows.rows, [{ installation_id: 1560 }]);
    await owner.query("DELETE FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id=1550");
  });

  test("complete snapshots use machine evidence, preserve operator policy, and revoke absence", async () => {
    await store.requestSync({ appId: 42, installationId: 52, accountId: 62,
      deliveryId: "positive-2", eventClass: "positive", reason: "installation created" });
    const firstClaim = (await store.claim({ appId: 42, ownerId: "sync-b", leaseSeconds: 60 }))!;
    const initial = Array.from({ length: 65 }, (_, index) => ({
      id: 1000 + index, fullName: `example/repository-${index}`,
    }));
    const applied = await store.applyCompleteSnapshot(firstClaim, {
      accountId: 62, providerActorId: 72, completedAt: new Date(), repositories: initial,
      snapshotHash: hashIds(initial.map(({ id }) => id)),
    });
    assert.equal(applied.created, 65);
    const bindings = await owner.query(`SELECT publication_state,active,review_execution_mode,
        review_execution_state,quiescence_receipt->>'protocol' AS protocol
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=42`);
    assert.equal(bindings.rowCount, 65);
    assert.equal(bindings.rows.every((row) => row.protocol === "github_installation_snapshot_v1"), true);

    const protectedBinding = await owner.query<{ id: string }>(`SELECT id FROM pr_agent_harness.integration_bindings
      WHERE github_app_id=42 ORDER BY provider_repository_id::bigint LIMIT 1`);
    await owner.query(`UPDATE pr_agent_harness.integration_bindings
      SET publication_state='blocked',active=false WHERE id=$1`, [protectedBinding.rows[0]!.id]);
    await store.requestSync({ appId: 42, installationId: 52, accountId: 62,
      deliveryId: "positive-3", eventClass: "positive", reason: "periodic discovery" });
    const secondClaim = (await store.claim({ appId: 42, ownerId: "sync-c", leaseSeconds: 60 }))!;
    const retained = initial.slice(0, 64);
    const second = await store.applyCompleteSnapshot(secondClaim, {
      accountId: 62, providerActorId: 72, completedAt: new Date(), repositories: retained,
      snapshotHash: hashIds(retained.map(({ id }) => id)),
    });
    assert.equal(second.revoked, 1);
    const preserved = await owner.query(`SELECT publication_state,active,review_execution_mode,
        review_execution_state FROM pr_agent_harness.integration_bindings WHERE id=$1`,
    [protectedBinding.rows[0]!.id]);
    assert.deepEqual(preserved.rows[0], { publication_state: "blocked", active: false,
      review_execution_mode: "harness_async", review_execution_state: "active" });
    const absent = await owner.query(`SELECT provider_access_state FROM pr_agent_harness.integration_bindings
      WHERE github_app_id=42 AND provider_repository_id='1064'`);
    assert.equal(absent.rows[0]!.provider_access_state, "revoked");
  });

  test("deferred PR leases are exclusive, CAS protected, and cleanup is bounded", async () => {
    const admitted = await store.defer({ appId: 43, installationId: 53, accountId: 63,
      repositoryId: 73, repository: "example/deferred", pullNumber: 8, action: "opened",
      deliveryId: "pr-1", sourceHash: "a".repeat(64) });
    assert.equal(admitted.accepted, true);
    assert.equal((await store.defer({ appId: 43, installationId: 53, accountId: 63,
      repositoryId: 73, repository: "example/deferred", pullNumber: 8, action: "opened",
      deliveryId: "pr-1", sourceHash: "a".repeat(64) })).accepted, false);
    const claim = await store.claimDeferred({ appId: 43, ownerId: "drain-a", leaseSeconds: 60 });
    assert.equal(claim?.deliveryId, "pr-1");
    assert.equal(await store.claimDeferred({ appId: 43, ownerId: "drain-b", leaseSeconds: 60 }), undefined);
    assert.equal(await store.completeDeferred(claim!, { outcome: "completed" }), true);
    assert.equal(await store.completeDeferred(claim!, { outcome: "completed" }), false);
    await owner.query(`UPDATE pr_agent_harness.github_deferred_pull_requests
      SET completed_at=clock_timestamp()-interval '73 hours',expires_at=clock_timestamp()-interval '73 hours'
      WHERE id=$1`, [claim!.id]);
    assert.deepEqual(await store.cleanup({ limit: 1 }), { deleted: 1, expired: 0 });
    const pendingSync = (await store.claim({ appId: 43, ownerId: "sync-deferred-pr", leaseSeconds: 60 }))!;
    await store.completeRestrictedSnapshot(pendingSync, {
      state: "unknown", reason: "test fixture closes deferred-triggered sync",
      completedAt: new Date(),
    });
  });

  test("deferred admissions do not starve an active fetch and restricted snapshots finish its claim", async () => {
    await store.requestSync({ appId: 44, installationId: 54, accountId: 64,
      deliveryId: "positive-44", eventClass: "positive", reason: "installation discovered" });
    const claim = (await store.claim({ appId: 44, ownerId: "sync-restricted", leaseSeconds: 60 }))!;
    assert.equal(claim.claimEpoch, 1);
    for (const [deliveryId, pullNumber] of [["pr-44-a", 10], ["pr-44-b", 11]] as const) {
      await store.defer({ appId: 44, installationId: 54, accountId: 64, repositoryId: 74,
        repository: "example/restricted", pullNumber, action: "opened", deliveryId,
        sourceHash: createHash("sha256").update(deliveryId).digest("hex") });
    }
    const duringFetch = await owner.query(`SELECT requested_epoch,status FROM
      pr_agent_harness.github_installation_sync_state WHERE github_app_id=44 AND installation_id=54`);
    assert.deepEqual(duringFetch.rows[0], { requested_epoch: "1", status: "applying" });
    assert.deepEqual(await store.completeRestrictedSnapshot(claim, {
      state: "revoked", reason: "complete provider snapshot reports installation suspended",
      completedAt: new Date(),
    }), { changedBindings: 0 });
    const completed = await owner.query(`SELECT requested_epoch,restrictive_epoch,applied_epoch,status
      FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id=44 AND installation_id=54`);
    assert.deepEqual(completed.rows[0], { requested_epoch: "1", restrictive_epoch: "1",
      applied_epoch: "1", status: "idle" });
  });

  test("cleanup expires only deferred rows whose record and lease are both stale", async () => {
    const stale = await store.defer({ appId: 48, installationId: 58, accountId: 68,
      repositoryId: 78, repository: "example/stale-lease", pullNumber: 13, action: "opened",
      deliveryId: "pr-stale-lease", sourceHash: "f".repeat(64) });
    assert.equal(stale.outcome, "admitted");
    const staleClaim = (await store.claimDeferred({ appId: 48, ownerId: "stale-deferred", leaseSeconds: 60 }))!;
    await owner.query(`UPDATE pr_agent_harness.github_deferred_pull_requests SET
      expires_at=clock_timestamp()-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE id=$1`, [staleClaim.id]);
    assert.deepEqual(await store.cleanup({ limit: 256 }), { deleted: 0, expired: 1 });
    const expired = await owner.query(`SELECT status,lease_owner,lease_expires_at
      FROM pr_agent_harness.github_deferred_pull_requests WHERE id=$1`, [staleClaim.id]);
    assert.deepEqual(expired.rows[0], { status: "expired", lease_owner: null, lease_expires_at: null });

    await store.defer({ appId: 49, installationId: 59, accountId: 69,
      repositoryId: 79, repository: "example/live-lease", pullNumber: 14, action: "opened",
      deliveryId: "pr-live-lease", sourceHash: "1".repeat(64) });
    const liveClaim = (await store.claimDeferred({ appId: 49, ownerId: "live-deferred", leaseSeconds: 60 }))!;
    await owner.query(`UPDATE pr_agent_harness.github_deferred_pull_requests
      SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, [liveClaim.id]);
    assert.deepEqual(await store.cleanup({ limit: 256 }), { deleted: 0, expired: 0 });
    assert.equal((await owner.query(`SELECT status FROM pr_agent_harness.github_deferred_pull_requests
      WHERE id=$1`, [liveClaim.id])).rows[0]!.status, "leased");
    await owner.query(`DELETE FROM pr_agent_harness.github_deferred_pull_requests WHERE id=$1`, [liveClaim.id]);
    await owner.query(`DELETE FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id IN (48,49)`);
  });

  test("deferred admission suppresses operator-ineligible bindings and rejects foreign identity", async () => {
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,credential_ref,
       github_app_id,github_account_id,provider_access_state)
      VALUES ($1,$2,'github','https://api.github.com','example/operator-blocked','75',
        'github-app:55',45,65,'unknown')`, [randomUUID(), randomUUID()]);
    const input = { appId: 45, installationId: 55, accountId: 65, repositoryId: 75,
      repository: "example/operator-blocked", pullNumber: 12, action: "opened" as const,
      deliveryId: "pr-operator-blocked", sourceHash: "d".repeat(64) };
    assert.deepEqual(await store.defer(input), { outcome: "suppressed", accepted: false });
    await assert.rejects(store.defer({ ...input, appId: 46, deliveryId: "pr-foreign",
      sourceHash: "e".repeat(64) }), /conflicts with binding identity/u);
    const rows = await owner.query("SELECT 1 FROM pr_agent_harness.github_deferred_pull_requests WHERE github_app_id IN (45,46)");
    assert.equal(rows.rowCount, 0);
  });

  test("deferred admission survives binding-create and repository-rename lookup races", async () => {
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,quiescence_receipt,
       review_execution_mode,execution_mode_generation,review_execution_state,
       github_app_id,github_account_id,provider_access_state)
      VALUES ($1,$2,'github','https://api.github.com','example/current-name','1460','1461',
        'github-app:1450','active',1,2,'{"protocol":"fixture"}'::jsonb,
        'harness_async',1,'active',1440,1430,'verified')`, [randomUUID(), randomUUID()]);
    const base = { appId: 1440, installationId: 1450, accountId: 1430,
      repositoryId: 1460, pullNumber: 13, action: "opened" as const };
    const createdBeforeAdmit = await store.defer({ ...base, repository: "example/current-name",
      deliveryId: "pr-created-before-admit", sourceHash: "8".repeat(64) });
    const renamedBeforeAdmit = await store.defer({ ...base, repository: "example/old-name",
      deliveryId: "pr-renamed-before-admit", sourceHash: "9".repeat(64) });
    assert.equal(createdBeforeAdmit.outcome, "admitted");
    assert.equal(renamedBeforeAdmit.outcome, "admitted");
    const cleanupClaim = (await store.claim({ appId: base.appId,
      ownerId: "defer-race-cleanup", leaseSeconds: 60 }))!;
    assert.equal(cleanupClaim.appId, base.appId);
    await store.completeRestrictedSnapshot(cleanupClaim, { state: "unknown",
      reason: "test fixture closes deferred-triggered sync", completedAt: new Date() });
  });

  test("public GitHub restrictions and snapshots never mutate colliding GHES bindings", async () => {
    const appId = 1470;
    const installationId = 1471;
    const accountId = 1472;
    const actorId = 1473;
    const repositories = [1474, 1475, 1476].map((id) => ({
      id, fullName: `example/public-${id}`,
    }));
    await store.requestSync({ appId, installationId, accountId,
      deliveryId: "ghes-isolation-initial", eventClass: "positive", reason: "fixture" });
    const initialClaim = (await store.claim({ appId,
      ownerId: "ghes-isolation-initial", leaseSeconds: 60 }))!;
    await store.applyCompleteSnapshot(initialClaim, { accountId, providerActorId: actorId,
      completedAt: new Date(), repositories,
      snapshotHash: hashIds(repositories.map(({ id }) => id)) });
    for (const repository of repositories) {
      await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
        (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
         publication_state,publication_generation,authority_version,quiescence_receipt,
         review_execution_mode,execution_mode_generation,review_execution_state,
         github_app_id,github_account_id,provider_access_state)
        VALUES ($1,$2,'github','https://github.enterprise.test/api/v3',$3,$4,$5,$6,
          'active',1,2,'{"protocol":"fixture"}'::jsonb,'harness_async',1,'active',$7,$8,'verified')`,
      [randomUUID(), randomUUID(), `enterprise/repository-${repository.id}`, String(repository.id),
        String(actorId), `github-app:${installationId}`, appId, accountId]);
    }

    await store.restrictAndRequest({ appId, installationId, accountId,
      state: "revoked", reason: "repository removed", deliveryId: "ghes-isolation-remove",
      repositoryIds: [repositories[0]!.id] });
    assert.equal((await owner.query(`SELECT provider_access_state
      FROM pr_agent_harness.integration_bindings
      WHERE origin='https://api.github.com' AND github_app_id=$1 AND provider_repository_id=$2`,
    [appId, String(repositories[0]!.id)])).rows[0]!.provider_access_state, "revoked");
    const restoreClaim = (await store.claim({ appId,
      ownerId: "ghes-isolation-restore", leaseSeconds: 60 }))!;
    await store.applyCompleteSnapshot(restoreClaim, { accountId, providerActorId: actorId,
      completedAt: new Date(), repositories,
      snapshotHash: hashIds(repositories.map(({ id }) => id)) });

    await store.requestSync({ appId, installationId, accountId,
      deliveryId: "ghes-isolation-absence", eventClass: "positive", reason: "fixture" });
    const absenceClaim = (await store.claim({ appId,
      ownerId: "ghes-isolation-absence", leaseSeconds: 60 }))!;
    const retained = [repositories[0]!, repositories[2]!];
    await store.applyCompleteSnapshot(absenceClaim, { accountId, providerActorId: actorId,
      completedAt: new Date(), repositories: retained,
      snapshotHash: hashIds(retained.map(({ id }) => id)) });
    assert.equal((await owner.query(`SELECT provider_access_state
      FROM pr_agent_harness.integration_bindings
      WHERE origin='https://api.github.com' AND github_app_id=$1 AND provider_repository_id=$2`,
    [appId, String(repositories[1]!.id)])).rows[0]!.provider_access_state, "revoked");

    await store.requestSync({ appId, installationId, accountId,
      deliveryId: "ghes-isolation-restricted", eventClass: "positive", reason: "fixture" });
    const restrictedClaim = (await store.claim({ appId,
      ownerId: "ghes-isolation-restricted", leaseSeconds: 60 }))!;
    await store.completeRestrictedSnapshot(restrictedClaim, { state: "unknown",
      reason: "permissions incomplete", completedAt: new Date() });
    const publicStates = await owner.query(`SELECT provider_access_state
      FROM pr_agent_harness.integration_bindings
      WHERE origin='https://api.github.com' AND github_app_id=$1
      ORDER BY provider_repository_id::bigint`, [appId]);
    assert.deepEqual(publicStates.rows, [
      { provider_access_state: "unknown" },
      { provider_access_state: "revoked" },
      { provider_access_state: "unknown" },
    ]);
    const ghesStates = await owner.query(`SELECT provider_access_state
      FROM pr_agent_harness.integration_bindings
      WHERE origin='https://github.enterprise.test/api/v3' AND github_app_id=$1
      ORDER BY provider_repository_id::bigint`, [appId]);
    assert.deepEqual(ghesStates.rows, [
      { provider_access_state: "verified" },
      { provider_access_state: "verified" },
      { provider_access_state: "verified" },
    ]);
  });

  test("unmapped multi-tenant accounts block all positive apply while restrictions continue", async () => {
    for (const [tenantId, repositoryId] of [[randomUUID(), 80], [randomUUID(), 81]] as const) {
      await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
        (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
         credential_ref,publication_state,publication_generation,authority_version,quiescence_receipt,
         github_app_id,github_account_id,provider_access_state)
        VALUES ($1,$2,'github','https://api.github.com',$3,$4,'77','github-app:57',
          'active',1,2,'{"protocol":"fixture"}'::jsonb,47,67,'verified')`,
      [randomUUID(), tenantId, `example/ambiguous-${repositoryId}`, String(repositoryId)]);
    }
    await store.requestSync({ appId: 47, installationId: 57, accountId: 67,
      deliveryId: "positive-ambiguous", eventClass: "positive", reason: "complete discovery" });
    const claim = (await store.claim({ appId: 47, ownerId: "sync-ambiguous", leaseSeconds: 60 }))!;
    const repositories = [
      { id: 80, fullName: "example/ambiguous-80" },
      { id: 81, fullName: "example/ambiguous-81" },
    ];
    assert.deepEqual(await store.applyCompleteSnapshot(claim, { accountId: 67, providerActorId: 77,
      completedAt: new Date(), repositories, snapshotHash: hashIds([80, 81]) }),
    { status: "conflict", created: 0, restored: 0, adopted: 0, conflicted: 0, revoked: 0 });
    assert.equal((await owner.query(`SELECT 1 FROM pr_agent_harness.github_account_tenant_mappings
      WHERE github_app_id=47 AND github_account_id=67`)).rowCount, 0);
    const restricted = await store.restrictAndRequest({ appId: 47, installationId: 57, accountId: 67,
      state: "revoked", reason: "installation deleted", deliveryId: "negative-ambiguous" });
    assert.equal(restricted.changedBindings, 2);
    const states = await owner.query(`SELECT DISTINCT provider_access_state
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=47`);
    assert.deepEqual(states.rows, [{ provider_access_state: "revoked" }]);
    await owner.query(`DELETE FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id=47`);
  });

  test("tenant adoption ignores GHES repository IDs and mismatched provider actors", async () => {
    const ghesTenant = randomUUID();
    const wrongActorTenant = randomUUID();
    for (const binding of [
      { tenantId: ghesTenant, origin: "https://github.enterprise.example/api/v3",
        repository: "foreign/ghes", repositoryId: 40_000, actorId: 92 },
      { tenantId: wrongActorTenant, origin: "https://api.github.com",
        repository: "foreign/wrong-actor", repositoryId: 40_001, actorId: 999 },
    ]) {
      await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
        (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
         credential_ref,publication_state,publication_generation,authority_version,quiescence_receipt,
         provider_access_state)
        VALUES ($1,$2,'github',$3,$4,$5,$6,'github-app:legacy',
          'active',1,2,'{"protocol":"fixture"}'::jsonb,'verified')`,
      [randomUUID(), binding.tenantId, binding.origin, binding.repository,
        String(binding.repositoryId), String(binding.actorId)]);
    }
    await store.requestSync({ appId: 53, installationId: 63, accountId: 73,
      deliveryId: "positive-compatible-proof", eventClass: "positive", reason: "identity proof fixture" });
    const claim = (await store.claim({ appId: 53,
      ownerId: "sync-compatible-proof", leaseSeconds: 60 }))!;
    const repositories = [
      { id: 40_000, fullName: "public/from-ghes-id" },
      { id: 40_001, fullName: "foreign/wrong-actor" },
    ];
    const result = await store.applyCompleteSnapshot(claim, { accountId: 73, providerActorId: 92,
      completedAt: new Date(), repositories, snapshotHash: hashIds([40_000, 40_001]) });
    assert.equal(result.status, "conflict");
    assert.equal(result.created, 1);
    assert.equal(result.conflicted, 1);
    assert.notEqual(result.tenantId, ghesTenant);
    assert.notEqual(result.tenantId, wrongActorTenant);
    assert.equal((await store.status(53)).syncConflictCount, 1);
    assert.equal((await store.requestSync({ appId: 53, installationId: 63, accountId: 73,
      deliveryId: "positive-compatible-proof-retry", eventClass: "discovery",
      reason: "retry repository conflict" })).accepted, true);
    const retry = (await store.claim({ appId: 53,
      ownerId: "sync-compatible-proof-retry", leaseSeconds: 60 }))!;
    await store.completeRestrictedSnapshot(retry, { state: "unknown",
      reason: "test fixture closes conflict retry", completedAt: new Date() });
  });

  test("explicit account ownership cannot transfer a fresh account through a shared repository ID", async () => {
    const accountATenant = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,quiescence_receipt,
       review_execution_mode,execution_mode_generation,review_execution_state,
       github_app_id,github_account_id,provider_access_state)
      VALUES ($1,$2,'github','https://api.github.com','transfer/account-a','60000','87','github-app:legacy',
        'active',1,2,'{"protocol":"fixture"}'::jsonb,'harness_async',1,'active',57,100,'verified')`,
    [randomUUID(), accountATenant]);
    await store.requestSync({ appId: 57, installationId: 67, accountId: 101,
      deliveryId: "account-transfer-proof", eventClass: "positive", reason: "identity proof fixture" });
    const claim = (await store.claim({ appId: 57,
      ownerId: "account-transfer-proof", leaseSeconds: 60 }))!;
    const repositories = [
      { id: 60_000, fullName: "transfer/account-a" },
      { id: 60_001, fullName: "transfer/account-b-new" },
    ];
    const result = await store.applyCompleteSnapshot(claim, { accountId: 101, providerActorId: 87,
      completedAt: new Date(), repositories, snapshotHash: hashIds([60_000, 60_001]) });
    assert.equal(result.status, "conflict");
    assert.equal(result.conflicted, 1);
    assert.equal(result.created, 1);
    assert.notEqual(result.tenantId, accountATenant);
    const created = await owner.query(`SELECT tenant_id::text,github_account_id::integer
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=57 AND provider_repository_id='60001'`);
    assert.deepEqual(created.rows, [{ tenant_id: result.tenantId, github_account_id: 101 }]);
  });

  test("repository rename collisions persist conflict while the rest of the batch commits", async () => {
    const initialRepositories = [
      { id: 41_000, fullName: "collision/original" },
      { id: 41_001, fullName: "collision/occupied-name" },
    ];
    await store.requestSync({ appId: 54, installationId: 64, accountId: 74,
      deliveryId: "rename-collision-initial", eventClass: "positive", reason: "fixture" });
    const initialClaim = (await store.claim({ appId: 54,
      ownerId: "rename-collision-initial", leaseSeconds: 60 }))!;
    await store.applyCompleteSnapshot(initialClaim, { accountId: 74, providerActorId: 84,
      completedAt: new Date(), repositories: initialRepositories,
      snapshotHash: hashIds(initialRepositories.map(({ id }) => id)) });

    await store.requestSync({ appId: 54, installationId: 64, accountId: 74,
      deliveryId: "rename-collision-next", eventClass: "positive", reason: "fixture" });
    const claim = (await store.claim({ appId: 54,
      ownerId: "rename-collision-next", leaseSeconds: 60 }))!;
    const repositories = [
      { id: 41_000, fullName: "collision/occupied-name" },
      { id: 41_002, fullName: "collision/unrelated" },
    ];
    const result = await store.applyCompleteSnapshot(claim, { accountId: 74, providerActorId: 84,
      completedAt: new Date(), repositories,
      snapshotHash: hashIds(repositories.map(({ id }) => id)) });
    assert.equal(result.status, "conflict");
    assert.equal(result.conflicted, 1);
    assert.equal(result.created, 1);
    const bindings = await owner.query(`SELECT provider_repository_id,repository
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=54
      ORDER BY provider_repository_id::bigint`);
    assert.deepEqual(bindings.rows, [
      { provider_repository_id: "41000", repository: "collision/original" },
      { provider_repository_id: "41001", repository: "collision/occupied-name" },
      { provider_repository_id: "41002", repository: "collision/unrelated" },
    ]);
    assert.equal((await store.status(54)).syncConflictCount, 1);
  });

  test("a crashed first batch resumes and completes 10,000 repositories under production timeouts", async () => {
    await store.requestSync({ appId: 50, installationId: 60, accountId: 70,
      deliveryId: "positive-large", eventClass: "positive", reason: "large complete snapshot" });
    const claim = (await store.claim({ appId: 50, ownerId: "sync-large", leaseSeconds: 60 }))!;
    const repositories = Array.from({ length: 10_000 }, (_, index) => ({
      id: 10_000 + index, fullName: `large/repository-${index}`,
    }));
    const snapshotHash = hashIds(repositories.map(({ id }) => id));
    await restricted.query(`SELECT * FROM pr_agent_harness.github_installation_snapshot_begin(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint[])`, [claim.appId, claim.installationId,
      claim.ownerId, claim.leaseEpoch, claim.claimEpoch, 70, 80, snapshotHash, new Date(),
      repositories.map(({ id }) => String(id))]);
    await restricted.query(`SELECT * FROM pr_agent_harness.github_installation_snapshot_apply_present(
      $1,$2,$3,$4,$5,$6,$7::jsonb)`, [claim.appId, claim.installationId, claim.ownerId,
      claim.leaseEpoch, claim.claimEpoch, snapshotHash, JSON.stringify(repositories.slice(0, 64))]);
    await owner.query(`UPDATE pr_agent_harness.github_installation_sync_state
      SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE github_app_id=$1 AND installation_id=$2`, [claim.appId, claim.installationId]);
    const resumed = (await store.claim({ appId: 50,
      ownerId: "sync-large-resumed", leaseSeconds: 60 }))!;
    assert.equal(resumed.leaseEpoch, claim.leaseEpoch + 1);
    const result = await store.applyCompleteSnapshot(resumed, { accountId: 70, providerActorId: 80,
      completedAt: new Date(), repositories, snapshotHash });
    assert.equal(result.status, "completed");
    assert.equal(result.created, 9_936);
    assert.equal((await owner.query(`SELECT count(*)::integer count FROM pr_agent_harness.integration_bindings
      WHERE github_app_id=50`)).rows[0]!.count, 10_000);
  });

  test("abort stops a 10,000 repository snapshot after the committed batch boundary", async () => {
    await store.requestSync({ appId: 55, installationId: 65, accountId: 75,
      deliveryId: "abort-large", eventClass: "positive", reason: "abort fixture" });
    const claim = (await store.claim({ appId: 55, ownerId: "abort-large", leaseSeconds: 60 }))!;
    const repositories = Array.from({ length: 10_000 }, (_, index) => ({
      id: 50_000 + index, fullName: `abort/repository-${index}`,
    }));
    const controller = new AbortController();
    const originalRenew = store.renew.bind(store);
    let renewals = 0;
    store.renew = async (renewClaim, input) => {
      const renewed = await originalRenew(renewClaim, input);
      renewals += 1;
      if (renewals === 3) controller.abort();
      return renewed;
    };
    try {
      await assert.rejects(store.applyCompleteSnapshot(claim, { accountId: 75, providerActorId: 85,
        completedAt: new Date(), repositories,
        snapshotHash: hashIds(repositories.map(({ id }) => id)) }, controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError");
    } finally {
      store.renew = originalRenew;
    }
    assert.equal(renewals, 3);
    assert.equal((await owner.query(`SELECT count(*)::integer count
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=55`)).rows[0]!.count, 64);
    await store.completeRestrictedSnapshot(claim, { state: "unknown",
      reason: "test fixture closes aborted snapshot", completedAt: new Date() });
  });

  test("a negative event after the first batch fences committed rows and rejects later stale batches", async () => {
    await store.requestSync({ appId: 51, installationId: 61, accountId: 71,
      deliveryId: "positive-interleaved", eventClass: "positive", reason: "interleaved snapshot" });
    const claim = (await store.claim({ appId: 51, ownerId: "sync-interleaved", leaseSeconds: 60 }))!;
    const repositories = Array.from({ length: 65 }, (_, index) => ({
      id: 20_000 + index, fullName: `interleaved/repository-${index}`,
    }));
    const snapshotHash = hashIds(repositories.map(({ id }) => id));
    await restricted.query(`SELECT * FROM pr_agent_harness.github_installation_snapshot_begin(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint[])`, [51, 61, claim.ownerId, claim.leaseEpoch,
      claim.claimEpoch, 71, 81, snapshotHash, new Date(), repositories.map(({ id }) => String(id))]);
    const first = await restricted.query(`SELECT * FROM
      pr_agent_harness.github_installation_snapshot_apply_present($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [51, 61, claim.ownerId, claim.leaseEpoch, claim.claimEpoch, snapshotHash,
      JSON.stringify(repositories.slice(0, 64))]);
    assert.equal(first.rows[0]!.created, 64);
    await store.restrictAndRequest({ appId: 51, installationId: 61, accountId: 71,
      state: "revoked", reason: "installation removed during apply", deliveryId: "negative-interleaved" });
    await assert.rejects(restricted.query(`SELECT * FROM
      pr_agent_harness.github_installation_snapshot_apply_present($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [51, 61, claim.ownerId, claim.leaseEpoch, claim.claimEpoch, snapshotHash,
      JSON.stringify(repositories.slice(64))]), /stale GitHub snapshot lease or epoch/u);
    const committed = await owner.query(`SELECT count(*)::integer count,
      bool_and(provider_access_state='revoked') AS fenced
      FROM pr_agent_harness.integration_bindings WHERE github_app_id=51`);
    assert.deepEqual(committed.rows[0], { count: 64, fenced: true });
    await owner.query(`DELETE FROM pr_agent_harness.github_installation_sync_state WHERE github_app_id=51`);
  });

  test("automatic restoration refuses unresolved publication effects", async () => {
    await store.requestSync({ appId: 52, installationId: 62, accountId: 72,
      deliveryId: "positive-unresolved", eventClass: "positive", reason: "initial snapshot" });
    const initialClaim = (await store.claim({ appId: 52,
      ownerId: "sync-unresolved-initial", leaseSeconds: 60 }))!;
    const repositories = [{ id: 30_000, fullName: "unresolved/repository" }];
    const initial = await store.applyCompleteSnapshot(initialClaim, { accountId: 72, providerActorId: 82,
      completedAt: new Date(), repositories, snapshotHash: hashIds([30_000]) });
    const binding = await owner.query<{ id: string; publication_generation: string }>(`
      SELECT id,publication_generation FROM pr_agent_harness.integration_bindings WHERE github_app_id=52`);
    const operation = buildPublicationIdentity({
      scope: { tenantId: initial.tenantId!, integrationId: binding.rows[0]!.id, platform: "github",
        origin: "https://api.github.com", repository: "unresolved/repository", target: "pull:30",
        revision: "head-unresolved", authorityGeneration: Number(binding.rows[0]!.publication_generation) },
      slot: "review-unresolved", payload: { body: "unresolved" },
    });
    await new RuntimeDatabase(owner).transaction(initial.tenantId!, (client) =>
      preparePublicationInTransaction(client, operation));
    await owner.query(`UPDATE pr_agent_harness.repository_operations SET status='unknown',
      attempt_count=1,dispatched_at=clock_timestamp(),next_reconcile_at=clock_timestamp(),version=version+1
      WHERE tenant_id=$1 AND business_operation_id=$2`, [initial.tenantId, operation.businessOperationId]);
    await store.restrictAndRequest({ appId: 52, installationId: 62, accountId: 72,
      state: "revoked", reason: "repository removed", deliveryId: "negative-unresolved",
      repositoryIds: [30_000] });
    const restoreClaim = (await store.claim({ appId: 52,
      ownerId: "sync-unresolved-restore", leaseSeconds: 60 }))!;
    const restored = await store.applyCompleteSnapshot(restoreClaim, { accountId: 72, providerActorId: 82,
      completedAt: new Date(), repositories, snapshotHash: hashIds([30_000]) });
    assert.equal(restored.conflicted, 1);
    const access = await owner.query(`SELECT provider_access_state FROM pr_agent_harness.integration_bindings
      WHERE github_app_id=52`);
    assert.equal(access.rows[0]!.provider_access_state, "revoked");
    const audit = await owner.query(`SELECT reason_code FROM pr_agent_harness.audit_logs
      WHERE tenant_id=$1 AND action='github.installation.restore' AND decision='denied'`, [initial.tenantId]);
    assert.deepEqual(audit.rows, [{ reason_code: "unresolved_publication_operations" }]);
  });

  test("migration 032 preserves the migration 031 function signatures", async () => {
    const signatures = [
      "pr_agent_harness.github_onboarding_list(uuid,bigint[])",
      "pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text)",
      "pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint)",
      "pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)",
    ];
    const result = await owner.query<{ signature: string; installed: boolean }>(`
      SELECT signature,to_regprocedure(signature) IS NOT NULL AS installed FROM unnest($1::text[]) signature`,
    [signatures]);
    assert.equal(result.rows.every(({ installed }) => installed), true);
  });

  test("status exposes app-scoped backlog ages and conflict counts without identifiers", async () => {
    await store.requestSync({ appId: 90, installationId: 900, accountId: 9_000,
      deliveryId: "status-sync", eventClass: "positive", reason: "status fixture" });
    await store.requestSync({ appId: 91, installationId: 901, accountId: 9_001,
      deliveryId: "other-app-sync", eventClass: "positive", reason: "isolation fixture" });
    const pending = await store.defer({ appId: 90, installationId: 900, accountId: 9_000,
      repositoryId: 90_000, repository: "status/pending", pullNumber: 90, action: "opened",
      deliveryId: "status-pending", sourceHash: "2".repeat(64) });
    const conflict = await store.defer({ appId: 90, installationId: 900, accountId: 9_000,
      repositoryId: 90_001, repository: "status/conflict", pullNumber: 91, action: "opened",
      deliveryId: "status-conflict", sourceHash: "3".repeat(64) });
    await owner.query(`UPDATE pr_agent_harness.github_installation_sync_state
      SET requested_at=clock_timestamp()-interval '2 minutes'
      WHERE github_app_id=90 AND installation_id=900`);
    await owner.query(`INSERT INTO pr_agent_harness.github_installation_sync_state
      (github_app_id,installation_id,github_account_id,requested_epoch,status,last_conflict_count,last_error_code)
      VALUES (90,902,9000,1,'conflict',3,'fixture_conflict')`);
    await owner.query(`UPDATE pr_agent_harness.github_deferred_pull_requests
      SET received_at=clock_timestamp()-interval '90 seconds' WHERE id=$1`, [pending.id]);
    await owner.query(`UPDATE pr_agent_harness.github_deferred_pull_requests
      SET status='conflict',completed_at=clock_timestamp(),last_error_code='fixture_conflict'
      WHERE id=$1`, [conflict.id]);
    const status = await store.status(90);
    assert.equal(status.pendingSyncCount, 1);
    assert.equal(status.syncConflictCount, 3);
    assert.equal(status.pendingDeferredCount, 1);
    assert.equal(status.deferredConflictCount, 1);
    assert.ok((status.oldestSyncAgeSeconds ?? 0) >= 119);
    assert.ok((status.oldestDeferredAgeSeconds ?? 0) >= 89);
    assert.deepEqual(await store.status(92), {
      pendingSyncCount: 0, pendingDeferredCount: 0, syncConflictCount: 0, deferredConflictCount: 0,
    });
  });
}

function hashIds(ids: number[]): string {
  return createHash("sha256").update([...ids].sort((a, b) => a - b).join(",")).digest("hex");
}
