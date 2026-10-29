import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore, type CreateRunInput } from "../../src/agent-runtime/postgres/run-store.js";
import { createBudgetedModelExecutionContext, getModelExecutionPolicy, ModelBudgetStore,
  reserveRunBudgetInTransaction } from "../../src/agent-runtime/budget/model-budget-store.js";
import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { RunLeaseLostError, type RunLease, type RunStep } from "../../src/agent-runtime/runs/contracts.js";
import { RunControlStore } from "../../src/agent-runtime/runs/control-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
if (!databaseUrl) {
  test.skip("Process crash tests require disposable Docker PostgreSQL", () => {});
} else {
  if (!new URL(databaseUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");
  const adminPool = new Pool({ connectionString: databaseUrl, max: 3 });
  const adminDb = new RuntimeDatabase(adminPool);
  const role = `crash_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const children = new Set<ChildProcess>();
  const version = hash("crash-version");
  const policy = getModelExecutionPolicy("openai", "crash-model", {
    HARNESS_MODEL_PRICING_JSON: JSON.stringify({ version: "crash-pricing", currency: "USD", periodKey: "crash-test",
      tenantLimits: { inputTokens: 10000, outputTokens: 10000, costMicros: 100000 },
      runLimits: { inputTokens: 100, outputTokens: 100, costMicros: 1000 },
      models: { "openai:crash-model": { maxOutputTokens: 10, maxPhysicalCallsPerStep: 3,
        rates: { inputMicrosPerMillion: 1000000, cachedInputMicrosPerMillion: 1000000,
          cacheWriteInputMicrosPerMillion: 1000000, outputMicrosPerMillion: 1000000,
          thoughtOutputMicrosPerMillion: 1000000, toolInputMicrosPerMillion: 1000000 } } } }),
  });
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  let appUrl: string;
  let store: RunExecutionStore;
  let budget: ModelBudgetStore;
  let server: Server;
  let providerUrl: string;
  let physicalRequests = 0;
  let providerRepositoryId = 0;

  before(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    server = createServer((_req, res) => {
      physicalRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: "fixture answer", rawResponse: { answer: "fixture answer" },
        usage: { inputTokens: 5, outputTokens: 3, original: {} }, providerRequestId: `fixture-${physicalRequests}` }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Provider fixture did not bind");
    providerUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const child of children) await kill(child);
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    await adminPool.end();
  });

  test("SIGKILL during actual migration DDL rolls back; two forward replays preserve checksums", async () => {
    const child = launch(databaseUrl!, { mode: "migration" });
    assert.equal((await message(child)).phase, "migration_uncommitted");
    assert.equal((await adminPool.query("SELECT to_regnamespace('pr_agent_harness') AS name")).rows[0].name, null);
    await kill(child);
    await migrateRuntime(adminPool);
    const first = await adminPool.query("SELECT migration_name,checksum_sha256 FROM pr_agent_harness.schema_migrations ORDER BY migration_name");
    await migrateRuntime(adminPool);
    const second = await adminPool.query("SELECT migration_name,checksum_sha256 FROM pr_agent_harness.schema_migrations ORDER BY migration_name");
    assert.deepEqual(second.rows, first.rows);
    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role};
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA pr_agent_harness TO ${role};
      REVOKE UPDATE,DELETE ON pr_agent_harness.checkpoints,pr_agent_harness.run_publication_batches FROM ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${role}`);
    const url = new URL(databaseUrl!); url.username = role; url.password = password; appUrl = url.toString();
    appPool = new Pool({ connectionString: appUrl, max: 4 });
    appDb = new RuntimeDatabase(appPool);
    store = new RunExecutionStore(appDb, { initialRetryMs: 1, maxRetryMs: 2 });
    budget = new ModelBudgetStore(appDb);
  });

  test("SIGKILL after provider success before commit retains unknown cost and fences the old epoch", async () => {
    const fixture = await createFixture("lost-response");
    const initialCalls = physicalRequests;
    const child = launch(appUrl, { mode: "response_before_commit", ...fixture });
    const received = await message(child);
    assert.equal(physicalRequests, initialCalls + 1);
    await kill(child);
    const replacement = await reclaim(fixture, received.lease);
    await assert.rejects(store.heartbeat(received.lease), RunLeaseLostError);
    const step = await store.beginStep(replacement, { stepKey: "model:crash", kind: "model", inputHash: hash("model-input") });
    assert.equal(step.id, received.step.id);
    assert.equal(step.attemptNumber, 2);
    const context = createBudgetedModelExecutionContext({ store: budget, lease: replacement,
      stepId: step.id, stepAttemptId: step.attemptId, policy });
    assert.equal(await context.execute({ provider: "openai", model: "crash-model", requestKind: "chat-completion",
      requestHash: hash("model-request"), inputTokenUpperBound: 20, maxOutputTokens: 10 },
    async () => (await fetch(providerUrl)).json()), "fixture answer");
    const ledger = await adminPool.query(
      `SELECT mc.status,br.status AS budget_status FROM pr_agent_harness.model_calls mc
       JOIN pr_agent_harness.model_budget_reservations br ON br.model_call_id=mc.id
       WHERE mc.run_id=$1 ORDER BY mc.created_at`, [fixture.runId]);
    assert.deepEqual(ledger.rows, [{ status: "unknown", budget_status: "pending" }, { status: "succeeded", budget_status: "settled" }]);
    assert.equal(physicalRequests, initialCalls + 2);
  });

  test("SIGKILL after checkpoint reuses completed model work without another provider request", async () => {
    const fixture = await createFixture("completed-checkpoint");
    const initialCalls = physicalRequests;
    const child = launch(appUrl, { mode: "checkpoint_before_finish", ...fixture });
    const received = await message(child);
    await kill(child);
    const lease = await reclaim(fixture, received.lease);
    const step = await store.beginStep(lease, { stepKey: "model:crash", kind: "model", inputHash: hash("model-input") });
    assert.equal(step.reused, true);
    assert.deepEqual(step.output, { answer: "fixture answer" });
    assert.equal(physicalRequests, initialCalls + 1);
    assert.equal((await store.latestCheckpoint(lease, { schemaVersion: 1, runtimeVersionHash: version }))?.state.next, "complete");
  });

  test("SIGKILL after terminal commit before acknowledgement never revives the completed Run", async () => {
    const fixture = await createFixture("terminal-ack");
    const child = launch(appUrl, { mode: "terminal_before_ack", ...fixture });
    const received = await message(child);
    await kill(child);
    assert.equal((await store.load(fixture.binding.tenantId, fixture.runId))?.status, "succeeded");
    assert.equal(await store.claim(fixture.binding, "replacement", version), undefined);
    await assert.rejects(store.heartbeat(received.lease), RunLeaseLostError);
    const counts = await adminPool.query("SELECT count(*)::int AS count FROM pr_agent_harness.checkpoints WHERE run_id=$1", [fixture.runId]);
    assert.equal(counts.rows[0].count, 1);
  });

  test("concurrent cancel and finish produce one terminal outcome without allowing a late heartbeat", async () => {
    const fixture = await createFixture("cancel-finish-race");
    const lease = (await store.claim(fixture.binding, "race-worker", version))!;
    const before = (await store.load(lease.tenantId, lease.runId))!;
    const principal = { subjectId: "cancel-operator", actorType: "user" as const,
      tenantId: lease.tenantId, integrationId: lease.integrationId, permissions: ["runs:cancel" as const] };
    const [cancel, finish] = await Promise.allSettled([
      new RunControlStore(appDb).apply(principal, lease.runId,
        { kind: "cancel", expectedVersion: before.version, commandKey: "cancel-race" }),
      store.transition(lease, { to: "succeeded", reasonCode: "finished", outcomeCode: "artifact_complete" }),
    ]);
    await store.sweep(fixture.binding);
    const after = (await store.load(lease.tenantId, lease.runId))!;
    assert.ok(["succeeded", "cancelled"].includes(after.status));
    assert.notEqual(cancel.status, finish.status);
    assert.equal(after.status, cancel.status === "fulfilled" ? "cancelled" : "succeeded");
    await assert.rejects(store.heartbeat(lease), RunLeaseLostError);
    const terminal = await adminPool.query("SELECT count(*)::int AS count FROM pr_agent_harness.run_events WHERE run_id=$1 AND event_type IN ('run.succeeded','run.cancelled')", [lease.runId]);
    assert.equal(terminal.rows[0].count, 1);
  });

  test("concurrent dead-letter rerun commands create one new Run and retain the dead original", async () => {
    const fixture = await createFixture("dead-letter-rerun");
    const lease = (await store.claim(fixture.binding, "failed-worker", version))!;
    await budget.closeRunBudget(lease);
    await store.transition(lease, { to: "failed", reasonCode: "fixture_permanent_failure", outcomeCode: "failed" });
    const original = (await store.load(lease.tenantId, lease.runId))!;
    const principal = { subjectId: "rerun-operator", actorType: "user" as const,
      tenantId: lease.tenantId, integrationId: lease.integrationId, permissions: ["runs:rerun" as const] };
    const control = new RunControlStore(appDb);
    const command = { kind: "rerun" as const, expectedVersion: original.version, commandKey: "rerun-once" };
    const creation = { ...fixture.creation, createKey: "rerun-new-identity", requestHash: hash("rerun-new-identity") };
    const receipts = await Promise.all([control.apply(principal, lease.runId, command, creation),
      control.apply(principal, lease.runId, command, creation)]);
    assert.equal(receipts[0].id, receipts[1].id);
    assert.equal(receipts[0].result.newRunId, receipts[1].result.newRunId);
    assert.equal((await store.load(lease.tenantId, lease.runId))?.status, "failed");
    const children = await adminPool.query("SELECT count(*)::int AS count FROM pr_agent_harness.agent_runs WHERE parent_run_id=$1", [lease.runId]);
    assert.equal(children.rows[0].count, 1);
    const next = (await store.claim(fixture.binding, "new-run-worker", version))!;
    assert.equal(next.runId, receipts[0].result.newRunId);
    assert.notEqual(next.runId, lease.runId);
    await assert.rejects(store.heartbeat(lease), RunLeaseLostError);
  });

  async function createFixture(key: string) {
    const tenantId = randomUUID(); const integrationId = randomUUID();
    const runs = new RunStore(adminDb);
    await runs.registerIntegration({ tenantId, id: integrationId, platform: "github", origin: "https://api.github.com", repository: `crash/${key}` });
    const authority = new PublicationAuthorityStore(adminDb);
    await authority.configure({ tenantId, integrationId, providerRepositoryId: ++providerRepositoryId, providerActorId: 2,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    await authority.transition({ tenantId, integrationId, expectedVersion: 1, action: "activate", actor: "crash-test",
      quiescenceEvidence: "isolated fixture" });
    await adminPool.query("UPDATE pr_agent_harness.integration_bindings SET review_execution_mode='harness_async',execution_mode_generation=1 WHERE id=$1", [integrationId]);
    const binding = { tenantId, integrationId, authorityGeneration: 1, executionModeGeneration: 1 };
    const creation: CreateRunInput = { tenantId, integrationId, createScope: "crash-tests", createKey: key,
      requestHash: hash(key), actorType: "service", actorId: "crash-test", runType: "review.single.v1",
      baseSha: "base", headSha: "head", authorityGeneration: 1, executionModeGeneration: 1,
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version, toolVersionHash: version,
      policyVersionHash: policy.hash, runtimeVersionHash: version, input: {}, runtimeConfig: { maxJobAttempts: 3 },
      admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId, runId, policy }) };
    const run = await new RunStore(appDb).createRun(creation);
    return { binding, runId: run.id, policy, runtimeHash: version, providerUrl, creation };
  }

  async function reclaim(fixture: Awaited<ReturnType<typeof createFixture>>, old: RunLease): Promise<RunLease> {
    // Advance only the test lease; production takeover still uses the real PG-clock sweeper and claim.
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [fixture.runId]);
    assert.equal((await store.sweep(fixture.binding)).retried, 1);
    await adminPool.query("UPDATE pr_agent_harness.job_queue SET available_at=now()-interval '1 second' WHERE run_id=$1", [fixture.runId]);
    const lease = await store.claim(fixture.binding, "replacement", version);
    assert.ok(lease && lease.epoch > old.epoch);
    return lease;
  }

  function launch(url: string, input: Record<string, unknown>): ChildProcess {
    const child = fork(fileURLToPath(new URL("../fixtures/harness-crash-process.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, NODE_ENV: "test", HARNESS_PUBLICATION_MODE: "legacy", HARNESS_TEST_CHILD_DATABASE_URL: url },
    });
    children.add(child);
    child.send(input);
    return child;
  }
  function message(child: ChildProcess): Promise<{ phase: string; lease: RunLease; step: RunStep; callId: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Crash fixture timed out")), 10000);
      const onExit = () => done(new Error("Crash fixture exited before checkpoint"));
      const onMessage = (value: any) => done(value.error ? new Error(value.error) : undefined, value);
      function done(error?: Error, value?: any) {
        clearTimeout(timer); child.off("exit", onExit); child.off("message", onMessage);
        error ? reject(error) : resolve(value);
      }
      child.once("exit", onExit); child.once("message", onMessage);
    });
  }
  async function kill(child: ChildProcess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    children.delete(child);
  }
}
