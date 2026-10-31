import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) test.skip("Issue Triage upgrade requires isolated Docker PostgreSQL", () => {});
else {
  if (!new URL(databaseUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");

  test("migration 033 upgrades a populated 032 schema without widening platform or role access", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4,
      statement_timeout: 15_000, lock_timeout: 5_000 });
    const tenantId = randomUUID();
    const githubId = randomUUID();
    const gitlabId = randomUUID();
    try {
      await ensureRestrictedRoles(pool);
      // Roles belong to the shared test cluster, not the fresh per-file database.
      await ensureRestrictedRoles(pool);
      await installSchemaThrough032(pool);
      await seedBindings(pool, { tenantId, githubId, gitlabId });

      const before = await retainedBindings(pool, tenantId);
      assert.equal(before.length, 2);
      assert.equal((await pool.query("SELECT count(*)::int count FROM pr_agent_harness.schema_migrations"))
        .rows[0]!.count, 32);

      await migrateRuntime(pool);

      const upgraded = await pool.query(`SELECT id,platform,origin,repository,publication_state,
        publication_generation,authority_version,review_execution_mode,execution_mode_generation,
        review_execution_state,quiescence_receipt,issue_triage_enabled
        FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 ORDER BY platform`, [tenantId]);
      assert.deepEqual(upgraded.rows.map(({ issue_triage_enabled: _enabled, ...row }) => row), before);
      assert.deepEqual(upgraded.rows.map(({ platform, issue_triage_enabled }) =>
        ({ platform, issue_triage_enabled })), [
        { platform: "github", issue_triage_enabled: true },
        { platform: "gitlab", issue_triage_enabled: true },
      ]);

      await pool.query("SET ROLE pr_agent_app");
      const capabilities = await pool.query(`SELECT $1::text AS platform,capability_enabled FROM
          pr_agent_harness.lock_current_binding_capability($2,$3,'issue.triage')
        UNION ALL SELECT $4::text,capability_enabled FROM
          pr_agent_harness.lock_current_binding_capability($2,$5,'issue.triage')
        ORDER BY platform`, ["github", tenantId, githubId, "gitlab", gitlabId]);
      await pool.query("RESET ROLE");
      assert.deepEqual(capabilities.rows, [
        { platform: "github", capability_enabled: true },
        { platform: "gitlab", capability_enabled: false },
      ]);

      const functions = await pool.query(`SELECT p.proname,
        pg_get_function_identity_arguments(p.oid) AS arguments,p.prosecdef,
        p.proconfig @> ARRAY['search_path=pg_catalog, pr_agent_harness']::text[] AS safe_path,
        has_function_privilege('pr_agent_app',p.oid,'EXECUTE') AS app_execute,
        has_function_privilege('pr_agent_verifier',p.oid,'EXECUTE') AS verifier_execute,
        has_function_privilege('pr_agent_onboarding',p.oid,'EXECUTE') AS onboarding_execute,
        COALESCE((SELECT bool_or(acl.privilege_type='EXECUTE')
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0),false) AS public_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='pr_agent_harness' AND p.proname IN
          ('lock_current_binding_capability','reserve_runtime_bindings') ORDER BY p.proname`);
      assert.deepEqual(functions.rows, [
        { proname: "lock_current_binding_capability",
          arguments: "requested_tenant_id uuid, requested_integration_id uuid, requested_capability text",
          prosecdef: true, safe_path: true, app_execute: true, verifier_execute: false,
          onboarding_execute: false, public_execute: false },
        { proname: "reserve_runtime_bindings",
          arguments: "requested_queue_class text, requested_runtime_hash text, requested_workflows text[], requested_limit integer, requested_per_binding_limit integer",
          prosecdef: true, safe_path: true, app_execute: true, verifier_execute: false,
          onboarding_execute: false, public_execute: false },
      ]);

      const migrationSql = await readMigration("033_issue_triage.sql");
      const ledger = await pool.query(`SELECT migration_name,checksum_sha256 FROM
        pr_agent_harness.schema_migrations WHERE migration_name='033_issue_triage.sql'`);
      assert.deepEqual(ledger.rows, [{ migration_name: "033_issue_triage.sql",
        checksum_sha256: sha256(migrationSql) }]);

      const afterFirstUpgrade = await upgradeSnapshot(pool, tenantId);
      await migrateRuntime(pool);
      assert.deepEqual(await upgradeSnapshot(pool, tenantId), afterFirstUpgrade);
    } finally {
      await pool.query("RESET ROLE").catch(() => undefined);
      await pool.end();
    }
  });
}

