import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { Client, Pool } from "pg";

const testUrl = process.env.HARNESS_TEST_DATABASE_URL;
const container = process.env.HARNESS_TEST_DOCKER_CONTAINER;

if (!testUrl || !container) {
  test.skip("Runtime role upgrade requires the Docker PostgreSQL test runner", () => {});
} else {
  if (!new URL(testUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable DB required");
  if (!container.startsWith("pr-agent-harness-test-")) throw new Error("Owned Docker test container required");

  test("old superuser-owned volume transitions without losing data before migrations 021+", async () => {
    const runnerUrl = new URL(testUrl);
    const originalPostgresPassword = decodeURIComponent(runnerUrl.password);
    const legacyPassword = randomUUID();
    const bootstrapPassword = randomUUID();
    const appPassword = randomUUID();
    const verifierPassword = randomUUID();
    const maintenancePassword = randomUUID();
    const migrationPassword = randomUUID();
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();
    const attemptId = randomUUID();
    const modelCallId = randomUUID();
    const hash = "a".repeat(64);
    const admin = new Client({ connectionString: testUrl });
    let legacy: Pool | undefined;
    let app: Pool | undefined;
    await admin.connect();
    // Roles belong to the test cluster, not the per-file database. Earlier
    // suites may already have grants to the shared runtime role identities.
    const existingRoles = new Set((await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",
      [["pr_agent_app", "pr_agent_verifier", "pr_agent_maintenance", "pr_agent_migrator"]],
    )).rows.map((row) => row.rolname));
    try {
      await admin.query(`CREATE ROLE pr_agent_migrator LOGIN PASSWORD '${legacyPassword}'
        SUPERUSER CREATEDB CREATEROLE BYPASSRLS`);
      await admin.query("CREATE DATABASE pr_agent OWNER pr_agent_migrator");
      const legacyUrl = new URL(testUrl);
      legacyUrl.pathname = "/pr_agent";
      legacyUrl.username = "pr_agent_migrator";
      legacyUrl.password = legacyPassword;
      legacy = new Pool({ connectionString: legacyUrl.toString(), max: 2 });
      await installLegacySchema(legacy);
      await legacy.query(`CREATE ROLE foreign_schema_object NOLOGIN;
        GRANT USAGE,CREATE ON SCHEMA pr_agent_harness TO foreign_schema_object;
        SET ROLE foreign_schema_object;
        CREATE COLLATION pr_agent_harness.foreign_owned_collation (provider=libc,locale='C');
        RESET ROLE`);
      await seedLegacyData(legacy, { tenantId, integrationId, runId, stepId, attemptId, modelCallId, hash });

      const upgradeSql = await readFile(
        new URL("../../../docker/postgres/upgrade-runtime-roles.sql", import.meta.url), "utf8");
      const upgradeSecrets = {
        HARNESS_BOOTSTRAP_PASSWORD: bootstrapPassword,
        HARNESS_APP_PASSWORD: appPassword,
        HARNESS_VERIFIER_PASSWORD: verifierPassword,
        HARNESS_MAINTENANCE_PASSWORD: maintenancePassword,
        HARNESS_MIGRATION_PASSWORD: migrationPassword,
      };
      const rejected = invokeOperatorScript("pr_agent_migrator", legacyPassword, upgradeSql, upgradeSecrets);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /objects not owned by pr_agent_migrator; operator review required/);
      assertNoPasswordOutput(rejected.stdout, rejected.stderr, legacyPassword, upgradeSecrets);
      await legacy.query(`DROP COLLATION pr_agent_harness.foreign_owned_collation;
        REVOKE ALL ON SCHEMA pr_agent_harness FROM foreign_schema_object;
        DROP ROLE foreign_schema_object`);
      runOperatorScript("pr_agent_migrator", legacyPassword, upgradeSql, {
        ...upgradeSecrets,
      });

      legacyUrl.password = migrationPassword;
      const migrated = spawnSync(process.execPath,
        ["--import", "tsx", "src/agent-runtime/cli.ts", "migrate"], {
          cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
          env: { ...process.env, HARNESS_DATABASE_URL: legacyUrl.toString() },
        });
      assert.equal(migrated.status, 0, migrated.stderr);
      assert.match(migrated.stdout, /versioned migrations and role grants applied/);

      await legacy.end();
      legacy = new Pool({ connectionString: legacyUrl.toString(), max: 2 });
      const role = await legacy.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        "SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      assert.equal((await legacy.query("SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname='pr_agent_harness'"))
        .rows[0].owner, "pr_agent_migrator");

      const binding = await legacy.query(
        "SELECT review_execution_mode,execution_mode_generation,repository FROM pr_agent_harness.integration_bindings WHERE id=$1",
        [integrationId]);
      assert.deepEqual(binding.rows[0], {
        review_execution_mode: "harness_async", execution_mode_generation: "1", repository: "legacy/repository",
      });
      const reservation = await legacy.query(
        `SELECT status,reserved_cost_micros,reconciliation_due_at=updated_at+interval '5 minutes' due_matches,
                next_reconcile_at=reconciliation_due_at next_matches
         FROM pr_agent_harness.model_budget_reservations WHERE tenant_id=$1 AND model_call_id=$2`,
        [tenantId, modelCallId]);
      assert.deepEqual(reservation.rows[0], {
        status: "pending", reserved_cost_micros: "300", due_matches: true, next_matches: true,
      });
      assert.equal((await legacy.query("SELECT count(*)::int n FROM pr_agent_harness.agent_runs WHERE id=$1", [runId]))
        .rows[0].n, 1);
      const policies = await legacy.query<{ forced: string; maintained: string }>(`SELECT
        count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::text forced,
        count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
          SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='schema_owner_maintenance'))::text maintained
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pr_agent_harness' AND c.relkind IN ('r','p')`);
      assert.equal(policies.rows[0]!.maintained, policies.rows[0]!.forced);

      runOperatorScript("postgres", bootstrapPassword, upgradeSql, {
        HARNESS_BOOTSTRAP_PASSWORD: bootstrapPassword,
        HARNESS_APP_PASSWORD: appPassword,
        HARNESS_VERIFIER_PASSWORD: verifierPassword,
        HARNESS_MAINTENANCE_PASSWORD: maintenancePassword,
        HARNESS_MIGRATION_PASSWORD: migrationPassword,
      });
      const repeated = spawnSync(process.execPath,
        ["--import", "tsx", "src/agent-runtime/cli.ts", "migrate"], {
          cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
          env: { ...process.env, HARNESS_DATABASE_URL: legacyUrl.toString() },
        });
      assert.equal(repeated.status, 0, repeated.stderr);
      const migrationInventory = (await readdir(new URL("../../src/agent-runtime/postgres/migrations/", import.meta.url)))
        .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name));
      assert.equal((await legacy.query("SELECT count(*)::int n FROM pr_agent_harness.schema_migrations"))
        .rows[0].n, migrationInventory.length);

      const appUrl = new URL(legacyUrl);
      appUrl.username = "pr_agent_app";
      appUrl.password = appPassword;
      app = new Pool({ connectionString: appUrl.toString(), max: 1 });
      assert.equal((await app.query("SELECT count(*)::int n FROM pr_agent_harness.agent_runs")).rows[0].n, 0);
      const visible = await app.connect();
      try {
        await visible.query("BEGIN");
        await visible.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
        assert.equal((await visible.query("SELECT count(*)::int n FROM pr_agent_harness.agent_runs WHERE id=$1", [runId]))
          .rows[0].n, 1);
        await visible.query("ROLLBACK");
      } finally { visible.release(); }
    } finally {
      try {
        await app?.end();
        await legacy?.end();
        await admin.query(`ALTER ROLE postgres PASSWORD '${originalPostgresPassword}'`);
        await admin.query("DROP DATABASE IF EXISTS pr_agent WITH (FORCE)");
        for (const role of ["pr_agent_app", "pr_agent_verifier", "pr_agent_maintenance", "pr_agent_migrator"]) {
          if (!existingRoles.has(role)) await admin.query(`DROP ROLE IF EXISTS ${role}`);
        }
      } finally { await admin.end(); }
    }
  });

  function runOperatorScript(user: string, password: string, sql: string, secrets: Record<string, string>): void {
    const result = invokeOperatorScript(user, password, sql, secrets);
    assert.equal(result.status, 0, result.stderr);
    assertNoPasswordOutput(result.stdout, result.stderr, password, secrets);
  }

  function invokeOperatorScript(user: string, password: string, sql: string, secrets: Record<string, string>) {
    return spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD",
      "-e", "HARNESS_BOOTSTRAP_PASSWORD", "-e", "HARNESS_APP_PASSWORD",
      "-e", "HARNESS_VERIFIER_PASSWORD", "-e", "HARNESS_MAINTENANCE_PASSWORD",
      "-e", "HARNESS_MIGRATION_PASSWORD",
      container, "psql", "-X", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "pr_agent"], {
      input: sql, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, PGPASSWORD: password, ...secrets },
    });
  }

  function assertNoPasswordOutput(
    stdout: string,
    stderr: string,
    password: string,
    secrets: Record<string, string>,
  ): void {
    for (const secret of [password, ...Object.values(secrets)]) {
      assert.equal(`${stdout}\n${stderr}`.includes(secret), false, "operator output exposed a password");
    }
  }
}

