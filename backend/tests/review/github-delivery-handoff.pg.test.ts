import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import type { CreateRunInput } from "../../src/agent-runtime/postgres/run-store.js";
import {
  GitHubDeliveryHandoffError,
  createOrReuseGitHubDeliveryRun,
} from "../../src/review/intake/github-delivery-handoff.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("GitHub delivery handoff requires isolated Docker PostgreSQL", () => {});
} else {
  const owner = new Pool({ connectionString: databaseUrl });
  const appPassword = randomUUID();
  let app: Pool;
  let db: RuntimeDatabase;
  let tenantId: string;
  let bindingId: string;

  before(async () => {
    const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app'");
    const role = await owner.query<{ sql: string }>(exists.rowCount
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS','pr_agent_app',$1::text) AS sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS','pr_agent_app',$1::text) AS sql",
    [appPassword]);
    await owner.query(role.rows[0]!.sql);
    await migrateRuntime(owner);
    const appUrl = new URL(databaseUrl);
    appUrl.username = "pr_agent_app";
    appUrl.password = appPassword;
    app = new Pool({ connectionString: appUrl.toString(), max: 4 });
    db = new RuntimeDatabase(app);
    tenantId = randomUUID();
    bindingId = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
       credential_ref,publication_state,publication_generation,authority_version,quiescence_receipt,
       github_app_id,github_account_id,provider_access_state)
      VALUES ($1,$2,'github','https://api.github.com','example/project','10000','81',
        'github-app:31','active',1,1,'{"protocol":"fixture"}'::jsonb,7,501,'verified')`,
    [bindingId, tenantId]);
  });

  after(async () => {
    await app?.end();
    await owner.end();
  });

  test("stable delivery identity wins across workflow scope and request policy changes", async () => {
    const sourceKey = `github:delivery:${randomUUID()}`;
    const sourceHash = hash("provider-body");
    const first = await db.transaction(tenantId, (client) => createOrReuseGitHubDeliveryRun(
      client, identity(sourceKey, sourceHash),
      async () => creation(sourceKey, sourceHash, "review.single.v1", hash("policy-a")),
    ));
    const second = await db.transaction(tenantId, (client) => createOrReuseGitHubDeliveryRun(
      client, identity(sourceKey, sourceHash),
      async () => creation(sourceKey, sourceHash, "review.deep.v1", hash("policy-b")),
    ));
    assert.equal(first.created, true);
    assert.deepEqual(second, { id: first.id, created: false });
    const stored = await owner.query(`SELECT source_kind,source_key,source_hash,count(*) OVER ()::int AS count
      FROM pr_agent_harness.agent_runs WHERE tenant_id=$1`, [tenantId]);
    assert.deepEqual(stored.rows, [{ source_kind: "github_delivery", source_key: sourceKey,
      source_hash: sourceHash, count: 1 }]);
    let conflictingBuild = false;
    await assert.rejects(db.transaction(tenantId, (client) => createOrReuseGitHubDeliveryRun(
      client, identity(sourceKey, hash("different-provider-body")), async () => {
        conflictingBuild = true;
        return creation(sourceKey, hash("different-provider-body"), "review.single.v1", hash("policy-c"));
      },
    )), (error: unknown) => error instanceof GitHubDeliveryHandoffError
      && error.code === "source_identity_conflict");
    assert.equal(conflictingBuild, false);
  });

  test("deferred completion and new Run roll back in the same tenant transaction", async () => {
    const deliveryId = randomUUID();
    const sourceKey = `github:delivery:${deliveryId}`;
    const sourceHash = hash("deferred-body");
    const deferredId = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.github_deferred_pull_requests
      (id,github_app_id,delivery_id,installation_id,github_account_id,repository_id,repository,
       pull_number,action,source_hash,status,lease_owner,lease_epoch,lease_expires_at)
      VALUES ($1,7,$2,31,501,10000,'example/project',1,'opened',$3,'leased','owner',1,
        clock_timestamp()+interval '1 minute')`, [deferredId, deliveryId, sourceHash]);
    await assert.rejects(db.transaction(tenantId, async (client) => {
      await createOrReuseGitHubDeliveryRun(client, identity(sourceKey, sourceHash),
        async () => creation(sourceKey, sourceHash, "review.single.v1", hash("policy")),
        { ownerId: "owner", leaseEpoch: 1 });
      throw new Error("injected rollback");
    }), /injected rollback/u);
    const run = await owner.query("SELECT id FROM pr_agent_harness.agent_runs WHERE source_key=$1", [sourceKey]);
    const deferred = await owner.query(
      "SELECT status,run_id FROM pr_agent_harness.github_deferred_pull_requests WHERE id=$1", [deferredId]);
    assert.equal(run.rowCount, 0);
    assert.deepEqual(deferred.rows[0], { status: "leased", run_id: null });
  });

  test("concurrent live and deferred paths create one Run and complete the lease", async () => {
    const deliveryId = randomUUID();
    const sourceKey = `github:delivery:${deliveryId}`;
    const sourceHash = hash("concurrent-body");
    const deferredId = randomUUID();
    await insertDeferred(deferredId, deliveryId, sourceHash, "concurrent-owner");
    const [live, deferred] = await Promise.all([
      db.transaction(tenantId, (client) => createOrReuseGitHubDeliveryRun(
        client, identity(sourceKey, sourceHash),
        async () => creation(sourceKey, sourceHash, "review.single.v1", hash("live-policy")),
      )),
      db.transaction(tenantId, (client) => createOrReuseGitHubDeliveryRun(
        client, identity(sourceKey, sourceHash),
        async () => creation(sourceKey, sourceHash, "review.deep.v1", hash("deferred-policy")),
        { ownerId: "concurrent-owner", leaseEpoch: 1 },
      )),
    ]);
    assert.equal([live, deferred].filter(({ created }) => created).length, 1);
    assert.equal(live.id, deferred.id);
    const rows = await owner.query("SELECT count(*)::int AS count FROM pr_agent_harness.agent_runs WHERE source_key=$1",
      [sourceKey]);
    const record = await owner.query(
      "SELECT status,run_id FROM pr_agent_harness.github_deferred_pull_requests WHERE id=$1", [deferredId]);
    assert.equal(rows.rows[0]!.count, 1);
    assert.deepEqual(record.rows[0], { status: "completed", run_id: live.id });
  });

  test("purged legacy source hash blocks duplicate creation", async () => {
    const sourceKey = `github:delivery:${randomUUID()}`;
    const sourceHash = hash("unavailable-legacy-body");
    const version = hash("legacy-version");
    await owner.query(`INSERT INTO pr_agent_harness.agent_runs
      (tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
       request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,
       model_version_hash,tool_version_hash,policy_version_hash,runtime_version_hash,input_json)
      VALUES ($1,$2,'service','legacy','legacy-review',$3,$4,'review','base','head',$5,$5,$5,$5,$5,$5,'{}')`,
    [tenantId, bindingId, sourceKey, hash("legacy-request"), version]);
    let built = false;
    await assert.rejects(db.transaction(tenantId, (client) => createOrReuseGitHubDeliveryRun(
      client, identity(sourceKey, sourceHash), async () => {
        built = true;
        return creation(sourceKey, sourceHash, "review.single.v1", hash("new-policy"));
      },
    )), (error: unknown) => error instanceof GitHubDeliveryHandoffError
      && error.code === "legacy_source_hash_unavailable");
    assert.equal(built, false);
    const rows = await owner.query("SELECT count(*)::int AS count FROM pr_agent_harness.agent_runs WHERE create_key=$1",
      [sourceKey]);
    assert.equal(rows.rows[0]!.count, 1);
  });

  function identity(sourceKey: string, sourceHash: string) {
    return { tenantId, bindingId, sourceKey, sourceHash };
  }

  function creation(sourceKey: string, sourceHash: string, workflow: string,
    requestHash: string): CreateRunInput {
    const version = hash("version");
    return { tenantId, integrationId: bindingId, actorType: "service", actorId: "github-intake",
      createScope: `${workflow}:${bindingId}`, createKey: sourceKey, requestHash, runType: "review",
      baseSha: "base", headSha: "head", workflowVersionHash: version, promptVersionHash: version,
      modelVersionHash: version, toolVersionHash: version, policyVersionHash: version,
      runtimeVersionHash: version, input: { source: { key: sourceKey, hash: sourceHash } },
      sourceIdentity: { kind: "github_delivery", key: sourceKey, hash: sourceHash } };
  }

  async function insertDeferred(id: string, deliveryId: string, sourceHash: string, ownerId: string) {
    await owner.query(`INSERT INTO pr_agent_harness.github_deferred_pull_requests
      (id,github_app_id,delivery_id,installation_id,github_account_id,repository_id,repository,
       pull_number,action,source_hash,status,lease_owner,lease_epoch,lease_expires_at)
      VALUES ($1,7,$2,31,501,10000,'example/project',1,'opened',$3,'leased',$4,1,
        clock_timestamp()+interval '1 minute')`, [id, deliveryId, sourceHash, ownerId]);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
