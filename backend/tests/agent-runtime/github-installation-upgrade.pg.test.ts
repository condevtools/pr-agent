import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { GitHubInstallationSyncStore, hashGitHubRepositoryIds } from
  "../../src/agent-runtime/authority/github-installation-sync.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) test.skip("GitHub installation upgrade requires isolated Docker PostgreSQL", () => {});
else {
  if (!new URL(databaseUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");
  const owner = new Pool({ connectionString: databaseUrl, max: 4,
    statement_timeout: 15_000, lock_timeout: 5_000 });
  const tenantId = randomUUID();
  const activeId = randomUUID();
  const blockedId = randomUUID();
  const drainingId = randomUUID();
  const retainedRunId = randomUUID();
  const purgedRunId = randomUUID();
  const retainedKey = "github:delivery:upgrade-retained";
  const purgedKey = "github:delivery:upgrade-purged";
  const retainedHash = "a".repeat(64);

  before(async () => {
    for (const role of ["pr_agent_app", "pr_agent_onboarding"] as const) {
      const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      const ddl = await owner.query<{ sql: string }>(exists.rowCount
        ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) sql"
        : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) sql",
      [role, randomUUID()]);
      await owner.query(ddl.rows[0]!.sql);
    }
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA pr_agent_harness");
      await client.query(`CREATE TABLE pr_agent_harness.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        baseline_manifest_hash text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(await migrationSql("baseline/020_schema.sql"));
      for (let version = 21; version <= 31; version += 1) {
        const name = migrationNames.get(version);
        if (!name) throw new Error(`missing migration fixture ${version}`);
        await client.query(await migrationSql(`migrations/${name}`));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await seed031();
  });

  after(async () => { await owner.end(); });

  test("migration 032 preserves 031 authority, receipts and review delivery identity", async () => {
    const beforeRows = await owner.query(`SELECT id,publication_state,review_execution_state,
      quiescence_receipt FROM pr_agent_harness.integration_bindings
      WHERE tenant_id=$1 ORDER BY id`, [tenantId]);
    assert.equal(beforeRows.rowCount, 3);

    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      await client.query(await migrationSql("migrations/032_github_installation_sync.sql"));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const afterRows = await owner.query(`SELECT id,publication_state,review_execution_state,
      quiescence_receipt FROM pr_agent_harness.integration_bindings
      WHERE tenant_id=$1 ORDER BY id`, [tenantId]);
    assert.deepEqual(afterRows.rows, beforeRows.rows);
    const restriction = await owner.query(`SELECT access_state,reason,delivery_id,version,
      restricted_epoch,resolved_epoch,resolved_by_snapshot_epoch
      FROM pr_agent_harness.github_provider_access_restrictions WHERE github_app_id=7`);
    assert.deepEqual(restriction.rows, [{ access_state: "revoked", reason: "031 fixture restriction",
      delivery_id: "upgrade-restriction", version: "1", restricted_epoch: "1",
      resolved_epoch: null, resolved_by_snapshot_epoch: null }]);
    const receipt = await owner.query(`SELECT requested_state,reason,installation_id,delivery_class,
      requested_epoch,result FROM pr_agent_harness.github_provider_lifecycle_receipts
      WHERE github_app_id=7 AND delivery_id='upgrade-receipt'`);
    assert.deepEqual(receipt.rows, [{ requested_state: "revoked", reason: "031 fixture receipt",
      installation_id: null, delivery_class: "restrictive", requested_epoch: null, result: "accepted" }]);

    const runs = await owner.query(`SELECT id,source_kind,source_key,source_hash,input_json
      FROM pr_agent_harness.agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [[retainedRunId, purgedRunId]]);
    const retained = runs.rows.find(({ id }) => id === retainedRunId)!;
    const purged = runs.rows.find(({ id }) => id === purgedRunId)!;
    assert.deepEqual({ kind: retained.source_kind, key: retained.source_key, hash: retained.source_hash },
      { kind: "github_delivery", key: retainedKey, hash: retainedHash });
    assert.deepEqual({ kind: purged.source_kind, key: purged.source_key, hash: purged.source_hash },
      { kind: null, key: null, hash: null });

    const signatures = await owner.query(`SELECT
      to_regprocedure('pr_agent_harness.github_onboarding_list(uuid,bigint[])') IS NOT NULL old_list,
      to_regprocedure('pr_agent_harness.github_installation_sync_claim(bigint,text,integer)') IS NOT NULL new_claim,
      to_regprocedure('pr_agent_harness.github_installation_sync_claim(text,integer)') IS NULL removed_claim`);
    assert.deepEqual(signatures.rows[0], { old_list: true, new_claim: true, removed_claim: true });

    const handoffClient = await owner.connect();
    try {
      await handoffClient.query("BEGIN");
      await handoffClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const matching = await handoffClient.query(`SELECT status,run_id FROM
        pr_agent_harness.github_delivery_handoff_lock($1,$2,$3,$4)`,
      [tenantId, activeId, retainedKey, retainedHash]);
      const unavailable = await handoffClient.query(`SELECT status,run_id FROM
        pr_agent_harness.github_delivery_handoff_lock($1,$2,$3,$4)`,
      [tenantId, activeId, purgedKey, "b".repeat(64)]);
      assert.deepEqual(matching.rows, [{ status: "matching", run_id: retainedRunId }]);
      assert.deepEqual(unavailable.rows, [{ status: "legacy_hash_unavailable", run_id: purgedRunId }]);
    } finally {
      await handoffClient.query("ROLLBACK");
      handoffClient.release();
    }
  });

  test("032 rejects a whole 10k snapshot atomically while the bounded 64-item store path commits", async () => {
    const huge = Array.from({ length: 10_000 }, (_, index) => ({
      id: 1_000_000 + index, fullName: `bulk/repo-${index}`,
    }));
    await assert.rejects(owner.query(`SELECT * FROM
      pr_agent_harness.github_installation_snapshot_apply_present(99,999,'upgrade-batch',1,1,$1,$2::jsonb)`,
    ["c".repeat(64), JSON.stringify(huge)]), /invalid GitHub snapshot present batch/u);
    assert.equal((await owner.query(`SELECT count(*)::int count FROM pr_agent_harness.integration_bindings
      WHERE repository LIKE 'bulk/%'`)).rows[0]!.count, 0);

    await owner.query(`INSERT INTO pr_agent_harness.github_account_tenant_mappings
      (github_app_id,github_account_id,tenant_id,mapping_source) VALUES (99,999,$1,'auto_created')`, [tenantId]);
    const store = new GitHubInstallationSyncStore(new RuntimeDatabase(owner));
    await store.requestSync({ appId: 99, installationId: 999, accountId: 999,
      deliveryId: "upgrade-bounded", eventClass: "positive", reason: "bounded upgrade fixture" });
    const claim = (await store.claim({ appId: 99, ownerId: "upgrade-batch", leaseSeconds: 60 }))!;
    const repositories = Array.from({ length: 64 }, (_, index) => ({
      id: 2_000_000 + index, fullName: `bulk/repo-${index}`,
    }));
    const applied = await store.applyCompleteSnapshot(claim, { accountId: 999, providerActorId: 9999,
      completedAt: new Date(), snapshotHash: hashGitHubRepositoryIds(repositories.map(({ id }) => id)),
      repositories });
    assert.deepEqual(applied, { tenantId, status: "completed", created: 64, restored: 0,
      adopted: 0, conflicted: 0, revoked: 0 });
    assert.equal((await owner.query(`SELECT count(*)::int count FROM pr_agent_harness.integration_bindings
      WHERE repository LIKE 'bulk/%'`)).rows[0]!.count, 64);
  });

  async function seed031(): Promise<void> {
    await insertBinding(activeId, "upgrade/active", 10_001, "active", "active", { protocol: "031-active" });
    await insertBinding(blockedId, "upgrade/blocked", 10_002, "blocked", "active", { protocol: "031-blocked" });
    await insertBinding(drainingId, "upgrade/draining", 10_003, "draining", "draining",
      { protocol: "031-draining" });
    await owner.query(`INSERT INTO pr_agent_harness.github_provider_access_restrictions
      (github_app_id,installation_id,repository_id,access_state,reason,delivery_id)
      VALUES (7,31,10001,'revoked','031 fixture restriction','upgrade-restriction')`);
    await owner.query(`INSERT INTO pr_agent_harness.github_provider_lifecycle_receipts
      (github_app_id,delivery_id,requested_state,reason)
      VALUES (7,'upgrade-receipt','revoked','031 fixture receipt')`);
    await insertRun(retainedRunId, retainedKey, { source: { key: retainedKey, hash: retainedHash } });
    await insertRun(purgedRunId, purgedKey, {});
  }

  async function insertBinding(id: string, repository: string, repositoryId: number,
    publicationState: "active" | "blocked" | "draining", reviewState: "active" | "draining",
    receipt: Record<string, string>): Promise<void> {
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,quiescence_receipt,
       review_execution_mode,execution_mode_generation,review_execution_state,
       github_app_id,github_account_id,provider_access_state)
      VALUES ($1,$2,'github','https://api.github.com',$3,$4,'81','github-app:31',$5,1,2,$6,
       'harness_async',1,$7,7,501,'verified')`,
    [id, tenantId, repository, String(repositoryId), publicationState, receipt, reviewState]);
  }

  async function insertRun(id: string, key: string, input: Record<string, unknown>): Promise<void> {
    const version = "d".repeat(64);
    await owner.query(`INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
       request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,
       model_version_hash,tool_version_hash,policy_version_hash,runtime_version_hash,input_json)
      VALUES ($1,$2,$3,'service','upgrade-fixture','review.single.v1',$4,$5,'review.single.v1',
       'base','head',$5,$5,$5,$5,$5,$5,$6)`,
    [id, tenantId, activeId, key, version, input]);
  }
}

const migrationNames = new Map<number, string>([
  [21, "021_model_reconciliation.sql"], [22, "022_async_execution_only.sql"],
  [23, "023_postgres_business_state.sql"], [24, "024_verifier_compatibility.sql"],
  [25, "025_schema_owner.sql"], [26, "026_capabilities.sql"], [27, "027_run_artifacts.sql"],
  [28, "028_runtime_scheduling.sql"], [29, "029_verifier_artifacts.sql"],
  [30, "030_maintenance_retention.sql"], [31, "031_github_onboarding.sql"],
]);

async function migrationSql(relativePath: string): Promise<string> {
  const url = new URL(`../../src/agent-runtime/postgres/${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}