async function installLegacySchema(pool: Pool): Promise<void> {
  const baseline = await readFile(
    new URL("../../src/agent-runtime/postgres/baseline/020_schema.sql", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(
    new URL("../../src/agent-runtime/postgres/baseline/manifest.json", import.meta.url), "utf8")) as {
      migrations: Array<{ name: string; checksum: string }>;
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA pr_agent_harness;
      CREATE TABLE pr_agent_harness.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        baseline_manifest_hash text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query(baseline);
    for (const migration of manifest.migrations) {
      await client.query(`INSERT INTO pr_agent_harness.schema_migrations
        (migration_name,checksum_sha256) VALUES ($1,$2)`, [migration.name, migration.checksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function seedLegacyData(pool: Pool, ids: {
  tenantId: string; integrationId: string; runId: string; stepId: string;
  attemptId: string; modelCallId: string; hash: string;
}): Promise<void> {
  await pool.query(`INSERT INTO pr_agent_harness.integration_bindings
    (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
     publication_state,publication_generation,authority_version,quiescence_receipt,
     review_execution_mode,execution_mode_generation,review_execution_state)
    VALUES ($1,$2,'github','https://github.example.test','legacy/repository','42','7','env:GITHUB_TOKEN',
      'active',1,1,'{}'::jsonb,'legacy_sync',0,'active')`, [ids.integrationId, ids.tenantId]);
  await pool.query(`INSERT INTO pr_agent_harness.agent_runs
    (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
     run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
     policy_version_hash,runtime_version_hash,input_json,status,authority_generation)
    VALUES ($1,$2,$3,'service','legacy-fixture','legacy-upgrade','one',$4,'review','base','head',$4,$4,$4,$4,$4,$4,
      '{}'::jsonb,'queued',1)`, [ids.runId, ids.tenantId, ids.integrationId, ids.hash]);
  await pool.query(`INSERT INTO pr_agent_harness.agent_steps
    (id,tenant_id,run_id,step_key,step_kind,input_hash,status,last_lease_epoch,attempt_count)
    VALUES ($1,$2,$3,'model','model',$4,'running',1,1)`, [ids.stepId, ids.tenantId, ids.runId, ids.hash]);
  await pool.query(`INSERT INTO pr_agent_harness.step_attempts
    (id,tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status)
    VALUES ($1,$2,$3,$4,1,'legacy-worker',1,'running')`,
  [ids.attemptId, ids.tenantId, ids.runId, ids.stepId]);
  await pool.query(`INSERT INTO pr_agent_harness.model_calls
    (id,tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,request_hash,
     input_token_bound,output_token_bound,status,lease_epoch)
    VALUES ($1,$2,$3,$4,$5,1,'openai-compatible','legacy-model','review.single.v1',$6,100,50,'unknown',1)`,
  [ids.modelCallId, ids.tenantId, ids.runId, ids.stepId, ids.attemptId, ids.hash]);
  await pool.query(`INSERT INTO pr_agent_harness.model_budget_reservations
    (tenant_id,run_id,model_call_id,reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,status,updated_at)
    VALUES ($1,$2,$3,100,50,300,'pending','2026-01-02T03:04:05Z')`,
  [ids.tenantId, ids.runId, ids.modelCallId]);
}
