import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";

const url = process.env.HARNESS_TEST_DATABASE_URL;
if (!url) {
  test.skip("Authority tests require isolated Docker HARNESS_TEST_DATABASE_URL");
} else {
  if (!decodeURIComponent(new URL(url).pathname.slice(1)).startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");
  const admin = new Pool({ connectionString: url });
  const db = new RuntimeDatabase(admin);
  const authority = new PublicationAuthorityStore(db);
  const registry = new RunStore(db);
  const role = `harness_authority_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  let app: Pool;
  let batches: PublicationBatchStore;
  before(async () => {
    await migrateRuntime(admin);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.integration_bindings FROM ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint) TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_legacy_review_execution_authority(uuid,uuid,bigint,bigint) TO ${role}`);
    const appUrl = new URL(url); appUrl.username = role; appUrl.password = password;
    app = new Pool({ connectionString: appUrl.toString(), max: 4 });
    batches = new PublicationBatchStore(new RuntimeDatabase(app));
  });
  after(async () => {
    await app?.end();
    await admin.query("DROP SCHEMA pr_agent_harness CASCADE");
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  });

  async function enroll() {
    const tenantId = randomUUID(), id = randomUUID();
    const repository = `example/${id}`;
    await registry.registerIntegration({ tenantId, id, platform: "github", origin: "https://api.github.com", repository });
    return { tenantId, id, repository };
  }
  async function configure(input: Awaited<ReturnType<typeof enroll>>) {
    await authority.configure({ tenantId: input.tenantId, integrationId: input.id, providerRepositoryId: Math.floor(Math.random()*1e12)+1,
      providerActorId: 23, credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
  }
  async function activate(input: Awaited<ReturnType<typeof enroll>>) {
    await configure(input);
    return authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 1,
      action: "activate", actor: "test-admin", quiescenceEvidence: "isolated fixture; no prior publishers" });
  }
  function plan(input: Awaited<ReturnType<typeof enroll>>, sourceKey = randomUUID()) {
    return { scope: { tenantId: input.tenantId, integrationId: input.id, platform: "github" as const,
      origin: "https://api.github.com", repository: input.repository, target: "1", revision: "head-a", authorityGeneration: 1 },
      sourceKey, sourceHash: createHash("sha256").update(sourceKey).digest("hex"),
      operations: [{ slot: "report", payload: { kind: "github-issue-comment", body: "frozen" } }] };
  }

  test("activation requires immutable identity and an explicit quiescence receipt", async () => {
    const input = await enroll();
    await assert.rejects(authority.resolve("github", "https://api.github.com", input.repository), /blocked/);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 0,
      action: "activate", actor: "admin", quiescenceEvidence: "drained" }), /immutable/);
    await configure(input);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 1,
      action: "activate", actor: "admin" }), /evidence/);
    const active = await authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 1,
      action: "activate", actor: "admin", quiescenceEvidence: "old publishers stopped" });
    assert.equal(active.generation, 1);
    await assert.rejects(authority.configure({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: active.version,
      providerRepositoryId: 100, providerActorId: 200, credentialRef: "env:GITHUB_TOKEN" }), /unactivated/);
  });

  test("draining blocks new batches and unresolved operations block authority flips", async () => {
    const input = await enroll(); const active = await activate(input);
    const batch = await batches.freeze(plan(input));
    const draining = await authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: active.version,
      action: "drain", actor: "admin" });
    await assert.rejects(batches.freeze(plan(input)), /binding|authority/i);
    assert.equal((await batches.load(input.tenantId, batch.id))?.id, batch.id);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: draining.version,
      action: "activate", actor: "admin", quiescenceEvidence: "not enough while unresolved" }), /Unresolved/);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: draining.version,
      action: "block", actor: "admin" }), /Unresolved/);
  });

  test("concurrent freeze and drain serialize without granting registry mutation", async () => {
    const input = await enroll(); const active = await activate(input);
    const [frozen, drained] = await Promise.allSettled([
      batches.freeze(plan(input)),
      authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: active.version, action: "drain", actor: "admin" }),
    ]);
    assert.equal(drained.status, "fulfilled");
    if (frozen.status === "fulfilled") assert.equal((await batches.load(input.tenantId, frozen.value.id))?.operations.length, 1);
    await assert.rejects(batches.freeze(plan(input)), /binding|authority/i);
    await assert.rejects(app.query("UPDATE pr_agent_harness.integration_bindings SET publication_state='active'"), (error: any) => error.code === "42501");
  });
}
