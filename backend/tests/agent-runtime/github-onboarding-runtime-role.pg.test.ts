import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { assertGitHubOnboardingRole } from "../../src/agent-runtime/runtime/github-onboarding.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (!databaseUrl) {
  test.skip("onboarding runtime role drift requires isolated Docker PostgreSQL", () => {});
} else {
  const owner = new Pool({ connectionString: databaseUrl });
  let onboarding: Pool;
  before(async () => {
    const password = randomUUID();
    const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_onboarding'");
    const statement = await owner.query<{ sql: string }>(exists.rowCount
      ? "SELECT format('ALTER ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text) sql"
      : "SELECT format('CREATE ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text) sql", [password]);
    await owner.query(statement.rows[0]!.sql);
    await migrateRuntime(owner);
    const url = new URL(databaseUrl);
    url.username = "pr_agent_onboarding"; url.password = password;
    onboarding = new Pool({ connectionString: url.toString() });
  });
  after(async () => { await onboarding?.end(); await owner.end(); });

  test("startup role assertion detects attribute, membership, table, sequence, ownership and function privilege drift", async () => {
    await assertGitHubOnboardingRole(onboarding);
    assert.equal((await onboarding.query(
      "SELECT pr_agent_harness.is_harness_admin() AS admin")).rows[0]!.admin, false);
    await assert.rejects(onboarding.query(
      "SELECT pr_agent_harness.guard_run_artifact_mutation()"), /trigger functions can only be called as triggers/u);
    const original = await owner.query<{ signature: string }>(`SELECT p.oid::regprocedure::text signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pr_agent_harness' AND has_function_privilege('pr_agent_onboarding',p.oid,'EXECUTE')`);
    const cases = [
      ["ALTER ROLE pr_agent_onboarding INHERIT", "ALTER ROLE pr_agent_onboarding NOINHERIT"],
      ["ALTER ROLE pr_agent_onboarding REPLICATION", "ALTER ROLE pr_agent_onboarding NOREPLICATION"],
      ["GRANT CREATE ON SCHEMA pr_agent_harness TO pr_agent_onboarding", "REVOKE CREATE ON SCHEMA pr_agent_harness FROM pr_agent_onboarding"],
      ["GRANT SELECT ON pr_agent_harness.agent_runs TO pr_agent_onboarding", "REVOKE SELECT ON pr_agent_harness.agent_runs FROM pr_agent_onboarding"],
      ["GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pr_agent_harness TO pr_agent_onboarding",
        `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pr_agent_harness FROM pr_agent_onboarding;
         GRANT EXECUTE ON FUNCTION ${original.rows.map(({ signature }) => signature).join(",")} TO pr_agent_onboarding`],
    ];
    await owner.query("CREATE ROLE onboarding_drift_peer NOLOGIN; CREATE SEQUENCE pr_agent_harness.onboarding_drift_seq");
    cases.push(
      ["GRANT pr_agent_onboarding TO onboarding_drift_peer", "REVOKE pr_agent_onboarding FROM onboarding_drift_peer"],
      ["GRANT onboarding_drift_peer TO pr_agent_onboarding", "REVOKE onboarding_drift_peer FROM pr_agent_onboarding"],
      ["GRANT USAGE ON SEQUENCE pr_agent_harness.onboarding_drift_seq TO pr_agent_onboarding",
        "REVOKE USAGE ON SEQUENCE pr_agent_harness.onboarding_drift_seq FROM pr_agent_onboarding"],
      ["ALTER SEQUENCE pr_agent_harness.onboarding_drift_seq OWNER TO pr_agent_onboarding",
        "ALTER SEQUENCE pr_agent_harness.onboarding_drift_seq OWNER TO CURRENT_USER"],
    );
    for (const [change, restore] of cases) {
      await owner.query(change!);
      try { await assert.rejects(assertGitHubOnboardingRole(onboarding), /dedicated restricted/u, change); }
      finally { await owner.query(restore!); }
      await assertGitHubOnboardingRole(onboarding);
    }
    await owner.query("DROP SEQUENCE pr_agent_harness.onboarding_drift_seq; DROP ROLE onboarding_drift_peer");
  });
}
