import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore, type PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import { ModelBudgetStore, getModelExecutionPolicy, reserveRunBudgetInTransaction, type ModelExecutionPolicy } from "../src/agent-runtime/budget/model-budget-store.js";
import { executeModelRequest } from "../src/model/execution-context.js";
import { PublicationBatchCoordinator, PublicationBatchStore } from "../src/agent-runtime/publication/batches.js";
import { PendingPublicationError, PgPublicationStore, PublicationService, type PublicationAdapter } from "../src/agent-runtime/publication/publication.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import { assertReviewRunRevision, durableReviewAnalysis, durableReviewCollection } from "../src/agent-runtime/execution/run-context.js";
import { enqueueReviewRun } from "../src/review/intake/run-intake.js";
import { RunWorker } from "../src/agent-runtime/execution/run-worker.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import { RunExecutionStore } from "../src/agent-runtime/execution/store.js";
import { closeAgentRuntime, publicationRuntimeForBinding } from "../src/agent-runtime/runtime.js";
import { executeReviewRun } from "../src/review/run.js";
import { runGitHubReview } from "../src/integrations/github/github-review.js";
import { createRestBackedOctokit } from "../src/integrations/github/github-rest-client.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Review worker PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const roleName = `review_worker_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  let origin: string;
  const repository = "acme/durable-review";
  const providerRepositoryId = 4242;
  const version = hash("review-worker-runtime-v1");
  const policy = buildZeroPricePolicy();
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  let runStore: RunStore;
  let executionStore: RunExecutionStore;
  let budgetStore: ModelBudgetStore;
  let batchStore: PublicationBatchStore;
  let coordinator: PublicationBatchCoordinator;
  let binding: PublicationBinding;
  let mockServer: Server;
  const httpCalls: string[] = [];
  let mockPullBaseSha = "base-sha";
  let mockPullHeadSha = "head-sha";

  before(async () => {
    mockServer = createServer(async (request, response) => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      httpCalls.push(`${method} ${path}`);
      for await (const _chunk of request) { /* consume request bodies before responding */ }
      if (method === "POST" && path === "/v1/chat/completions") {
        return json(response, 200, {
          id: "chatcmpl-local-review", object: "chat.completion", created: 1, model: "fixture-model",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
            summary: "Production path review completed", riskLevel: "low", reviews: [],
            positives: ["Durable pipeline"], actionItems: [],
          }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
      }
      if (method === "GET" && path === "/user") return json(response, 200, { id: 4343, login: "pr-agent", type: "Bot" });
      if (method === "GET" && path === "/repos/acme/durable-review") return json(response, 200, { id: providerRepositoryId, full_name: repository });
      if (method === "GET" && path === "/repos/acme/durable-review/pulls/42") {
        return json(response, 200, { id: 42, number: 42, title: "Durable review", body: "Exercise the production path",
          user: { login: "alice" }, base: { ref: "main", sha: mockPullBaseSha },
          head: { ref: "feature", sha: mockPullHeadSha }, additions: 1, deletions: 0,
          changed_files: 1, draft: false, html_url: `${origin}/acme/durable-review/pull/42` });
      }
      if (method === "GET" && path.startsWith("/repos/acme/durable-review/pulls/42/files?")) {
        return json(response, 200, [{ filename: "src/value.ts", status: "modified", additions: 1,
          deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+export const value = 1;" }]);
      }
      if (method === "GET" && path === "/repos/acme/durable-review/compare/base-sha...head-sha") {
        return json(response, 200, { files: [{ filename: "src/value.ts", status: "modified", additions: 1,
          deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+export const value = 1;" }] });
      }
      if (method === "GET" && path.startsWith("/repos/acme/durable-review/issues/42/comments?")) return json(response, 200, []);
      if (method === "GET" && path.startsWith("/repos/acme/durable-review/pulls/42/comments?")) return json(response, 200, []);
      if (method === "GET" && path === "/repos/acme/durable-review/issues/42") return json(response, 200, { labels: [] });
      if (method === "POST" && path === "/repos/acme/durable-review/issues/42/comments") return json(response, 201, { id: 9001 });
      return json(response, 404, { message: "fixture route not found" });
    });
    await new Promise<void>((resolve, reject) => {
      mockServer.once("error", reject);
      mockServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Local fixture server did not bind a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`
      GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName};
      GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_runs,
        pr_agent_harness.job_queue, pr_agent_harness.repository_operations,
        pr_agent_harness.publication_slots, pr_agent_harness.publication_batches TO ${roleName};
      GRANT SELECT, INSERT ON pr_agent_harness.publication_batch_operations TO ${roleName};
      REVOKE UPDATE, DELETE ON pr_agent_harness.publication_batch_operations FROM ${roleName};
      GRANT SELECT, INSERT ON pr_agent_harness.run_events,
        pr_agent_harness.audit_logs TO ${roleName};
      GRANT SELECT, INSERT ON pr_agent_harness.publication_command_receipts TO ${roleName};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(
        uuid, uuid, text, text, text, bigint) TO ${roleName};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid) TO ${roleName};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${roleName};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_steps,
        pr_agent_harness.step_attempts, pr_agent_harness.tool_calls,
        pr_agent_harness.model_calls, pr_agent_harness.tenant_budget_accounts,
        pr_agent_harness.run_budget_envelopes, pr_agent_harness.model_budget_reservations TO ${roleName};
      GRANT SELECT, INSERT ON pr_agent_harness.checkpoints,
        pr_agent_harness.run_publication_batches, pr_agent_harness.dead_letter_jobs,
        pr_agent_harness.usage_records, pr_agent_harness.model_pricing_snapshots TO ${roleName};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.run_command_receipts,
        pr_agent_harness.run_waits TO ${roleName};
      GRANT SELECT, INSERT ON pr_agent_harness.run_wait_decisions TO ${roleName};
      GRANT SELECT ON pr_agent_harness.evolution_release_assignments,
        pr_agent_harness.evolution_release_qualifications,pr_agent_harness.evolution_candidates,
        pr_agent_harness.evolution_proposal_sources,pr_agent_harness.eval_runs,pr_agent_harness.eval_results,
        pr_agent_harness.eval_cases,pr_agent_harness.trusted_review_label_sets,
        pr_agent_harness.evolution_release_receipts,pr_agent_harness.evolution_run_assignments TO ${roleName};
      GRANT INSERT (tenant_id,integration_id,run_id,assignment_version,routing,selection,bucket,candidate_id,
        qualification_id,release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
        ON pr_agent_harness.evolution_run_assignments TO ${roleName};
      GRANT UPDATE (updated_at) ON pr_agent_harness.evolution_release_assignments TO ${roleName};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
        pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${roleName};
    `);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 12 });
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.GITHUB_TOKEN = "ghp_local_production_path_only";
    process.env.GITHUB_API_URL = origin;
    process.env.AI_PROVIDER = "openai-compatible";
    process.env.AI_MODEL = "fixture-model";
    process.env.OPENAI_BASE_URL = `${origin}/v1`;
    process.env.OPENAI_COMPATIBLE_API_KEY = "local-openai-key";
    process.env.HARNESS_MODEL_PRICING_JSON = productionPricingJson();
    appDb = new RuntimeDatabase(appPool);
    runStore = new RunStore(appDb);
    executionStore = new RunExecutionStore(appDb, { leaseTtlMs: 60_000, initialRetryMs: 10, maxRetryMs: 100 });
    budgetStore = new ModelBudgetStore(appDb);
    batchStore = new PublicationBatchStore(appDb);
    coordinator = new PublicationBatchCoordinator(batchStore, new PublicationService(new PgPublicationStore(appDb)));

    const adminDb = new RuntimeDatabase(adminPool);
    const adminRuns = new RunStore(adminDb);
    const authority = new PublicationAuthorityStore(adminDb);
    await adminRuns.registerIntegration({ tenantId, id: integrationId, platform: "github", origin, repository });
    await authority.configure({ tenantId, integrationId, providerRepositoryId, providerActorId: 4343,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    binding = await authority.transition({ tenantId, integrationId, expectedVersion: 1,
      action: "activate", actor: "review-worker-test", actorType: "service", quiescenceEvidence: "isolated Docker fixture" });
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET review_execution_mode='harness_async',execution_mode_generation=1
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );
    binding = { ...binding, reviewExecutionMode: "harness_async", executionModeGeneration: 1 };
  });

  after(async () => {
    await closeAgentRuntime();
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
    await new Promise<void>((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
  });

  test("intake atomically reserves the Run budget under the non-bypass runtime role", async () => {
    const fixture = await createRun("budget-at-intake");
    const role = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
    const envelope = await appDb.transaction(tenantId, (client) => client.query<{
      status: string; input_token_limit: string; output_token_limit: string; cost_limit_micros: string;
    }>(
      `SELECT status,input_token_limit,output_token_limit,cost_limit_micros
       FROM pr_agent_harness.run_budget_envelopes WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, fixture.runId],
    ));
    assert.deepEqual(envelope.rows[0], {
      status: "active", input_token_limit: "10000", output_token_limit: "10000", cost_limit_micros: "0",
    });
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET status='cancelled',finished_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, fixture.runId],
    );
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET status='cancelled',completed_at=now() WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixture.runId],
    );
  });

  test("worker completes collect, budgeted model, frozen publication checkpoint, publish, and terminal transition", async () => {
    const fixture = await createRun("full-pipeline");
    let dispatches = 0;
    let modelTransports = 0;
    const errors: unknown[] = [];
    const worker = makeWorker(async (lease) => {
      const collected = await collectFixture(() => undefined);
      assertReviewRunRevision("base-sha", "head-sha");
      const analyzed = await durableReviewAnalysis({ files: collected.files.map(({ newPath }) => newPath) }, async () =>
        executeModelRequest(modelIntent("full-pipeline"), async () => {
          modelTransports += 1;
          return { value: { summary: "ready" }, rawResponse: { id: "mock-model", output: "ready" },
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, original: { fixture: true } } };
        }));
      const batch = await freezeFixture(lease, "full-pipeline", { body: analyzed.summary });
      const outcome = await coordinator.execute(tenantId, batch.id, async (): Promise<PublicationAdapter> => ({
        dispatch: async () => ({ id: `remote-${++dispatches}` }), find: async () => null,
        currentRevision: async () => "head-sha",
      }), lease);
      assert.equal(outcome.status, "succeeded");
    }, errors);
    await worker.tick();
    await worker.drain();

    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "succeeded",
      errors.map((error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error)).join("\n"));
    assert.equal(modelTransports, 1);
    assert.equal(dispatches, 1);
    const evidence = await appDb.transaction(tenantId, (client) => client.query<{
      step_count: number; checkpoint_count: number; frozen_count: number; model_count: number; batch_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM pr_agent_harness.agent_steps WHERE tenant_id=$1 AND run_id=$2) step_count,
         (SELECT count(*)::int FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2) checkpoint_count,
         (SELECT count(*)::int FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2 AND checkpoint_kind='publication_frozen') frozen_count,
         (SELECT count(*)::int FROM pr_agent_harness.model_calls WHERE tenant_id=$1 AND run_id=$2) model_count,
         (SELECT count(*)::int FROM pr_agent_harness.run_publication_batches WHERE tenant_id=$1 AND run_id=$2) batch_count`,
      [tenantId, fixture.runId],
    ));
    assert.deepEqual(evidence.rows[0], { step_count: 2, checkpoint_count: 3, frozen_count: 1, model_count: 1, batch_count: 1 });
  });

  test("two workers never execute the same queued Run twice", async () => {
    const fixture = await createRun("two-workers");
    let executions = 0;
    const execute = async () => { executions += 1; await durableReviewAnalysis({ run: fixture.runId }, async () => ({ ok: true })); };
    const left = makeWorker(execute);
    const right = makeWorker(execute);
    await Promise.all([left.tick(), right.tick()]);
    await Promise.all([left.drain(), right.drain()]);
    assert.equal(executions, 1);
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "succeeded");
  });

  test("retry after process response loss reuses Map and model checkpoints without rerunning either action", async () => {
    const fixture = await createRun("checkpoint-recovery");
    let runAttempts = 0;
    let collections = 0;
    let modelTransports = 0;
    const worker = makeWorker(async () => {
      runAttempts += 1;
      const collected = await collectFixture(() => { collections += 1; });
      assert.equal(collected.files[0]?.newLinesWithNumber instanceof Map, true);
      assert.equal(collected.files[0]?.newLinesWithNumber.get(1), "const value = 1;");
      await durableReviewAnalysis({ stable: true }, async () => executeModelRequest(modelIntent("checkpoint-recovery"), async () => {
        modelTransports += 1;
        return { value: { ok: true }, rawResponse: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, original: {} } };
      }));
      if (runAttempts === 1) throw new Error("simulated process response loss after durable checkpoints");
    });
    await worker.tick();
    await worker.drain();
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "retry_wait");
    await adminPool.query(
      "UPDATE pr_agent_harness.job_queue SET available_at=now()-interval '1 second' WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixture.runId],
    );
    await worker.tick();
    await worker.drain();
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "succeeded");
    assert.equal(runAttempts, 2);
    assert.equal(collections, 1);
    assert.equal(modelTransports, 1);
  });

  test("a moved base or head fails the Run before model or publication work", async () => {
    const fixture = await createRun("revision-moved");
    let modelCalls = 0;
    const worker = makeWorker(async () => {
      await collectFixture(() => undefined);
      assertReviewRunRevision("base-sha", "new-head-sha");
      modelCalls += 1;
    });
    await worker.tick();
    await worker.drain();
    const snapshot = await executionStore.load(tenantId, fixture.runId);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.errorCode, "ReviewRunRevisionChangedError");
    assert.equal(modelCalls, 0);
  });

  test("unknown publication moves the Run to waiting_for_reconciliation without a synthetic retry", async () => {
    const fixture = await createRun("publication-unknown");
    const errors: unknown[] = [];
    const worker = makeWorker(async (lease) => {
      const batch = await freezeFixture(lease, "publication-unknown", { body: "may-have-published" });
      const outcome = await coordinator.execute(tenantId, batch.id, async () => ({
        dispatch: async () => { throw new Error("socket closed after provider accepted request"); },
        find: async () => null,
      }), lease);
      assert.equal(outcome.status, "waiting_reconciliation");
      throw new PendingPublicationError(batch.operations[0]!.businessOperationId);
    }, errors);
    await worker.tick();
    await worker.drain();
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "waiting_for_reconciliation",
      errors.map((error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error)).join("\n"));
    const job = await appDb.transaction(tenantId, (client) => client.query<{ status: string; job_kind: string }>(
      "SELECT status,job_kind FROM pr_agent_harness.job_queue WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixture.runId],
    ));
    assert.deepEqual(job.rows[0], { status: "completed", job_kind: "start" });
  });

  test("provider credentials and raw request headers never enter Run, checkpoints, calls, events, or publication rows", async () => {
    const fixture = await createRun("secret-boundary");
    const secret = "ghp_worker_secret_must_not_persist";
    const rawHeader = "Authorization: Bearer ghp_worker_secret_must_not_persist";
    let dispatches = 0;
    const errors: unknown[] = [];
    const worker = makeWorker(async (lease) => {
      await durableReviewAnalysis({ safe: true }, async () => executeModelRequest(modelIntent("secret-boundary"), async () => ({
        value: { safe: true }, rawResponse: { id: "mock", data: { safe: true } },
        usage: { inputTokens: 1, outputTokens: 1, original: {} },
      })));
      const batch = await freezeFixture(lease, "secret-boundary", { body: "safe" });
      await coordinator.execute(tenantId, batch.id, async () => ({
        dispatch: async () => {
          dispatches += 1;
          assert.equal(secret.startsWith("ghp_"), true);
          assert.match(rawHeader, /^Authorization:/);
          return { id: "remote-safe" };
        },
        find: async () => null,
      }), lease);
    }, errors);
    await worker.tick();
    await worker.drain();
    assert.equal((await executionStore.load(tenantId, fixture.runId))?.status, "succeeded",
      errors.map((error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error)).join("\n"));
    assert.equal(dispatches, 1);
    const persisted = await adminPool.query<{ payload: string }>(
      `SELECT concat_ws(' ',
         (SELECT string_agg(input_json::text || ' ' || runtime_config_json::text || ' ' || limits_json::text, ' ') FROM pr_agent_harness.agent_runs WHERE id=$1),
         (SELECT string_agg(payload_json::text, ' ') FROM pr_agent_harness.run_events WHERE run_id=$1),
         (SELECT string_agg(state_json::text, ' ') FROM pr_agent_harness.checkpoints WHERE run_id=$1),
         (SELECT string_agg(coalesce(response_json::text,''), ' ') FROM pr_agent_harness.model_calls WHERE run_id=$1),
         (SELECT string_agg(payload_json::text, ' ') FROM pr_agent_harness.repository_operations WHERE tenant_id=$2)
       ) AS payload`,
      [fixture.runId, tenantId],
    );
    assert.doesNotMatch(persisted.rows[0]?.payload ?? "", /ghp_worker_secret_must_not_persist|Authorization:\s*Bearer/i);
  });

  test("production enqueue and executeReviewRun use local GitHub and OpenAI HTTP through a sealed batch", async () => {
    const beforeCalls = httpCalls.length;
    const queued = await enqueueReviewRun(binding, {
      schemaVersion: 1, workflow: "review.single.v1", platform: "github",
      target: { origin, repository, number: 42, providerRepositoryId },
      source: { key: "production-path:42", hash: hash("production-path:42") },
      revision: { baseSha: "base-sha", headSha: "head-sha" },
      mode: "report", trigger: "comment-command",
      options: { customRules: [], includeCiChecks: false, enableSecretScan: false,
        secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Durable review", body: "Exercise the production path", author: "alice",
        baseBranch: "main", headBranch: "feature", webUrl: `${origin}/acme/durable-review/pull/42`, draft: false },
    });
    const pinned = await appDb.transaction(tenantId, (client) => client.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
      [tenantId, queued.id],
    ));
    const errors: unknown[] = [];
    const worker = new RunWorker({
      store: executionStore, budget: budgetStore, bindings: async () => [binding],
      runtimeHash: async () => pinned.rows[0]!.runtime_version_hash,
      execute: executeReviewRun, onError: (error) => { errors.push(error); },
    }, 1);
    await worker.tick();
    await worker.drain();
    assert.equal((await executionStore.load(tenantId, queued.id))?.status, "succeeded",
      errors.map((error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error)).join("\n"));
    const evidence = await appDb.transaction(tenantId, (client) => client.query<{
      sealed_batches: number; frozen_checkpoints: number; succeeded_operations: number; model_calls: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM pr_agent_harness.publication_batches pb
          JOIN pr_agent_harness.run_publication_batches rpb ON rpb.tenant_id=pb.tenant_id AND rpb.batch_id=pb.id
          WHERE rpb.tenant_id=$1 AND rpb.run_id=$2 AND pb.seal_state='sealed' AND pb.status='succeeded') sealed_batches,
        (SELECT count(*)::int FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2 AND checkpoint_kind='publication_frozen') frozen_checkpoints,
        (SELECT count(*)::int FROM pr_agent_harness.repository_operations ro
          JOIN pr_agent_harness.run_publication_batches rpb ON rpb.tenant_id=ro.tenant_id
          JOIN pr_agent_harness.publication_batch_operations pbo ON pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id
            AND pbo.business_operation_id=ro.business_operation_id
          WHERE rpb.tenant_id=$1 AND rpb.run_id=$2 AND ro.status='succeeded') succeeded_operations,
        (SELECT count(*)::int FROM pr_agent_harness.model_calls WHERE tenant_id=$1 AND run_id=$2 AND status='succeeded') model_calls`,
      [tenantId, queued.id],
    ));
    assert.deepEqual(evidence.rows[0], { sealed_batches: 1, frozen_checkpoints: 1, succeeded_operations: 1, model_calls: 1 });
    const calls = httpCalls.slice(beforeCalls);
    assert.ok(calls.includes("POST /v1/chat/completions"));
    assert.ok(calls.includes("POST /repos/acme/durable-review/issues/42/comments"));
    assert.ok(calls.includes("GET /repos/acme/durable-review/compare/base-sha...head-sha"));
    assert.equal(calls.some((call) => call.startsWith("GET /repos/acme/durable-review/pulls/42/files?")), false);
    assert.ok(calls.some((call) => call.includes("/contents/") && call.includes("ref=base-sha")));
    assert.equal(calls.some((call) => call.includes("/contents/") && call.includes("ref=main")), false);

    // A delivery after batch freeze must return the existing Run, never execute
    // its batch outside the leased worker (even when the batch already succeeded).
    const runtime = await publicationRuntimeForBinding(binding);
    const executeBatch = runtime.batchCoordinator.execute;
    runtime.batchCoordinator.execute = async () => { throw new Error("Webhook must not dispatch a Run-linked batch"); };
    let replayRunId: string | undefined;
    try {
      await runGitHubReview({
        context: { repo: () => ({ owner: "acme", repo: "durable-review" }),
          octokit: createRestBackedOctokit({ token: "local-fixture", baseUrl: origin }),
          log: { info: () => undefined, error: () => undefined } },
        pullNumber: 42, mode: "report", trigger: "comment-command",
        sourceKey: "production-path:42", sourceHash: hash("production-path:42"),
        includeCiChecks: false, enableSecretScan: false, enableAutoLabel: false,
        publicationRuntime: { ...runtime, binding: { ...binding, platform: "github" } },
        onQueued: (runId) => { replayRunId = runId; }, throwOnError: true,
      });
    } finally {
      runtime.batchCoordinator.execute = executeBatch;
    }
    assert.equal(replayRunId, queued.id);
  });

  test("production collector stops before compare, model, or publish when PR metadata moved after intake", async () => {
    const queued = await enqueueReviewRun(binding, {
      schemaVersion: 1, workflow: "review.single.v1", platform: "github",
      target: { origin, repository, number: 42, providerRepositoryId },
      source: { key: "production-path:moved", hash: hash("production-path:moved") },
      revision: { baseSha: "base-sha", headSha: "head-sha" },
      mode: "report", trigger: "comment-command",
      options: { customRules: [], includeCiChecks: false, enableSecretScan: false,
        secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Durable review", body: "Moved after intake", author: "alice",
        baseBranch: "main", headBranch: "feature", webUrl: `${origin}/acme/durable-review/pull/42`, draft: false },
    });
    const pinned = await appDb.transaction(tenantId, (client) => client.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
      [tenantId, queued.id],
    ));
    const beforeCalls = httpCalls.length;
    mockPullHeadSha = "head-moved-after-intake";
    try {
      const worker = new RunWorker({
        store: executionStore, budget: budgetStore, bindings: async () => [binding],
        runtimeHash: async () => pinned.rows[0]!.runtime_version_hash,
        execute: executeReviewRun, onError: () => undefined,
      }, 1);
      await worker.tick();
      await worker.drain();
    } finally {
      mockPullHeadSha = "head-sha";
      mockPullBaseSha = "base-sha";
    }
    const snapshot = await executionStore.load(tenantId, queued.id);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.errorCode, "ReviewRunRevisionChangedError");
    const calls = httpCalls.slice(beforeCalls);
    assert.equal(calls.includes("GET /repos/acme/durable-review/compare/base-sha...head-sha"), false);
    assert.equal(calls.includes("POST /v1/chat/completions"), false);
    assert.equal(calls.includes("POST /repos/acme/durable-review/issues/42/comments"), false);
  });

  function makeWorker(
    execute: ConstructorParameters<typeof RunWorker>[0]["execute"],
    errors: unknown[] = [],
  ): RunWorker {
    return new RunWorker({
      store: executionStore,
      budget: budgetStore,
      bindings: async () => [binding],
      runtimeHash: async () => version,
      execute,
      onError: (error) => { errors.push(error); },
    }, 1);
  }

  async function createRun(key: string): Promise<{ runId: string }> {
    const created = await runStore.createRun({
      tenantId, integrationId, actorType: "service", actorId: "review-worker-test",
      createScope: "review-worker.pg.v1", createKey: key, requestHash: hash(`request:${key}`),
      runType: "review.single.v1", baseSha: "base-sha", headSha: "head-sha",
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: policy.hash, runtimeVersionHash: version,
      input: { fixture: key }, authorityGeneration: binding.generation, executionModeGeneration: 1,
      runtimeConfig: { modelPolicy: policy },
      limits: { maxStepAttempts: 3, maxJobAttempts: 3, maxRunMs: 60_000, model: policy.runLimits },
      admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId, runId, policy }),
    });
    return { runId: created.id };
  }

  async function collectFixture(onCollect: () => void) {
    return durableReviewCollection("github.collect_context.v1", async () => {
      onCollect();
      return { files: [{
        newPath: "src/value.ts", oldPath: "src/value.ts", status: "modified",
        additions: 1, deletions: 0, extendedDiff: "+const value = 1;", patch: "+const value = 1;",
        oldLinesWithNumber: new Map<number, string>(), newLinesWithNumber: new Map([[1, "const value = 1;"]]),
      }] };
    });
  }

  async function freezeFixture(lease: RunLease, key: string, payload: Record<string, unknown>) {
    return batchStore.freeze({
      runLease: lease,
      scope: { tenantId, integrationId, platform: "github", origin, repository,
        target: "pull:42", revision: lease.headSha, authorityGeneration: binding.generation },
      sourceKey: `worker:${key}`, sourceHash: hash(`source:${key}`),
      operations: [{ slot: `fixture:${key}`, payload }],
    });
  }

  function modelIntent(key: string) {
    return { provider: "openai" as const, model: "fixture-model", requestKind: "review",
      requestHash: hash(`model:${key}`), inputTokenUpperBound: 100, maxOutputTokens: 100 };
  }
}

function buildZeroPricePolicy(): ModelExecutionPolicy {
  return getModelExecutionPolicy("openai", "fixture-model", {
    NODE_ENV: "test",
    HARNESS_MODEL_PRICING_JSON: JSON.stringify({
      version: "review-worker-zero-price-v1", currency: "USD", periodKey: "review-worker-tests",
      tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
      runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
      models: { "openai:fixture-model": { rates: {
        inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0, thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0,
      }, maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3 } },
    }),
  });
}

function productionPricingJson(): string {
  return JSON.stringify({
    version: "review-worker-zero-price-v1", currency: "USD", periodKey: "review-worker-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
    models: { "openai-compatible:fixture-model": { rates: {
      inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0, thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0,
    }, maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } },
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
