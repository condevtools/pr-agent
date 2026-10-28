import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { HarnessDatabase } from "../src/harness/postgres/database.js";
import { migrateHarness } from "../src/harness/postgres/migrations.js";
import {
  HarnessRunStore,
  RunCreateConflictError,
} from "../src/harness/postgres/run-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("PostgreSQL harness tests require HARNESS_TEST_DATABASE_URL from the dedicated Docker test container", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable database named harness_test_*");
  }
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const roleName = `harness_app_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  let pool: Pool;
  let registryStore: HarnessRunStore;
  let store: HarnessRunStore;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateHarness(adminPool);
    await migrateHarness(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pr_agent_harness TO ${roleName}`);
    await adminPool.query(`REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.integration_bindings FROM ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    pool = new Pool({ connectionString: appUrl.toString(), max: 6 });
    registryStore = new HarnessRunStore(new HarnessDatabase(adminPool));
    store = new HarnessRunStore(new HarnessDatabase(pool));
  });

  after(async () => {
    await pool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
  });

  test("trusted integration binding resolves without accepting a caller tenant", async () => {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await registryStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.com/",
      repository: "Acme/Project",
    });
    assert.deepEqual(
      await store.resolveIntegration("github", "https://github.com", "ACME/PROJECT"),
      { tenantId, id: integrationId },
    );
    await assert.rejects(
      registryStore.registerIntegration({
        tenantId: randomUUID(),
        id: randomUUID(),
        platform: "github",
        origin: "https://github.com",
        repository: "acme/project",
      }),
      /already bound/,
    );
    await assert.rejects(
      store.resolveIntegration("github", "https://user:secret@github.com", "acme/project"),
      /must not contain credentials/,
    );
  });

  test("createRun atomically creates one run, event, job and audit row", async () => {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await registryStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "gitlab",
      origin: "https://gitlab.example.test",
      repository: "group/project",
    });
    const input = buildRunInput(tenantId, integrationId, "delivery-1", hash("request-1"));
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => store.createRun(input)),
    );
    const first = attempts.find((attempt) => attempt.created);
    assert.ok(first);
    assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
    assert.deepEqual(new Set(attempts.map((attempt) => attempt.id)), new Set([first.id]));
    assert.deepEqual(new Set(attempts.map((attempt) => attempt.jobId)), new Set([first.jobId]));

    await new HarnessDatabase(pool).transaction(tenantId, (client) =>
      client.query(
        "UPDATE pr_agent_harness.agent_runs SET status = 'succeeded', finished_at = now() WHERE id = $1",
        [first.id],
      ),
    );
    assert.equal((await store.createRun(input)).status, "succeeded");

    const counts = await new HarnessDatabase(pool).transaction(tenantId, async (client) => {
      const results = [];
      for (const table of ["agent_runs", "run_events", "job_queue", "audit_logs"] as const) {
        results.push(
          await client.query(`SELECT count(*)::int AS count FROM pr_agent_harness.${table}`),
        );
      }
      return results;
    });
    assert.deepEqual(counts.map((result) => result.rows[0]?.count), [1, 1, 1, 1]);
  });

  test("same create identity with a different request hash conflicts and registration cannot resurrect a binding", async () => {
    const tenantId = randomUUID();
    const integrationId = randomUUID();
    await registryStore.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: "acme/conflict",
    });
    await store.createRun(buildRunInput(tenantId, integrationId, "delivery-conflict", hash("a")));
    await assert.rejects(
      store.createRun(buildRunInput(tenantId, integrationId, "delivery-conflict", hash("b"))),
      RunCreateConflictError,
    );
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET active = false, publication_state = 'blocked', publication_generation = publication_generation + 1
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, integrationId],
    );
    await assert.rejects(
      registryStore.registerIntegration({
        tenantId,
        id: integrationId,
        platform: "github",
        origin: "https://github.example.test",
        repository: "acme/conflict",
      }),
      /already bound/,
    );
    const binding = await adminPool.query<{ active: boolean; publication_state: string }>(
      `SELECT active, publication_state
       FROM pr_agent_harness.integration_bindings
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, integrationId],
    );
    assert.deepEqual(binding.rows[0], { active: false, publication_state: "blocked" });
    await assert.rejects(
      store.createRun(buildRunInput(tenantId, integrationId, "delivery-conflict", hash("a"))),
      /active integration binding not found/,
    );
  });

  test("tenant RLS hides runs when another tenant context uses the same connection pool", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const integrationId = randomUUID();
    await registryStore.registerIntegration({
      tenantId: tenantA,
      id: integrationId,
      platform: "github",
      origin: "https://github.example.test",
      repository: "acme/private",
    });
    await store.createRun(buildRunInput(tenantA, integrationId, "delivery-private", hash("private")));
    const result = await new HarnessDatabase(pool).transaction(tenantB, (client) =>
      client.query("SELECT count(*)::int AS count FROM pr_agent_harness.agent_runs"),
    );
    assert.equal(result.rows[0]?.count, 0);
  });
}

function buildRunInput(
  tenantId: string,
  integrationId: string,
  createKey: string,
  requestHash: string,
) {
  const version = hash("component-version");
  return {
    tenantId,
    integrationId,
    actorType: "service" as const,
    actorId: "webhook-intake",
    createScope: "webhook:review:v1",
    createKey,
    requestHash,
    runType: "review",
    baseSha: "base-sha",
    headSha: "head-sha",
    workflowVersionHash: version,
    promptVersionHash: version,
    modelVersionHash: version,
    toolVersionHash: version,
    policyVersionHash: version,
    runtimeVersionHash: version,
    input: { repository: "acme/project", pullNumber: 7 },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
