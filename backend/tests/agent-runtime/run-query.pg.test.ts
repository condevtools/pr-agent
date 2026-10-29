import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { RunControlError, type RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { appendRunFact } from "../../src/agent-runtime/runs/events.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { RunCursorExpiredError, RunQueryStore } from "../../src/agent-runtime/runs/query-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Run query PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 3 });
  const adminDb = new RuntimeDatabase(adminPool);
  const adminRuns = new RunStore(adminDb);
  const role = `run_query_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const integrationId = randomUUID();
  const otherIntegrationId = randomUUID();
  let appPool: Pool;
  let queries: RunQueryStore;
  let runId: string;
  let otherIntegrationRunId: string;
  let otherTenantRunId: string;

  const reader: RunPrincipal = { subjectId: "reader", actorType: "user", tenantId, integrationId,
    permissions: ["runs:read", "runs:trace"] };

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
    await adminPool.query(`GRANT SELECT ON pr_agent_harness.integration_bindings,pr_agent_harness.agent_runs,
      pr_agent_harness.run_events,pr_agent_harness.publication_batches,pr_agent_harness.run_publication_batches,pr_agent_harness.run_waits,
      pr_agent_harness.agent_steps,pr_agent_harness.step_attempts,pr_agent_harness.model_calls,
      pr_agent_harness.tool_calls,pr_agent_harness.checkpoints,pr_agent_harness.usage_records,
      pr_agent_harness.audit_logs,pr_agent_harness.run_command_receipts,pr_agent_harness.review_artifacts,
      pr_agent_harness.evolution_run_assignments TO ${role}`);
    // FOR SHARE serializes the event retention floor with its history page.
    await adminPool.query(`GRANT UPDATE ON pr_agent_harness.agent_runs TO ${role}`);
    const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });
    queries = new RunQueryStore(new RuntimeDatabase(appPool));

    await register(tenantId, integrationId, "primary");
    await register(tenantId, otherIntegrationId, "other-integration");
    await register(otherTenantId, randomUUID(), "other-tenant").then((value) => { otherTenantRunId = value; });
    runId = await create(tenantId, integrationId, "primary-run", { public: "input", secretToken: "input-secret" });
    otherIntegrationRunId = await create(tenantId, otherIntegrationId, "other-integration-run", { public: "other" });
    await adminDb.transaction(tenantId, async (client) => {
      await appendRunFact(client, { tenantId, runId, eventType: "run.internal", actorType: "system", actorId: "test",
        visibility: "internal", payload: { status: "hidden", rawSecret: "event-secret" } });
      await appendRunFact(client, { tenantId, runId, eventType: "run.progress", actorType: "worker", actorId: "test",
        visibility: "public", payload: { status: "running", version: 2, rawSecret: "event-secret" } });
    });
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let index = 0; index < 201; index += 1) {
      const offset = values.length;
      values.push(tenantId, runId, `trace.action.${index}`, "trace-secret", JSON.stringify({ rawToken: "trace-secret" }));
      tuples.push(`($${offset + 1},$${offset + 2},'service','trace-actor',$${offset + 3},'allowed','fixture','run',$${offset + 4},$${offset + 5}::jsonb)`);
    }
    await adminPool.query(
      `INSERT INTO pr_agent_harness.audit_logs
       (tenant_id,run_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
       VALUES ${tuples.join(",")}`,
      values,
    );
  });

  after(async () => {
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    await adminPool.end();
  });

  test("snapshot scope requires both tenant and integration and read permission", async () => {
    assert.equal((await queries.snapshot(reader, runId)).id, runId);
    await assert.rejects(queries.snapshot({ ...reader, integrationId: otherIntegrationId }, runId), notFound);
    await assert.rejects(queries.snapshot({ ...reader, tenantId: otherTenantId }, runId), notFound);
    await assert.rejects(queries.snapshot(reader, otherIntegrationRunId), notFound);
    await assert.rejects(queries.snapshot(reader, otherTenantRunId), notFound);
    await assert.rejects(queries.snapshot({ ...reader, permissions: ["runs:trace"] }, runId), forbidden);
  });

  test("event pages expose public fields only while advancing the cursor over internal events", async () => {
    const page = await queries.events(reader, runId);
    assert.deepEqual(page.events.map(({ sequence }) => sequence), [1, 3]);
    assert.equal(page.cursor, `${runId}:3`);
    assert.equal(page.highWater, `${runId}:3`);
    assert.deepEqual(page.events[1]?.payload, { status: "running", version: 2 });
    assert.doesNotMatch(JSON.stringify(page), /event-secret|rawSecret/);
  });

  test("expired event cursor returns a reload snapshot and durable resume cursor", async () => {
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET event_retention_floor=3 WHERE tenant_id=$1 AND id=$2", [tenantId, runId]);
    await assert.rejects(queries.events(reader, runId, `${runId}:0`), (error: unknown) => {
      assert.ok(error instanceof RunCursorExpiredError);
      assert.equal(error.status, 410);
      assert.equal(error.snapshot.id, runId);
      assert.equal(error.resumeCursor, `${runId}:3`);
      return true;
    });
  });

  test("event and trace cursors belonging to another Run are rejected before querying data", async () => {
    await assert.rejects(queries.events(reader, runId, `${randomUUID()}:1`), invalidCursor);
    const foreignTrace = Buffer.from(JSON.stringify({ runId: randomUUID(), time: new Date().toISOString(),
      id: randomUUID(), kind: "audit" })).toString("base64url");
    await assert.rejects(queries.trace(reader, runId, foreignTrace), invalidCursor);
  });

  test("trace pagination returns bounded metadata and never raw request or secret detail fields", async () => {
    const first = await queries.trace(reader, runId);
    const entries = first.entries as Array<Record<string, unknown>>;
    assert.equal(entries.length, 200);
    assert.equal(typeof first.nextCursor, "string");
    assert.doesNotMatch(JSON.stringify(first), /trace-secret|details_json|actor_id/);
    const second = await queries.trace(reader, runId, first.nextCursor as string);
    assert.ok((second.entries as unknown[]).length >= 1);
    assert.equal(second.nextCursor, null);
  });

  test("original input requires rerun permission and remains integration scoped", async () => {
    await assert.rejects(queries.originalInput(reader, runId), forbidden);
    assert.deepEqual(await queries.originalInput({ ...reader, permissions: ["runs:rerun"] }, runId),
      { public: "input", secretToken: "input-secret" });
    await assert.rejects(queries.originalInput({ ...reader, integrationId: otherIntegrationId,
      permissions: ["runs:rerun"] }, runId), notFound);
  });

  test("retained identity stays readable but removed content cannot be used for rerun", async () => {
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET content_purged_at=clock_timestamp(),input_json='{}' WHERE id=$1", [runId]);
    assert.ok((await queries.snapshot(reader, runId)).contentPurgedAt);
    await assert.rejects(queries.originalInput({ ...reader, permissions: ["runs:rerun"] }, runId),
      (error: unknown) => error instanceof RunControlError && error.status === 410 && error.code === "RUN_CONTENT_EXPIRED");
  });

  async function register(currentTenant: string, currentIntegration: string, suffix: string): Promise<string> {
    await adminRuns.registerIntegration({ tenantId: currentTenant, id: currentIntegration, platform: "github",
      origin: `https://${suffix}.example.test`, repository: `acme/${suffix}` });
    return create(currentTenant, currentIntegration, `${suffix}-registered`, { suffix });
  }

  async function create(currentTenant: string, currentIntegration: string, key: string, input: Record<string, unknown>): Promise<string> {
    const version = hash("query-version");
    return (await adminRuns.createRun({ tenantId: currentTenant, integrationId: currentIntegration,
      actorType: "service", actorId: "query-test", createScope: "query-test", createKey: key,
      requestHash: hash(key), runType: "review", baseSha: "base", headSha: "head",
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version, input })).id;
  }
}

function notFound(error: unknown): boolean { return error instanceof RunControlError && error.code === "RUN_NOT_FOUND" && error.status === 404; }
function forbidden(error: unknown): boolean { return error instanceof RunControlError && error.code === "FORBIDDEN" && error.status === 403; }
function invalidCursor(error: unknown): boolean { return error instanceof RunControlError && error.code === "INVALID_CURSOR" && error.status === 400; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
