import "reflect-metadata";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";

import { NestFactory, type INestApplication } from "@nestjs/core";
import { Pool } from "pg";

import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { closeAgentRuntime } from "../../src/agent-runtime/runtime.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { AgentRuntimeModule } from "../../src/http/runs/agent-runtime.module.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Harness HTTP API PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const adminDb = new RuntimeDatabase(adminPool);
  const adminRuns = new RunStore(adminDb);
  const role = `run_api_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const crossIntegrationId = randomUUID();
  const repository = "acme/api-review";
  const providerRepositoryId = 8128;
  const fullToken = "api-full-token";
  const readerToken = "api-reader-token";
  const crossToken = "api-cross-token";
  const readOnlyToken = "api-read-only-token";
  let origin = "";
  let apiOrigin = "";
  let providerOnline = true;
  let providerLookups = 0;
  let providerServer: Server;
  let app: INestApplication;
  let appPool: Pool;
  let cancelRunId: string;
  let cursorRunId: string;

  before(async () => {
    providerServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      if (!providerOnline) return json(response, 503, { message: "provider fixture offline" });
      if (request.method === "GET" && request.url === "/repos/acme/api-review/pulls/42") {
        providerLookups += 1;
        return json(response, 200, {
          id: 42, number: 42, title: "API review", body: "Durable API intake", user: { login: "alice" },
          base: { ref: "main", sha: "api-base-sha" }, head: { ref: "feature", sha: "api-head-sha" },
          draft: false, html_url: `${origin}/acme/api-review/pull/42`,
        });
      }
      return json(response, 404, { message: "fixture route not found" });
    });
    await listen(providerServer);
    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === "string") throw new Error("Provider fixture did not bind");
    origin = `http://127.0.0.1:${providerAddress.port}`;

    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`
      GRANT USAGE ON SCHEMA pr_agent_harness TO ${role};
      GRANT SELECT ON pr_agent_harness.integration_bindings TO ${role};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_runs,
        pr_agent_harness.job_queue, pr_agent_harness.repository_operations,
        pr_agent_harness.publication_slots, pr_agent_harness.publication_batches TO ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.publication_batch_operations TO ${role};
      REVOKE UPDATE, DELETE ON pr_agent_harness.publication_batch_operations FROM ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.run_events,pr_agent_harness.audit_logs TO ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.publication_command_receipts TO ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(
        uuid, uuid, text, text, text, bigint) TO ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid) TO ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${role};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_steps,
        pr_agent_harness.step_attempts, pr_agent_harness.tool_calls,
        pr_agent_harness.model_calls, pr_agent_harness.tenant_budget_accounts,
        pr_agent_harness.run_budget_envelopes, pr_agent_harness.model_budget_reservations TO ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.checkpoints,
        pr_agent_harness.run_publication_batches, pr_agent_harness.dead_letter_jobs,
        pr_agent_harness.usage_records, pr_agent_harness.model_pricing_snapshots TO ${role};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.run_command_receipts,
        pr_agent_harness.run_waits TO ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.run_wait_decisions TO ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.evidence_records,pr_agent_harness.finding_candidates,
        pr_agent_harness.finding_decisions,pr_agent_harness.review_artifacts TO ${role};
      GRANT SELECT ON pr_agent_harness.evolution_release_assignments,
        pr_agent_harness.evolution_release_qualifications,pr_agent_harness.evolution_candidates,
        pr_agent_harness.evolution_proposal_sources,pr_agent_harness.eval_runs,pr_agent_harness.eval_results,
        pr_agent_harness.eval_cases,pr_agent_harness.trusted_review_label_sets,
        pr_agent_harness.evolution_release_receipts,pr_agent_harness.evolution_run_assignments TO ${role};
      GRANT INSERT (tenant_id,integration_id,run_id,assignment_version,routing,selection,bucket,candidate_id,
        qualification_id,release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
        ON pr_agent_harness.evolution_run_assignments TO ${role};
      GRANT UPDATE (updated_at) ON pr_agent_harness.evolution_release_assignments TO ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
        pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${role};
    `);
    const appUrl = new URL(databaseUrl);
    appUrl.username = role;
    appUrl.password = password;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });

    await adminRuns.registerIntegration({ tenantId, id: integrationId, platform: "github", origin, repository });
    const authority = new PublicationAuthorityStore(adminDb);
    await authority.configure({ tenantId, integrationId, providerRepositoryId, providerActorId: 99,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    await authority.transition({ tenantId, integrationId, expectedVersion: 1, action: "activate",
      actor: "api-test", actorType: "service", quiescenceEvidence: "isolated Docker fixture" });
    await adminPool.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET review_execution_mode='harness_async',execution_mode_generation=1
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );
    cancelRunId = await createFixtureRun("cancel");
    cursorRunId = await createFixtureRun("cursor");

    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.GITHUB_TOKEN = "github-provider-secret";
    process.env.GITHUB_API_URL = origin;
    process.env.AI_PROVIDER = "openai-compatible";
    process.env.AI_MODEL = "fixture-model";
    process.env.HARNESS_MODEL_PRICING_JSON = pricingFixture();
    process.env.HARNESS_API_PRINCIPALS_JSON = JSON.stringify([
      principal("full", fullToken, tenantId, integrationId, ["runs:create", "runs:read", "runs:trace", "runs:cancel"]),
      principal("reader", readerToken, tenantId, integrationId, ["runs:read", "runs:trace"]),
      principal("cross", crossToken, tenantId, crossIntegrationId, ["runs:read", "runs:trace"]),
      principal("read-only", readOnlyToken, tenantId, integrationId, ["runs:read"]),
    ]);
    app = await NestFactory.create(AgentRuntimeModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const apiAddress = app.getHttpServer().address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("Harness API did not bind");
    apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
  });

  after(async () => {
    await app?.close();
    await closeAgentRuntime();
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    await adminPool.end();
    await close(providerServer);
  });

  test("POST /runs returns 202 and replays the same Run without contacting an offline provider", async () => {
    const body = { number: 42, mode: "report" };
    const first = await request("/runs", { method: "POST", token: fullToken, idempotencyKey: "offline-replay", body });
    assert.equal(first.status, 202);
    assert.equal(first.value.created, true);
    assert.equal(providerLookups, 1);

    providerOnline = false;
    const replay = await request("/runs", { method: "POST", token: fullToken, idempotencyKey: "offline-replay", body });
    providerOnline = true;
    assert.equal(replay.status, 202);
    assert.equal(replay.value.id, first.value.id);
    assert.equal(replay.value.created, false);
    assert.equal(providerLookups, 1);
  });

  test("POST /runs rejects an idempotency key reused for a different request", async () => {
    const response = await request("/runs", { method: "POST", token: fullToken,
      idempotencyKey: "offline-replay", body: { number: 43, mode: "report" } });
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.value), "RUN_CONFLICT");
  });

  test("deep intake is explicit and cannot reuse the single workflow creation key", async () => {
    const conflict = await request("/runs", { method: "POST", token: fullToken, idempotencyKey: "offline-replay",
      body: { number: 42, workflow: "review.deep.v1" } });
    assert.equal(conflict.status, 409);
    const deep = await request("/runs", { method: "POST", token: fullToken, idempotencyKey: "deep-review",
      body: { number: 42, workflow: "review.deep.v1" } });
    assert.equal(deep.status, 202);
    const saved = await adminPool.query("SELECT run_type,input_json,runtime_config_json FROM pr_agent_harness.agent_runs WHERE id=$1", [deep.value.id]);
    assert.equal(saved.rows[0].run_type, "review.deep.v1");
    assert.equal(saved.rows[0].runtime_config_json.deepBudget.version, 1);
    const lookupCount = providerLookups;
    providerOnline = false;
    const replay = await request("/runs", { method: "POST", token: fullToken, idempotencyKey: "deep-review",
      body: { number: 42, workflow: "review.deep.v1" } });
    providerOnline = true;
    assert.equal(replay.value.id, deep.value.id); assert.equal(providerLookups, lookupCount);
    const rawDenied = await request(`/runs/${deep.value.id}/artifact?raw=true`, { token: readOnlyToken });
    assert.equal(rawDenied.status, 403);
  });

  test("POST /runs rejects unknown request fields before provider lookup", async () => {
    const calls = providerLookups;
    const response = await request("/runs", { method: "POST", token: fullToken,
      idempotencyKey: "unknown-field", body: { number: 42, unexpected: true } });
    assert.equal(response.status, 422);
    assert.equal(errorCode(response.value), "INVALID_REQUEST");
    assert.equal(providerLookups, calls);
  });

  test("HTTP authentication distinguishes invalid credentials, missing permission, and cross-scope resources", async () => {
    const invalid = await request(`/runs/${cancelRunId}`, { token: "incorrect" });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get("www-authenticate"), "Bearer");
    assert.equal(errorCode(invalid.value), "UNAUTHORIZED");

    const forbidden = await request("/runs", { method: "POST", token: readOnlyToken,
      idempotencyKey: "forbidden", body: { number: 42 } });
    assert.equal(forbidden.status, 403);
    assert.equal(errorCode(forbidden.value), "FORBIDDEN");

    const hidden = await request(`/runs/${cancelRunId}`, { token: crossToken });
    assert.equal(hidden.status, 404);
    assert.equal(errorCode(hidden.value), "RUN_NOT_FOUND");
  });

  test("cancel command is receipt-idempotent, version-fenced, and visible through GET", async () => {
    const beforeCancel = await request(`/runs/${cancelRunId}`, { token: readerToken });
    assert.equal(beforeCancel.status, 200);
    const expectedVersion = Number(beforeCancel.value.version);
    const command = { expectedVersion, commandKey: "cancel-once" };
    const first = await request(`/runs/${cancelRunId}/commands/cancel`, { method: "POST", token: fullToken, body: command });
    assert.equal(first.status, 202);
    assert.equal(first.value.status, "completed");

    const replay = await request(`/runs/${cancelRunId}/commands/cancel`, { method: "POST", token: fullToken, body: command });
    assert.equal(replay.status, 202);
    assert.equal(replay.value.id, first.value.id);

    const stale = await request(`/runs/${cancelRunId}/commands/cancel`, { method: "POST", token: fullToken,
      body: { expectedVersion, commandKey: "stale-cancel" } });
    assert.equal(stale.status, 409);
    assert.equal(errorCode(stale.value), "RUN_CONFLICT");

    const snapshot = await request(`/runs/${cancelRunId}`, { token: readerToken });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.value.status, "cancelled");
    assert.equal(snapshot.value.cancelRequested, true);
  });

  test("GET /events returns durable public history with a resumable cursor", async () => {
    const response = await request(`/runs/${cursorRunId}/events?limit=1`, { token: readerToken });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.value.events));
    assert.equal((response.value.events as unknown[]).length, 1);
    assert.match(String(response.value.cursor), new RegExp(`^${cursorRunId}:\\d+$`));
  });

  test("expired SSE cursor returns 410 with a reload snapshot and resume cursor", async () => {
    await adminPool.query(
      "UPDATE pr_agent_harness.agent_runs SET event_retention_floor=2 WHERE tenant_id=$1 AND id=$2",
      [tenantId, cursorRunId],
    );
    const response = await request(`/runs/${cursorRunId}/events/stream?after=${cursorRunId}:0`, { token: readerToken });
    assert.equal(response.status, 410);
    assert.equal(errorCode(response.value), "CURSOR_EXPIRED");
    assert.equal((response.value.snapshot as Record<string, unknown>).id, cursorRunId);
    assert.match(String(response.value.resumeCursor), new RegExp(`^${cursorRunId}:\\d+$`));
  });

  test("trace responses expose bounded metadata without bearer or provider secrets", async () => {
    const response = await request(`/runs/${cancelRunId}/trace`, { token: fullToken });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.value.entries));
    const serialized = JSON.stringify(response.value);
    assert.doesNotMatch(serialized, new RegExp([fullToken, "github-provider-secret", "authorization", "rawHeaders"].join("|"), "i"));
  });

  test("creation idempotency survives content retention using the immutable request hash", async () => {
    const original = await adminPool.query<{ id: string }>(
      `UPDATE pr_agent_harness.agent_runs SET input_json='{}',content_purged_at=clock_timestamp()
       WHERE tenant_id=$1 AND create_key=$2 RETURNING id`,
      [tenantId, `api:${integrationId}:offline-replay`]);
    const before = providerLookups;
    providerOnline = false;
    try {
      const replay = await request("/runs", { method: "POST", token: fullToken,
        idempotencyKey: "offline-replay", body: { number: 42, mode: "report" } });
      assert.equal(replay.status, 202);
      assert.equal(replay.value.id, original.rows[0]!.id);
      assert.equal(replay.value.created, false);
      const conflict = await request("/runs", { method: "POST", token: fullToken,
        idempotencyKey: "offline-replay", body: { number: 43, mode: "report" } });
      assert.equal(conflict.status, 409);
      assert.equal(providerLookups, before);
    } finally { providerOnline = true; }
  });

  async function createFixtureRun(key: string): Promise<string> {
    const version = hash("api-fixture-version");
    return (await adminRuns.createRun({ tenantId, integrationId, actorType: "service", actorId: "api-fixture",
      createScope: "api-fixture", createKey: key, requestHash: hash(key), runType: "review.single.v1",
      baseSha: "fixture-base", headSha: "fixture-head", workflowVersionHash: version, promptVersionHash: version,
      modelVersionHash: version, toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: { fixture: key } })).id;
  }

  async function request(path: string, options: { method?: string; token: string; idempotencyKey?: string;
    body?: Record<string, unknown> }): Promise<{ status: number; headers: Headers; value: Record<string, unknown> }> {
    const response = await fetch(`${apiOrigin}${path}`, { method: options.method ?? "GET", headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, headers: response.headers, value: await response.json() as Record<string, unknown> };
  }
}

function principal(subjectId: string, token: string, tenantId: string, integrationId: string, permissions: string[]) {
  return { subjectId, actorType: "user", tokenSha256: hash(token), tenantId, integrationId, permissions };
}

function pricingFixture(): string {
  return JSON.stringify({
    version: "run-api-zero-price-v1", currency: "USD", periodKey: "run-api-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
    models: { "openai-compatible:fixture-model": { rates: {
      inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0, thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0,
    }, maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } },
  });
}

function errorCode(value: Record<string, unknown>): unknown {
  return (value.error as Record<string, unknown> | undefined)?.code;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
