import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("GitHub installation sync role checks require isolated Docker PostgreSQL", () => {});
} else {
  const owner = new Pool({ connectionString: databaseUrl });
  const onboardingPassword = randomUUID();
  const appPassword = randomUUID();
  let onboarding: Pool;
  let app: Pool;

  before(async () => {
    for (const [role, password] of [["pr_agent_onboarding", onboardingPassword], ["pr_agent_app", appPassword]]) {
      const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      const ddl = await owner.query<{ sql: string }>(exists.rowCount
        ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) AS sql"
        : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) AS sql",
      [role, password]);
      await owner.query(ddl.rows[0]!.sql);
    }
    await migrateRuntime(owner);
    onboarding = new Pool({ connectionString: roleUrl("pr_agent_onboarding", onboardingPassword) });
    app = new Pool({ connectionString: roleUrl("pr_agent_app", appPassword) });
  });

  after(async () => {
    await onboarding?.end();
    await app?.end();
    await owner.end();
  });

  test("onboarding role has no table privileges and the exact new function family", async () => {
    const attributes = await onboarding.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,
      rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    assert.deepEqual(attributes.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false });
    const tablePrivileges = await owner.query(`SELECT 1 FROM information_schema.role_table_grants
      WHERE grantee='pr_agent_onboarding' AND table_schema='pr_agent_harness'`);
    assert.equal(tablePrivileges.rowCount, 0);
    await assert.rejects(onboarding.query("SELECT * FROM pr_agent_harness.agent_runs"), /permission denied/u);
    const granted = await owner.query<{ proname: string }>(`
      SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pr_agent_harness' AND p.proacl IS NOT NULL
        AND has_function_privilege('pr_agent_onboarding',p.oid,'EXECUTE')
        AND (p.proname LIKE 'github_installation_%' OR p.proname LIKE 'github_deferred_pull_request_%')
      ORDER BY p.proname`);
    assert.deepEqual(granted.rows.map(({ proname }) => proname), [
      "github_deferred_pull_request_admit",
      "github_deferred_pull_request_claim",
      "github_deferred_pull_request_complete",
      "github_installation_restrict_and_request",
      "github_installation_snapshot_absence_candidates",
      "github_installation_snapshot_apply_absent",
      "github_installation_snapshot_apply_present",
      "github_installation_snapshot_begin",
      "github_installation_snapshot_complete",
      "github_installation_snapshot_complete_restricted",
      "github_installation_sync_claim",
      "github_installation_sync_cleanup",
      "github_installation_sync_fail",
      "github_installation_sync_known",
      "github_installation_sync_renew",
      "github_installation_sync_request",
      "github_installation_sync_status",
    ]);
    const claimSignatures = await owner.query<{
      sync_claim: boolean; deferred_claim: boolean; old_sync_claim: string | null;
      old_deferred_claim: string | null;
    }>(`SELECT
      has_function_privilege('pr_agent_onboarding',
        'pr_agent_harness.github_installation_sync_claim(bigint,text,integer)','EXECUTE') AS sync_claim,
      has_function_privilege('pr_agent_onboarding',
        'pr_agent_harness.github_deferred_pull_request_claim(bigint,text,integer)','EXECUTE') AS deferred_claim,
      to_regprocedure('pr_agent_harness.github_installation_sync_claim(text,integer)')::text AS old_sync_claim,
      to_regprocedure('pr_agent_harness.github_deferred_pull_request_claim(text,integer)')::text AS old_deferred_claim`);
    assert.deepEqual(claimSignatures.rows[0], {
      sync_claim: true, deferred_claim: true, old_sync_claim: null, old_deferred_claim: null,
    });
    await assert.rejects(onboarding.query(
      "SELECT * FROM pr_agent_harness.github_delivery_handoff_lock($1,$2,$3,$4)",
      [randomUUID(), randomUUID(), "github:delivery:x", "a".repeat(64)]), /permission denied/u);
  });

  test("app role has handoff authority but no installation mutation authority", async () => {
    await assert.rejects(app.query(`SELECT * FROM pr_agent_harness.github_installation_sync_request(
      1,2,3,'delivery','positive','reason')`), /permission denied/u);
    const granted = await owner.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pr_agent_harness' AND p.proname LIKE 'github_%handoff%'
        AND p.proacl IS NOT NULL AND has_function_privilege('pr_agent_app',p.oid,'EXECUTE')
      ORDER BY p.proname`);
    assert.deepEqual(granted.rows.map(({ proname }) => proname), [
      "github_deferred_pull_request_finish_handoff",
      "github_deferred_pull_request_lock_for_handoff",
      "github_delivery_handoff_lock",
    ]);

    const tenantId = randomUUID();
    const bindingId = randomUUID();
    const sourceKey = "github:delivery:nested-source-fixture";
    const sourceHash = "b".repeat(64);
    await assert.rejects(app.query(
      "SELECT * FROM pr_agent_harness.github_delivery_handoff_lock($1,$2,$3,$4)",
      [tenantId, bindingId, sourceKey, sourceHash]), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "42501");

    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository) VALUES ($1,$2,'github','https://api.github.com','example/legacy')`,
    [bindingId, tenantId]);
    const run = await owner.query<{ id: string }>(`INSERT INTO pr_agent_harness.agent_runs
      (tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
       request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,
       model_version_hash,tool_version_hash,policy_version_hash,runtime_version_hash,input_json)
      VALUES ($1::uuid,$2::uuid,'service','fixture','review.standard.v1:'||($2::uuid)::text,$3,$4,'review.standard.v1',
        'base','head',$4,$4,$4,$4,$4,$4,$5::jsonb) RETURNING id`,
    [tenantId, bindingId, sourceKey, "c".repeat(64),
      JSON.stringify({ source: { key: sourceKey, hash: sourceHash } })]);
    const otherBindingId = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository) VALUES ($1,$2,'github','https://api.github.com','example/other-legacy')`,
    [otherBindingId, tenantId]);
    await owner.query(`INSERT INTO pr_agent_harness.agent_runs
      (tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
       request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,
       model_version_hash,tool_version_hash,policy_version_hash,runtime_version_hash,input_json)
      VALUES ($1::uuid,$2::uuid,'service','fixture','review.deep.v1:'||($2::uuid)::text,$3,$4,
        'review.deep.v1','base','head',$4,$4,$4,$4,$4,$4,$5::jsonb)`,
    [tenantId, otherBindingId, sourceKey, "d".repeat(64),
      JSON.stringify({ source: { key: sourceKey, hash: "e".repeat(64) } })]);
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const matched = await client.query(`SELECT * FROM pr_agent_harness.github_delivery_handoff_lock(
        $1,$2,$3,$4)`, [tenantId, bindingId, sourceKey, sourceHash]);
      assert.deepEqual(matched.rows[0], { status: "matching", run_id: run.rows[0]!.id });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  function roleUrl(role: string, password: string): string {
    const value = new URL(databaseUrl);
    value.username = role;
    value.password = password;
    return value.toString();
  }
}