interface BaselineManifest {
  migrations: Array<{ name: string; checksum: string }>;
}

async function ensureRestrictedRoles(pool: Pool): Promise<void> {
  for (const role of ["pr_agent_app", "pr_agent_verifier", "pr_agent_onboarding"] as const) {
    const ddl = await pool.query<{ sql: string }>(`SELECT format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      $1::text) AS sql WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1)`, [role]);
    if (ddl.rows[0]) await pool.query(ddl.rows[0].sql);
    const attributes = await pool.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=$1`, [role]);
    assert.deepEqual(attributes.rows, [{ rolsuper: false, rolcreatedb: false,
      rolcreaterole: false, rolreplication: false, rolbypassrls: false }],
    `${role} must remain a restricted role when reused by another test`);
  }
}

async function installSchemaThrough032(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA pr_agent_harness; CREATE TABLE pr_agent_harness.schema_migrations (
      migration_name text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      baseline_manifest_hash text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(await readPostgresFile("baseline/020_schema.sql"));
    const manifest = JSON.parse(await readPostgresFile("baseline/manifest.json")) as BaselineManifest;
    for (const entry of manifest.migrations) {
      await client.query(`INSERT INTO pr_agent_harness.schema_migrations
        (migration_name,checksum_sha256) VALUES ($1,$2)`, [entry.name, entry.checksum]);
    }
    const names = (await readdir(new URL("../../src/agent-runtime/postgres/migrations/", import.meta.url)))
      .filter((name) => /^(02[1-9]|03[0-2])_[a-z0-9_]+\.sql$/u.test(name)).sort();
    assert.equal(names.length, 12);
    for (const name of names) {
      const sql = await readMigration(name);
      await client.query(sql);
      await client.query(`INSERT INTO pr_agent_harness.schema_migrations
        (migration_name,checksum_sha256) VALUES ($1,$2)`, [name, sha256(sql)]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedBindings(pool: Pool, input: {
  tenantId: string; githubId: string; gitlabId: string;
}): Promise<void> {
  for (const binding of [
    { id: input.githubId, platform: "github", origin: "https://api.github.com",
      repository: "upgrade/github", repositoryId: "33001", credential: "github-app:33" },
    { id: input.gitlabId, platform: "gitlab", origin: "https://gitlab.com",
      repository: "upgrade/gitlab", repositoryId: "33002", credential: "env:GITLAB_TOKEN" },
  ]) {
    await pool.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,quiescence_receipt,
       review_execution_mode,execution_mode_generation,review_execution_state)
      VALUES ($1,$2,$3,$4,$5,$6,'33000',$7,'active',3,7,$8,'harness_async',4,'active')`,
    [binding.id, input.tenantId, binding.platform, binding.origin, binding.repository,
      binding.repositoryId, binding.credential, { fixture: "schema-032", platform: binding.platform }]);
  }
}

async function retainedBindings(pool: Pool, tenantId: string): Promise<Record<string, unknown>[]> {
  return (await pool.query(`SELECT id,platform,origin,repository,publication_state,
    publication_generation,authority_version,review_execution_mode,execution_mode_generation,
    review_execution_state,quiescence_receipt
    FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 ORDER BY platform`, [tenantId])).rows;
}

async function upgradeSnapshot(pool: Pool, tenantId: string): Promise<unknown> {
  const bindings = await pool.query(`SELECT id,platform,origin,repository,issue_triage_enabled
    FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 ORDER BY platform`, [tenantId]);
  const ledger = await pool.query(`SELECT migration_name,checksum_sha256 FROM
    pr_agent_harness.schema_migrations ORDER BY migration_name`);
  const functions = await pool.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) arguments,
    p.prosecdef,p.proconfig,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pr_agent_harness' AND p.proname IN
      ('lock_current_binding_capability','reserve_runtime_bindings') ORDER BY p.proname`);
  return { bindings: bindings.rows, ledger: ledger.rows, functions: functions.rows };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

async function readMigration(name: string): Promise<string> {
  return readPostgresFile(`migrations/${name}`);
}

async function readPostgresFile(relativePath: string): Promise<string> {
  return readFile(new URL(`../../src/agent-runtime/postgres/${relativePath}`, import.meta.url), "utf8");
}
