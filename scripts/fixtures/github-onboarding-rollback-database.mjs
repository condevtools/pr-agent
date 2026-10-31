import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
if (mode !== "setup" && mode !== "verify") throw new Error("expected setup or verify mode");
const requireFromBackend = createRequire("/workspace/backend/package.json");
const { Pool } = requireFromBackend("pg");
const pool = new Pool({ host: required("DATABASE_HOST"), port: 5432, database: "pr_agent",
  user: "postgres", password: required("POSTGRES_PASSWORD"), max: 2 });

try {
  if (mode === "setup") {
    await createRole("pr_agent_app", required("APP_PASSWORD"));
    await createRole("pr_agent_onboarding", required("ONBOARDING_PASSWORD"));
    await createRole("pr_agent_maintenance", required("MAINTENANCE_PASSWORD"));
    const { migrateRuntime } = await import(`${pathToFileURL(
      "/workspace/backend/dist/agent-runtime/postgres/migrations.js").href}?rollback=${Date.now()}`);
    await migrateRuntime(pool);
    await assertCurrentSchema();
    await pool.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,quiescence_receipt,
       review_execution_mode,execution_mode_generation,review_execution_state,
       github_app_id,github_account_id,provider_access_state,provider_access_version,provider_access_checked_at)
      VALUES ($1,$2,'github','https://api.github.com','rollback/repository','91','111','github-app:81',
        'active',1,2,'{"protocol":"rollback-smoke"}'::jsonb,'harness_async',1,'active',71,101,
        'verified',0,clock_timestamp())`, [required("BINDING_ID"), required("TENANT_ID")]);
  } else {
    const bindingId = required("BINDING_ID");
    const tenantId = required("TENANT_ID");
    const deliveryId = required("DELIVERY_ID");
    const binding = await pool.query(`SELECT tenant_id::text,id::text,repository,provider_repository_id,
        github_app_id::text,github_account_id::text,active,publication_state,provider_access_state,
        provider_access_version,provider_access_reason
      FROM pr_agent_harness.integration_bindings WHERE id=$1`, [bindingId]);
    assert.deepEqual(binding.rows[0], { tenant_id: tenantId, id: bindingId,
      repository: "rollback/repository", provider_repository_id: "91", github_app_id: "71",
      github_account_id: "101", active: true, publication_state: "active",
      provider_access_state: "revoked", provider_access_version: "1",
      provider_access_reason: "GitHub App installation deleted" });
    const receipt = await pool.query(`SELECT installation_id,delivery_class,requested_epoch,result,requested_state
      FROM pr_agent_harness.github_provider_lifecycle_receipts
      WHERE github_app_id=71 AND delivery_id=$1`, [deliveryId]);
    assert.deepEqual(receipt.rows[0], { installation_id: null, delivery_class: "restrictive",
      requested_epoch: null, result: "accepted", requested_state: "revoked" });
    const restriction = await pool.query(`SELECT repository_id::text,access_state,restricted_epoch::text,
        resolved_epoch,resolved_by_snapshot_epoch FROM pr_agent_harness.github_provider_access_restrictions
      WHERE github_app_id=71 AND installation_id=81`);
    assert.deepEqual(restriction.rows, [{ repository_id: "0", access_state: "revoked",
      restricted_epoch: "1", resolved_epoch: null, resolved_by_snapshot_epoch: null }]);
    assert.equal((await pool.query(
      "SELECT count(*)::integer count FROM pr_agent_harness.integration_bindings")).rows[0]?.count, 1);
    await assertCurrentSchema();
  }
} finally {
  await pool.end();
}

async function assertCurrentSchema() {
  const signatures = [
    "pr_agent_harness.github_onboarding_list(uuid,bigint[])",
    "pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text)",
    "pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint)",
    "pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)",
  ];
  const installed = await pool.query(`SELECT bool_and(to_regprocedure(signature) IS NOT NULL) AS installed
    FROM unnest($1::text[]) signature`, [signatures]);
  assert.equal(installed.rows[0]?.installed, true, "migration 031 compatibility signatures must remain installed");
  const schema032 = await pool.query(`SELECT to_regclass('pr_agent_harness.github_installation_sync_state') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='pr_agent_harness'
        AND table_name='github_installation_sync_state' AND column_name='last_conflict_count') AS installed`);
  assert.equal(schema032.rows[0]?.installed, true, "current migration 032 schema must be installed");
}

async function createRole(role, password) {
  const statement = await pool.query(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) sql",
    [role, password]);
  await pool.query(statement.rows[0].sql);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
