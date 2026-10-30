import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";

const url = process.env.HARNESS_TEST_DATABASE_URL;
if (!url) test.skip("Schema owner tests require Docker PostgreSQL", () => {});
else {
  if (!new URL(url).pathname.startsWith("/harness_test_")) throw new Error("Disposable DB required");
  test("dedicated NOSUPERUSER NOBYPASSRLS owner initializes schema and trusted functions without weakening app RLS", async () => {
    const admin = new Pool({ connectionString: url });
    const ownerName = `ddl_${randomUUID().replaceAll("-", "")}`;
    const appName = `runtime_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    const ownerUrl = new URL(url); ownerUrl.username=ownerName; ownerUrl.password=password;
    const appUrl = new URL(url); appUrl.username=appName; appUrl.password=password;
    let owner: Pool | undefined; let app: Pool | undefined;
    try {
      await admin.query(`CREATE ROLE ${ownerName} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
        CREATE ROLE ${appName} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS`);
      const dbName = new URL(url).pathname.slice(1);
      await admin.query(`GRANT CREATE ON DATABASE "${dbName}" TO ${ownerName}`);
      owner = new Pool({ connectionString: ownerUrl.toString() });
      await migrateRuntime(owner);
      await migrateRuntime(owner);
      const role = (await owner.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      assert.equal((await owner.query("SELECT pr_agent_harness.is_harness_admin() AS allowed")).rows[0].allowed, true);
      const tenantId=randomUUID(), integrationId=randomUUID();
      const db=new RuntimeDatabase(owner); const store=new RunStore(db); const authority=new PublicationAuthorityStore(db);
      await store.registerIntegration({ tenantId,id:integrationId,platform:"github",origin:"https://api.github.com",repository:"fixture/repo" });
      await authority.configure({tenantId,integrationId,providerRepositoryId:1,providerActorId:2,credentialRef:"env:GITHUB_TOKEN",expectedVersion:0});
      const binding=await authority.transition({tenantId,integrationId,expectedVersion:1,action:"activate",actor:"fixture",actorType:"service",quiescenceEvidence:"disposable database"});
      const hash="a".repeat(64);
      await store.createRun({tenantId,integrationId,actorType:"service",actorId:"fixture",
        createScope:"owner-fixture",createKey:"one",requestHash:hash,runType:"fixture",
        baseSha:"base",headSha:"head",workflowVersionHash:hash,promptVersionHash:hash,
        modelVersionHash:hash,toolVersionHash:hash,policyVersionHash:hash,runtimeVersionHash:hash,input:{}});
      await owner.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${appName};
        GRANT SELECT ON pr_agent_harness.agent_runs TO ${appName};
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
          pr_agent_harness.list_due_model_budget_tenants(integer) TO ${appName}`);
      app = new Pool({ connectionString: appUrl.toString() });
      assert.equal((await app.query("SELECT pr_agent_harness.is_harness_admin() AS allowed")).rows[0].allowed,false);
      const decision=await app.query("SELECT pr_agent_harness.lock_active_review_execution_authority($1,$2,$3,$4) AS allowed",
        [tenantId,integrationId,binding.generation,binding.executionModeGeneration]);
      assert.equal(decision.rows[0].allowed,true);
      assert.deepEqual((await app.query("SELECT * FROM pr_agent_harness.list_due_model_budget_tenants(10)")).rows,[]);
      const forced=await owner.query("SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS forced FROM pg_class WHERE oid IN ('pr_agent_harness.agent_runs'::regclass,'pr_agent_harness.model_budget_reservations'::regclass)");
      assert.equal(forced.rows[0].forced,true);
      await assert.rejects(app.query(`SET ROLE ${ownerName}`), /permission denied/);
      assert.equal((await app.query("SELECT count(*)::int AS n FROM pr_agent_harness.agent_runs")).rows[0].n,0);
      assert.equal((await new RuntimeDatabase(app).transaction(tenantId,
        (client) => client.query("SELECT count(*)::int AS n FROM pr_agent_harness.agent_runs"))).rows[0].n,1);
      assert.equal((await new RuntimeDatabase(app).transaction(randomUUID(),
        (client) => client.query("SELECT count(*)::int AS n FROM pr_agent_harness.agent_runs"))).rows[0].n,0);
    } finally {
      await app?.end();await owner?.end();
      await admin.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE; DROP EXTENSION IF EXISTS pgcrypto CASCADE");
      await admin.query(`DROP OWNED BY ${appName}; DROP OWNED BY ${ownerName}; DROP ROLE ${appName}; DROP ROLE ${ownerName}`);
      await admin.end();
    }
  });
}
