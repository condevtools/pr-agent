import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PgRunArtifactGarbageCollector, PgRunArtifactStore, prepareRunArtifact,
  RUN_ARTIFACT_LIMITS, RunArtifactCorruptError, RunArtifactLimitError,
  type PreparedRunArtifact, type RunArtifactScope } from "../../src/agent-runtime/artifacts/index.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { prepareHarnessRuntimeRoles } from "../support/harness-runtime-roles.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Artifact PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("artifact tests require a disposable database");
  const owner = new Pool({ connectionString: databaseUrl, max: 8 });
  let app: Pool; let store: PgRunArtifactStore;
  const tenantA = randomUUID(); const tenantB = randomUUID();
  const integrationA = randomUUID(); const integrationB = randomUUID();
  const version = sha(Buffer.from("version"));

  before(async () => {
    await prepareHarnessRuntimeRoles(owner, { app: "app-test", verifier: "verifier-test-password-123" });
    await migrateRuntime(owner);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = "app-test";
    app = new Pool({ connectionString: appUrl.toString(), max: 8 });
    store = new PgRunArtifactStore(new RuntimeDatabase(app));
    await insertBinding(tenantA, integrationA, "acme/a", 1);
    await insertBinding(tenantB, integrationB, "acme/b", 2);
  });
  after(async () => { await app?.end(); await owner.end(); });

  test("app has minimal immutable artifact privileges", async () => {
    const privileges = await app.query<{ select_ok: boolean; insert_ok: boolean; update_ok: boolean; delete_ok: boolean }>(
      `SELECT has_table_privilege(current_user,'pr_agent_harness.run_artifacts','SELECT') AS select_ok,
        has_table_privilege(current_user,'pr_agent_harness.run_artifacts','INSERT') AS insert_ok,
        has_table_privilege(current_user,'pr_agent_harness.run_artifacts','UPDATE') AS update_ok,
        has_table_privilege(current_user,'pr_agent_harness.run_artifacts','DELETE') AS delete_ok`);
    assert.deepEqual(privileges.rows[0], { select_ok: true, insert_ok: true, update_ok: false, delete_ok: false });
  });

  test("artifact reads are bound to exact tenant, integration, Run and immutable hash identity", async () => {
    const runA = await insertRun(tenantA, integrationA, "queued");
    const runB = await insertRun(tenantA, integrationA, "queued");
    const runOtherTenant = await insertRun(tenantB, integrationB, "queued");
    const scope = { tenantId: tenantA, integrationId: integrationA, runId: runA };
    const ref = await store.putStepOutput(scope, Buffer.from('{"ok":true}'));
    const retentionMs = Date.parse(ref.retentionExpiresAt) - Date.now();
    assert.ok(retentionMs > 29.9 * 86_400_000 && retentionMs <= 30 * 86_400_000,
      "new artifacts default to a bounded 30-day retention interval");
    const read = await store.read(scope, ref.artifactHash);
    assert.equal(read?.status, "available");
    if (read?.status === "available") assert.equal(read.content.toString(), '{"ok":true}');
    assert.equal(await store.read({ ...scope, runId: runB }, ref.artifactHash), undefined);
    assert.equal(await store.read({ tenantId: tenantB, integrationId: integrationB,
      runId: runOtherTenant }, ref.artifactHash), undefined);
    const persistedOutput = { value: { ok: true } };
    const persistedRef = await store.putStepOutput(scope, Buffer.from(JSON.stringify(persistedOutput)));
    const stepId = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.agent_steps
      (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,result_ref,
       last_lease_epoch,attempt_count,completed_at)
      VALUES ($1,$2,$3,'artifact-step','tool',$4,'succeeded',$5,$6::jsonb,$7,1,1,clock_timestamp())`,
    [stepId,tenantA,runA,version,fingerprint(persistedOutput),JSON.stringify({ storage: "artifact" }),
      persistedRef.artifactHash]);
    const outputClient = await app.connect();
    try {
      await outputClient.query("BEGIN");
      await outputClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      assert.deepEqual(await store.readStepOutputValueInTransaction(outputClient, scope, {
        resultRef: persistedRef.artifactHash, output: { storage: "artifact" },
        outputHash: fingerprint(persistedOutput),
      }), { ok: true });
      await assert.rejects(store.readStepOutputValueInTransaction(outputClient, scope, {
        resultRef: persistedRef.artifactHash, output: { storage: "artifact" }, outputHash: version,
      }), RunArtifactCorruptError);
      await outputClient.query("COMMIT");
    } finally { outputClient.release(); }
    const wrongTenantClient = await app.connect();
    try {
      await wrongTenantClient.query("BEGIN");
      await wrongTenantClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantB]);
      await assert.rejects(store.holdInTransaction(wrongTenantClient, scope, persistedRef.artifactHash,
        "wrong-tenant", "qualification"), (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "42501");
      await wrongTenantClient.query("ROLLBACK");
    } finally { wrongTenantClient.release(); }
    await assert.rejects(owner.query(`INSERT INTO pr_agent_harness.agent_steps
      (tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,result_ref,
       last_lease_epoch,attempt_count,completed_at)
      VALUES ($1,$2,'missing-artifact','tool',$3,'succeeded',$3,'{}'::jsonb,$3,1,1,clock_timestamp())`,
    [tenantA,runA,version]), /foreign key/i);
    const snapshot = await prepareRunArtifact(Buffer.from("snapshot"),
      { contentType: "application/json", purpose: "fix_snapshot" });
    const snapshotClient = await app.connect();
    try {
      await snapshotClient.query("BEGIN");
      await snapshotClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await store.putFixSnapshotForQueuedRunInTransaction(snapshotClient,
        { tenantId: tenantA, integrationId: integrationA, runId: runB }, snapshot);
      await snapshotClient.query("COMMIT");
    } finally { snapshotClient.release(); }
    await finishRun(runB);
    const terminalClient = await app.connect();
    try {
      await terminalClient.query("BEGIN");
      await terminalClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await assert.rejects(store.putFixSnapshotForQueuedRunInTransaction(terminalClient,
        { tenantId: tenantA, integrationId: integrationA, runId: runB },
        await prepareRunArtifact(Buffer.from("later"), { contentType: "application/json", purpose: "fix_snapshot" })),
      /requires a queued Run/);
      await terminalClient.query("ROLLBACK");
    } finally { terminalClient.release(); }
    const conflictClient = await app.connect();
    try {
      await conflictClient.query("BEGIN");
      await conflictClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await assert.rejects(store.putPreparedInTransaction(conflictClient, scope,
        await prepareRunArtifact(Buffer.from('{"ok":true}'), { contentType: "text/plain", purpose: "other" })),
      /artifact identity conflict/);
      await conflictClient.query("ROLLBACK");
    } finally { conflictClient.release(); }
  });

  test("compressed byte boundary is enforced and corrupt content fails bounded verification", async () => {
    const runId = await insertRun(tenantA, integrationA, "queued");
    const scope = { tenantId: tenantA, integrationId: integrationA, runId };
    const valid = await prepareRunArtifact(Buffer.from("x"), { contentType: "application/octet-stream", purpose: "other" });
    const exactCompressed = Buffer.concat([valid.compressed,
      Buffer.alloc(RUN_ARTIFACT_LIMITS.maxCompressedBytes-valid.compressedSizeBytes)]);
    const exact: PreparedRunArtifact = { artifactHash: valid.artifactHash, rawSizeBytes: 1,
      compressedSizeBytes: RUN_ARTIFACT_LIMITS.maxCompressedBytes,
      contentType: "application/octet-stream", purpose: "other",
      compressed: exactCompressed };
    const client = await app.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await store.putPreparedInTransaction(client, scope, exact);
      await client.query("COMMIT");
    } finally { client.release(); }
    const exactRead = await store.read(scope, exact.artifactHash);
    assert.equal(exactRead?.status, "available");
    if (exactRead?.status === "available") assert.equal(exactRead.content.toString(), "x");
    const over = { ...exact, artifactHash: sha(Buffer.from("y")), compressedSizeBytes: exact.compressedSizeBytes + 1,
      compressed: Buffer.alloc(exact.compressedSizeBytes + 1) };
    const overClient = await app.connect();
    try { await overClient.query("BEGIN"); await overClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await assert.rejects(store.putPreparedInTransaction(overClient, scope, over),
        (error: unknown) => error instanceof RunArtifactLimitError && error.code === "artifact_compressed_limit");
      await overClient.query("ROLLBACK");
    } finally { overClient.release(); }
    const corruptHash = sha(Buffer.from("corrupt-raw"));
    await owner.query(`INSERT INTO pr_agent_harness.run_artifacts
      (tenant_id,integration_id,run_id,artifact_hash,purpose,content_type,raw_size_bytes,
       compressed_size_bytes,content_compressed)
      VALUES ($1,$2,$3,$4,'other','application/octet-stream',11,3,$5)`,
    [tenantA,integrationA,runId,corruptHash,Buffer.from("bad")]);
    await assert.rejects(store.read(scope, corruptHash), RunArtifactCorruptError);
  });

  test("concurrent writers serialize the exact 128 MiB per-Run quota", async () => {
    const runId = await insertRun(tenantA, integrationA, "queued");
    const scope = { tenantId: tenantA, integrationId: integrationA, runId };
    for (let fill = 1; fill <= 3; fill += 1) await putLarge(scope, fill);
    const results = await Promise.allSettled([putLarge(scope, 4), putLarge(scope, 5)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(failure?.reason instanceof RunArtifactLimitError);
    assert.equal(failure.reason.code, "run_artifact_quota");
    await assert.rejects(store.put(scope, Buffer.from([1]), { contentType: "application/octet-stream", purpose: "other" }),
      (error: unknown) => error instanceof RunArtifactLimitError && error.code === "run_artifact_quota");
    const total = await owner.query<{ total: string }>(
      "SELECT sum(raw_size_bytes)::text AS total FROM pr_agent_harness.run_artifacts WHERE tenant_id=$1 AND run_id=$2",
      [tenantA, runId]);
    assert.equal(Number(total.rows[0]!.total), RUN_ARTIFACT_LIMITS.maxRunRawBytes);
  });

  test("GC preserves active, unknown publication, budget and Fix/Evolution-held artifacts then returns gone", async () => {
    const gc = new PgRunArtifactGarbageCollector(owner);
    const activeRun = await insertRun(tenantA, integrationA, "queued");
    const active = await insertExpiredArtifact({ tenantId: tenantA, integrationId: integrationA, runId: activeRun }, "active");
    assert.equal(await gc.purgeExpired(), 0);
    await finishRun(activeRun);

    const publicationRun = await insertRun(tenantA, integrationA, "succeeded_old");
    const publication = await insertExpiredArtifact({ tenantId: tenantA, integrationId: integrationA, runId: publicationRun }, "publication");
    const operationId = sha(Buffer.from("artifact-operation"));
    await owner.query(`INSERT INTO pr_agent_harness.repository_operations
      (tenant_id,integration_id,business_operation_id,platform,origin,repository,target,revision,
       operation_type,publication_slot,payload_hash,marker,status)
      VALUES ($1,$2,$3,'github','https://github.test','acme/a','pr:1','head','publication','review',$3,'marker','unknown')`,
    [tenantA,integrationA,operationId]);
    const batchId = randomUUID();
    await owner.query(`INSERT INTO pr_agent_harness.publication_batches
      (id,tenant_id,integration_id,platform,origin,repository,target,revision,authority_generation,
       source_key,source_hash,status)
      VALUES ($1,$2,$3,'github','https://github.test','acme/a','pr:1','head',1,'artifact-gc',$4,'waiting_reconciliation')`,
    [batchId,tenantA,integrationA,sha(Buffer.from("batch-source"))]);
    await owner.query(`INSERT INTO pr_agent_harness.publication_batch_operations
      (tenant_id,batch_id,ordinal,business_operation_id) VALUES ($1,$2,0,$3)`, [tenantA,batchId,operationId]);
    await owner.query(`INSERT INTO pr_agent_harness.run_publication_batches
      (tenant_id,run_id,batch_id,lease_epoch,operation_set_hash) VALUES ($1,$2,$3,1,$4)`,
    [tenantA,publicationRun,batchId,sha(Buffer.from("operation-set"))]);
    assert.equal(await gc.purgeExpired(), 1, "the now-terminal active Run may purge, unknown publication remains");
    await owner.query(`UPDATE pr_agent_harness.repository_operations SET status='failed_definite',
      outcome_code='publication_abandoned',resolved_at=clock_timestamp()-interval '31 days' WHERE business_operation_id=$1`,
    [operationId]);

    const budgetRun = await insertRun(tenantA, integrationA, "succeeded_old");
    const budget = await insertExpiredArtifact({ tenantId: tenantA, integrationId: integrationA, runId: budgetRun }, "budget");
    await insertActiveBudget(budgetRun);
    assert.equal(await gc.purgeExpired(), 1, "resolved publication may purge, active budget remains");
    await owner.query(`UPDATE pr_agent_harness.run_budget_envelopes SET status='closed',closed_at=clock_timestamp()-interval '31 days',
      updated_at=clock_timestamp()-interval '31 days' WHERE tenant_id=$1 AND run_id=$2`, [tenantA,budgetRun]);

    const heldRun = await insertRun(tenantA, integrationA, "succeeded_old");
    const fix = await insertExpiredArtifact({ tenantId: tenantA, integrationId: integrationA, runId: heldRun }, "fix");
    const evolution = await insertExpiredArtifact({ tenantId: tenantA, integrationId: integrationA, runId: heldRun }, "evolution");
    const heldScope = { tenantId: tenantA, integrationId: integrationA, runId: heldRun };
    await store.hold(heldScope, fix, "fix-qualified", "fix");
    await store.hold(heldScope, evolution, "evolution-qualified", "evolution");
    assert.equal(await gc.purgeExpired(), 1, "closed budget may purge, explicit strong references remain");
    await store.releaseHold(heldScope, fix, "fix-qualified");
    await store.releaseHold(heldScope, evolution, "evolution-qualified");
    assert.equal(await gc.purgeExpired(), 0, "release recomputes a fresh 30-day retention interval");
    await owner.query(`UPDATE pr_agent_harness.run_artifact_hold_releases
      SET released_at=clock_timestamp()-interval '31 days' WHERE tenant_id=$1 AND run_id=$2`, [tenantA,heldRun]);
    assert.equal(await gc.purgeExpired(), 2);
    assert.equal((await store.read(heldScope, fix))?.status, "gone");
    assert.equal((await store.read(heldScope, evolution))?.status, "gone");
    assert.equal((await store.read({ tenantId: tenantA, integrationId: integrationA, runId: activeRun }, active))?.status, "gone");
    assert.equal((await store.read({ tenantId: tenantA, integrationId: integrationA, runId: publicationRun }, publication))?.status, "gone");
    assert.equal((await store.read({ tenantId: tenantA, integrationId: integrationA, runId: budgetRun }, budget))?.status, "gone");
  });

  test("application holds and owner GC serialize without reviving purged content", async () => {
    const gc = new PgRunArtifactGarbageCollector(owner);
    const heldRun = await insertRun(tenantA, integrationA, "succeeded_old");
    const heldScope = { tenantId: tenantA, integrationId: integrationA, runId: heldRun };
    const heldHash = await insertExpiredArtifact(heldScope, "hold-wins");
    const holdClient = await app.connect();
    try {
      await holdClient.query("BEGIN");
      await holdClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await store.holdInTransaction(holdClient, heldScope, heldHash, "barrier-hold", "qualification");
      assert.equal(await gc.purgeExpired(), 0, "GC skips the artifact row locked by an uncommitted hold");
      await holdClient.query("COMMIT");
    } finally { holdClient.release(); }
    assert.equal(await gc.purgeExpired(), 0, "committed hold remains visible to later GC passes");

    const purgedRun = await insertRun(tenantA, integrationA, "succeeded_old");
    const purgedScope = { tenantId: tenantA, integrationId: integrationA, runId: purgedRun };
    const purgedHash = await insertExpiredArtifact(purgedScope, "gc-wins");
    const gcClient = await owner.connect();
    try {
      await gcClient.query("BEGIN");
      await gcClient.query(`SELECT 1 FROM pr_agent_harness.run_artifacts
        WHERE tenant_id=$1 AND run_id=$2 AND artifact_hash=$3 FOR UPDATE`,
      [tenantA,purgedRun,purgedHash]);
      await gcClient.query(`UPDATE pr_agent_harness.run_artifacts
        SET content_compressed=NULL,purged_at=clock_timestamp()
        WHERE tenant_id=$1 AND run_id=$2 AND artifact_hash=$3`, [tenantA,purgedRun,purgedHash]);
      const waitingHold = store.hold(purgedScope, purgedHash, "late-hold", "qualification");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await gcClient.query("COMMIT");
      await assert.rejects(waitingHold, /artifact is gone/i);
    } finally { gcClient.release(); }
    assert.equal((await store.read(purgedScope, purgedHash))?.status, "gone");
  });

  async function putLarge(scope: RunArtifactScope, fill: number): Promise<void> {
    const content = Buffer.alloc(RUN_ARTIFACT_LIMITS.maxRawBytes, fill);
    await store.put(scope, content, { contentType: "application/octet-stream", purpose: "other" });
  }

  async function insertBinding(tenantId: string, integrationId: string, repository: string,
    providerRepositoryId: number): Promise<void> {
    await owner.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,review_execution_mode,execution_mode_generation,
       review_execution_state,quiescence_receipt)
      VALUES ($1,$2,'github','https://github.test',$3,$4,1,'env:GITHUB_TOKEN','active',1,1,'harness_async',1,'active','{}')`,
    [integrationId,tenantId,repository,providerRepositoryId]);
  }

  async function insertRun(tenantId: string, integrationId: string,
    status: "queued" | "succeeded_old"): Promise<string> {
    const id = randomUUID(); const terminal = status === "succeeded_old";
    await owner.query(`INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
       run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
       policy_version_hash,runtime_version_hash,input_json,status,authority_generation,execution_mode_generation,
       deadline_at,finished_at,created_at,updated_at)
      VALUES ($1::uuid,$2,$3,'system','artifact-test',$1::text,$1::text,$4,'review.single.v1','base','head',$4,$4,$4,$4,$4,$4,
       '{}'::jsonb,$5,1,1,clock_timestamp()+interval '15 minutes',$6,$7,$7)`,
    [id,tenantId,integrationId,version,terminal ? "succeeded" : "queued",
      terminal ? new Date(Date.now()-31*86_400_000) : null,
      terminal ? new Date(Date.now()-32*86_400_000) : new Date()]);
    return id;
  }

  async function finishRun(runId: string): Promise<void> {
    await owner.query(`UPDATE pr_agent_harness.agent_runs SET status='succeeded',finished_at=clock_timestamp()-interval '31 days',
      updated_at=clock_timestamp()-interval '31 days' WHERE tenant_id=$1 AND id=$2`, [tenantA,runId]);
  }

  async function insertExpiredArtifact(scope: RunArtifactScope, label: string): Promise<string> {
    const prepared = await prepareRunArtifact(Buffer.from(label), { contentType: "text/plain", purpose: "other" });
    await owner.query(`INSERT INTO pr_agent_harness.run_artifacts
      (tenant_id,integration_id,run_id,artifact_hash,purpose,content_type,raw_size_bytes,compressed_size_bytes,
       content_compressed,retention_expires_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()-interval '1 day',clock_timestamp()-interval '32 days')`,
    [scope.tenantId,scope.integrationId,scope.runId,prepared.artifactHash,prepared.purpose,prepared.contentType,
      prepared.rawSizeBytes,prepared.compressedSizeBytes,prepared.compressed]);
    return prepared.artifactHash;
  }

  async function insertActiveBudget(runId: string): Promise<void> {
    const pricing = sha(Buffer.from(`pricing:${runId}`));
    await owner.query(`INSERT INTO pr_agent_harness.model_pricing_snapshots
      (tenant_id,pricing_hash,pricing_version,provider,model,currency,rates_json,policy_json)
      VALUES ($1,$2,'v1','openai','fixture','USD','{}','{}')`, [tenantA,pricing]);
    await owner.query(`INSERT INTO pr_agent_harness.tenant_budget_accounts
      (tenant_id,period_key,currency,input_token_limit,output_token_limit,cost_limit_micros)
      VALUES ($1,'2026-10','USD',100,100,100) ON CONFLICT DO NOTHING`, [tenantA]);
    await owner.query(`INSERT INTO pr_agent_harness.run_budget_envelopes
      (tenant_id,run_id,period_key,currency,pricing_hash,input_token_limit,output_token_limit,cost_limit_micros,status)
      VALUES ($1,$2,'2026-10','USD',$3,100,100,100,'pending_reconciliation')`, [tenantA,runId,pricing]);
  }
}

function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
