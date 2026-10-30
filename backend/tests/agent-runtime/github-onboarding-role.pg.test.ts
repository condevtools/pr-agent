import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { Client, Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";

const testUrl = process.env.HARNESS_TEST_DATABASE_URL;
const container = process.env.HARNESS_TEST_DOCKER_CONTAINER;

if (!testUrl || !container) {
  test.skip("GitHub onboarding role bootstrap requires the Docker PostgreSQL test runner", () => {});
} else {
  if (!new URL(testUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable DB required");
  if (!container.startsWith("pr-agent-harness-test-")) throw new Error("Owned Docker test container required");

  test("operator bootstrap creates an idempotent least-privilege onboarding login", async () => {
    const clusterPassword = decodeURIComponent(new URL(testUrl).password);
    const firstPassword = randomUUID();
    const rotatedPassword = randomUUID();
    const inheritorRole = `onboarding_inheritor_${randomUUID().replaceAll("-", "")}`;
    const cluster = new Client({ connectionString: testUrl });
    let owner: Pool | undefined;
    let onboarding: Pool | undefined;
    let inheritorCreated = false;
    await cluster.connect();
    const roleExisted = (await cluster.query(
      "SELECT 1 FROM pg_roles WHERE rolname='pr_agent_onboarding'",
    )).rowCount === 1;
    try {
      await cluster.query("DROP DATABASE IF EXISTS pr_agent WITH (FORCE)");
      await cluster.query("CREATE DATABASE pr_agent OWNER postgres");
      const ownerUrl = new URL(testUrl);
      ownerUrl.pathname = "/pr_agent";
      owner = new Pool({ connectionString: ownerUrl.toString(), max: 2 });
      await migrateRuntime(owner);

      const operatorSql = await readFile(
        new URL("../../../docker/postgres/enable-github-onboarding.sql", import.meta.url), "utf8");
      const missing = invokeOperatorScript(clusterPassword, "", operatorSql);
      assert.notEqual(missing.status, 0, "an empty onboarding password must be rejected");

      runOperatorScript(clusterPassword, firstPassword, operatorSql);
      onboarding = new Pool({ connectionString: roleUrl(ownerUrl, firstPassword), max: 1 });
      const role = await onboarding.query<{
        rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean;
        rolcreaterole: boolean; rolinherit: boolean; rolreplication: boolean; rolbypassrls: boolean;
      }>(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
          FROM pg_roles WHERE rolname=current_user`);
      assert.deepEqual(role.rows[0], {
        rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false,
      });
      await assert.rejects(
        onboarding.query("SELECT * FROM pr_agent_harness.integration_bindings"),
        /permission denied/u,
      );
      const directGrants = await owner.query<{ routine_name: string }>(
        `SELECT routine_name FROM information_schema.routine_privileges
         WHERE specific_schema='pr_agent_harness' AND grantee='pr_agent_onboarding'
         ORDER BY routine_name`,
      );
      assert.deepEqual(directGrants.rows.map((row) => row.routine_name), [
        "github_onboarding_enroll", "github_onboarding_invalidate",
        "github_onboarding_list", "github_onboarding_revalidate",
      ]);
      const scopedTenantId = randomUUID();
      const scoped = await onboarding.connect();
      try {
        await scoped.query("BEGIN");
        await scoped.query("SELECT set_config('app.tenant_id',$1,true)", [scopedTenantId]);
        const listed = await scoped.query(
          "SELECT * FROM pr_agent_harness.github_onboarding_list($1,ARRAY[]::bigint[])",
          [scopedTenantId],
        );
        assert.equal(listed.rowCount, 0);
        await scoped.query("ROLLBACK");
      } finally {
        scoped.release();
      }

      await onboarding.end();
      onboarding = undefined;
      await cluster.query(`CREATE ROLE ${inheritorRole} NOLOGIN`);
      inheritorCreated = true;
      await cluster.query(`GRANT pr_agent_onboarding TO ${inheritorRole}`);
      const inherited = invokeOperatorScript(clusterPassword, rotatedPassword, operatorSql);
      assert.notEqual(inherited.status, 0);
      assert.match(inherited.stderr, /participates in role membership; operator review required/u);
      for (const secret of [clusterPassword, rotatedPassword]) {
        assert.equal(`${inherited.stdout}\n${inherited.stderr}`.includes(secret), false,
          "rejected operator output exposed a password");
      }
      await cluster.query(`REVOKE pr_agent_onboarding FROM ${inheritorRole}`);
      await cluster.query(`DROP ROLE ${inheritorRole}`);
      inheritorCreated = false;
      runOperatorScript(clusterPassword, rotatedPassword, operatorSql);
      const oldLogin = new Client({ connectionString: roleUrl(ownerUrl, firstPassword) });
      await assert.rejects(oldLogin.connect(), /password authentication failed/u);
      await oldLogin.end().catch(() => undefined);
      onboarding = new Pool({ connectionString: roleUrl(ownerUrl, rotatedPassword), max: 1 });
      assert.equal((await onboarding.query("SELECT current_user AS role")).rows[0].role, "pr_agent_onboarding");
    } finally {
      await onboarding?.end();
      await owner?.end();
      await cluster.query("DROP DATABASE IF EXISTS pr_agent WITH (FORCE)");
      if (inheritorCreated) await cluster.query(`DROP ROLE IF EXISTS ${inheritorRole}`);
      if (!roleExisted) await cluster.query("DROP ROLE IF EXISTS pr_agent_onboarding");
      await cluster.end();
    }
  });

  function runOperatorScript(adminPassword: string, onboardingPassword: string, sql: string): void {
    const result = invokeOperatorScript(adminPassword, onboardingPassword, sql);
    assert.equal(result.status, 0, result.stderr);
    for (const secret of [adminPassword, onboardingPassword]) {
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false, "operator output exposed a password");
    }
  }

  function invokeOperatorScript(adminPassword: string, onboardingPassword: string, sql: string) {
    return spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD", "-e", "HARNESS_ONBOARDING_PASSWORD",
      container, "psql", "-X", "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
      "-U", "postgres", "-d", "pr_agent"], {
      input: sql, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, PGPASSWORD: adminPassword, HARNESS_ONBOARDING_PASSWORD: onboardingPassword },
    });
  }
}

function roleUrl(ownerUrl: URL, password: string): string {
  const value = new URL(ownerUrl);
  value.username = "pr_agent_onboarding";
  value.password = password;
  return value.toString();
}
