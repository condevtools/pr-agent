import "reflect-metadata";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";

import { Module } from "@nestjs/common";
import { NestFactory, type INestApplication } from "@nestjs/core";
import { Pool, type PoolClient } from "pg";

import { BASELINE_REVIEW_TEXT, reviewTextHashes, withReviewTextVersions } from "../src/review/strategy/text-components.js";
import { evolutionReleasePolicy } from "../src/evolution/releases/policy.js";
import { evaluateOfflineReleaseGates, EvolutionReleaseGateError } from "../src/evolution/releases/gates.js";
import { PgEvolutionReleaseStore } from "../src/evolution/releases/store.js";
import { releaseBucket } from "../src/evolution/releases/selection.js";
import { EVALUATION_SCHEDULING_POLICY, EVALUATION_SCHEDULING_POLICY_HASH,
  REPLAY_VERIFIER_HASH } from "../src/evolution/evaluations/contracts.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore, type CreateRunInput } from "../src/agent-runtime/postgres/run-store.js";
import { buildReviewRunCreationInput } from "../src/review/intake/run-intake.js";
import { RunWorker } from "../src/agent-runtime/execution/run-worker.js";
import { RunExecutionStore } from "../src/agent-runtime/execution/store.js";
import { closeAgentRuntime, executeAgentRun } from "../src/agent-runtime/runtime.js";
import { RuntimeMaintenanceStore } from "../src/agent-runtime/maintenance.js";
import type { RunPrincipal } from "../src/agent-runtime/runs/control-contracts.js";
import { fingerprint, runtimeVersionManifest, type RunVersionManifest } from "../src/agent-runtime/versions.js";
import { getModelExecutionPolicy, ModelBudgetStore } from "../src/agent-runtime/budget/model-budget-store.js";
import { resolveModelConfiguration } from "../src/model/configuration.js";
import { AgentRuntimeModule } from "../src/http/runs/agent-runtime.module.js";
import { EvolutionModule } from "../src/http/evolution/evolution.module.js";

@Module({ imports: [AgentRuntimeModule, EvolutionModule] })
class EvolutionReleaseTestModule {}

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Evolution release PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("evolution release requires a disposable database");

  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const appPassword = randomUUID(); let appPool: Pool; let db: RuntimeDatabase;
  const tenantId = randomUUID(); const integrationId = randomUUID(); const otherTenantId = randomUUID();
  const otherIntegrationId = randomUUID();
  const datasetId = randomUUID(); const candidateId = randomUUID(); const proposalRunId = randomUUID();
  const validationEvaluationId = randomUUID(); const holdoutEvaluationId = randomUUID();
  const manifestHash = fingerprint("release-dataset");
  const candidateText = { schemaVersion: 1 as const, prompt_text: "P3C_RELEASE_CANDIDATE_PROMPT",
    tool_description_text: "P3C_RELEASE_CANDIDATE_TOOL" };
  const labelSet = { schemaVersion: 1, rubricVersion: "review-quality.v1", completeness: "complete",
    expectedFindings: [
      { path: "src/value.ts", startLine: 1, endLine: 1, severity: "high", title: "high" },
      { path: "src/value.ts", startLine: 2, endLine: 2, severity: "medium", title: "medium" },
      { path: "src/value.ts", startLine: 3, endLine: 3, severity: "low", title: "low" },
    ] } as const;
  const labelHash = fingerprint(labelSet); const artifactHash = fingerprint("release-artifact");
  let currentManifest: RunVersionManifest; let baselineManifest: RunVersionManifest; let candidateManifest: RunVersionManifest;
  let qualificationId = "";
  let server: Server; let origin = ""; const providerBodies: string[] = [];
  let app: INestApplication; let apiOrigin = ""; const apiToken = "release-api-token";
  const crossApiToken = "release-cross-api-token";
  let candidateCreation: CreateRunInput | undefined; let selectedRunId = "";
  let baselineRunId = "";
  let promoteRequestId = "";

  const principal = (subjectId: string, permissions: RunPrincipal["permissions"], tenant = tenantId,
    integration = integrationId): RunPrincipal => ({ subjectId, actorType: "user", tenantId: tenant,
    integrationId: integration, permissions });
  const qualifier = () => principal("qualifier", ["evolution:release:qualify", "evolution:release:read"]);
  const maker = () => principal("maker", ["evolution:release:request", "evolution:release:revoke", "evolution:release:read"]);
  const checker = () => principal("checker", ["evolution:release:approve", "evolution:release:read"]);

  before(async () => {
    server = createServer(async (request, response) => {
      const path = request.url ?? ""; let body = ""; for await (const chunk of request) body += chunk;
      if (request.method === "POST" && path === "/v1/chat/completions") {
        providerBodies.push(body);
        const parsed = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } };
        const content = parsed.response_format?.json_schema?.name === "deep_review_critic"
          ? { decisions: [] } : { action: "finish", candidates: [] };
        return sendJson(response, 200, { id: randomUUID(), object: "chat.completion", created: 1, model: "p3c-provider-v1",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
      }
      if (request.method === "GET" && path === "/repos/acme/release/pulls/42") return sendJson(response, 200,
        { id: 42, number: 42, title: "Release", body: "", user: { login: "fixture" },
          base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) },
          additions: 1, deletions: 0, changed_files: 1, draft: false, html_url: `${origin}/acme/release/pull/42` });
      if (request.method === "GET" && path.includes("/compare/")) return sendJson(response, 200,
        { files: [{ filename: "src/value.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+new" }] });
      if (request.method === "GET" && path.includes("/check-runs")) return sendJson(response, 200, { check_runs: [] });
      return sendJson(response, 404, { message: "fixture route missing" });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("release fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED = "true";
    process.env.HARNESS_DATABASE_URL = databaseUrl;
    process.env.AI_PROVIDER = "openai-compatible"; process.env.AI_MODEL = "p3c-model";
    process.env.OPENAI_BASE_URL = `${origin}/v1`; process.env.OPENAI_COMPATIBLE_API_KEY = "local-key";
    process.env.GITHUB_API_URL = origin; process.env.GITHUB_TOKEN = "local-read-token";
    process.env.HARNESS_MODEL_PRICING_JSON = pricing();
    await migrateRuntime(pool);
    const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app'");
    const ddl = await pool.query<{ sql: string }>(role.rowCount
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) sql",
    [appPassword]);
    await pool.query(ddl.rows[0]!.sql);
    const configured = spawnSync(process.execPath, ["--import", "tsx", "src/agent-runtime/cli.ts", "migrate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HARNESS_DATABASE_URL: databaseUrl },
    });
    if (configured.status !== 0) throw new Error(`P3c runtime grants failed: ${configured.stderr}`);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    appPool = new Pool({ connectionString: appUrl.toString(), max: 12 }); db = new RuntimeDatabase(appPool);
    currentManifest = await runtimeVersionManifest(getModelExecutionPolicy(
      resolveModelConfiguration().provider, resolveModelConfiguration().model));
    baselineManifest = withReviewTextVersions(currentManifest, BASELINE_REVIEW_TEXT);
    candidateManifest = withReviewTextVersions(currentManifest, candidateText);
    await seedReleaseEvidence();
    process.env.HARNESS_API_PRINCIPALS_JSON = JSON.stringify([{ subjectId: "release-api", actorType: "user",
      tenantId, integrationId, tokenSha256: createHash("sha256").update(apiToken).digest("hex"), permissions: ["runs:read", "runs:trace", "evolution:release:qualify",
        "evolution:release:request", "evolution:release:approve", "evolution:release:revoke",
        "evolution:release:rollback", "evolution:release:read"] },
    { subjectId: "release-cross-api", actorType: "user", tenantId, integrationId: otherIntegrationId,
      tokenSha256: createHash("sha256").update(crossApiToken).digest("hex"), permissions: ["runs:read", "runs:trace"] }]);
    app = await NestFactory.create(EvolutionReleaseTestModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    const apiAddress = app.getHttpServer().address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("release API fixture did not bind");
    apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
  });

  after(async () => { await app?.close(); await closeAgentRuntime(); await appPool?.end(); await pool.end();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

  test("offline qualification accepts the exact 300-case and 30-repository engineering fixture", async () => {
    const store = new PgEvolutionReleaseStore(db);
    const qualification = await store.qualify(qualifier(), qualificationInput("qualify-good"), currentManifest);
    qualificationId = qualification.id;
    assert.equal(qualification.evidence.cases, 300); assert.equal(qualification.evidence.repositories, 30);
    assert.deepEqual(qualification.evidence.severityCases, { high: 300, medium: 300, low: 300 });
    assert.deepEqual(qualification.evidence.languageCases, { typescript: 300, javascript: 300 });
    assert.equal(qualification.evidence.policyHash, fingerprint(evolutionReleasePolicy()));
  });

  test("offline qualification rejects 299 declared cases", async () => {
    await expectGateFailure("RELEASE_DATASET_GATE_FAILED", async (client) => {
      await client.query(`UPDATE pr_agent_harness.eval_datasets SET case_count=299,validation_count=149
        WHERE tenant_id=$1 AND id=$2`, [tenantId, datasetId]);
    });
  });

  test("offline qualification rejects 29 distinct repositories", async () => {
    await expectGateFailure("RELEASE_DATASET_GATE_FAILED", async (client) => {
      await client.query(`UPDATE pr_agent_harness.eval_cases SET repository='repo-13'
        WHERE tenant_id=$1 AND dataset_id=$2 AND repository='repo-14'`, [tenantId, datasetId]);
    });
  });

  test("offline qualification rejects a missing JavaScript coverage bucket", async () => {
    await expectGateFailure("RELEASE_DATASET_GATE_FAILED", async (client) => {
      await client.query(`DELETE FROM pr_agent_harness.eval_fixture_files f USING pr_agent_harness.eval_cases c
        WHERE c.tenant_id=$1 AND c.dataset_id=$2 AND c.fixture_id=f.fixture_id AND f.tenant_id=c.tenant_id
          AND f.path='src/value.js' AND c.ordinal>=29`, [tenantId, datasetId]);
    });
  });

  test("offline qualification rejects 2.999 percent quality improvement", async () => {
    await expectGateFailure("RELEASE_METRIC_GATE_FAILED", async (client) => {
      await setCandidateQuality(client, validationEvaluationId, 1.02999);
    });
  });

  test("offline qualification rejects cost ratio 1.20001", async () => {
    await expectGateFailure("RELEASE_METRIC_GATE_FAILED", async (client) => {
      await setCandidateCost(client, validationEvaluationId, 120.001);
    });
  });

  test("offline qualification rejects a critical false negative", async () => {
    await expectGateFailure("RELEASE_METRIC_GATE_FAILED", async (client) => {
      const metrics = await evaluationMetrics(client, validationEvaluationId);
      metrics.candidate.highFalseNegatives = 1;
      await replaceMetrics(client, validationEvaluationId, metrics);
    });
  });

  test("offline qualification rejects wrong split, metrics hash, runtime pin, model pin, and provider versions", async () => {
    const tamperCases: Array<(client: PoolClient) => Promise<void>> = [
      async (client) => { await client.query("UPDATE pr_agent_harness.eval_runs SET split='development' WHERE id=$1",
        [validationEvaluationId]); },
      async (client) => { await client.query("UPDATE pr_agent_harness.eval_runs SET metrics_hash=$2 WHERE id=$1",
        [validationEvaluationId, fingerprint("wrong-metrics")]); },
      async (client) => { await client.query("UPDATE pr_agent_harness.eval_results SET expected_runtime_hash=$2 WHERE eval_run_id=$1",
        [validationEvaluationId, fingerprint("wrong-runtime")]); },
      async (client) => { await client.query("UPDATE pr_agent_harness.eval_results SET expected_model_hash=$2 WHERE eval_run_id=$1",
        [validationEvaluationId, fingerprint("wrong-model")]); },
      async (client) => { const metrics = await evaluationMetrics(client, holdoutEvaluationId);
        metrics.providerModelVersions = ["different-provider-version"];
        await replaceMetrics(client, holdoutEvaluationId, metrics); },
    ];
    for (const tamper of tamperCases) await expectAnyGateFailure(tamper);
  });

  test("release activation remains disabled by default even with qualified evidence", async () => {
    const previous = process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED;
    delete process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED;
    try {
      await assert.rejects(new PgEvolutionReleaseStore(db).qualify(qualifier(), qualificationInput("disabled"), currentManifest),
        (error: unknown) => hasCode(error, "EVOLUTION_RELEASE_DISABLED"));
    } finally { process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED = previous; }
  });

  test("release HTTP API rejects caller scope and disabled qualification through real authentication", async () => {
    const qualificationBody = { candidateId, datasetId, validationEvaluationId, holdoutEvaluationId };
    const scoped = await apiRequest("/evolution/releases/qualify", "scope-rejected", {
      ...qualificationBody, tenantId });
    assert.equal(scoped.status, 422);
    const previous = process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED;
    try {
      process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED = "false";
      const disabled = await apiRequest("/evolution/releases/qualify", "disabled-http", qualificationBody);
      assert.equal(disabled.status, 409);
    } finally { process.env.EVOLUTION_RELEASE_ACTIVATION_ENABLED = previous; }
  });

  test("maker-checker request is idempotent and the maker cannot approve it", async () => {
    assert.ok(qualificationId, "qualification test must run first");
    const store = new PgEvolutionReleaseStore(db);
    const input = { target: "shadow" as const, candidateId, qualificationId, expectedVersion: 0, commandKey: "shadow-1" };
    const request = await store.request(maker(), input, currentManifest);
    assert.equal((await store.request(maker(), input, currentManifest)).id, request.id);
    await assert.rejects(store.approve({ ...maker(), permissions: ["evolution:release:approve"] },
      { requestId: request.id, decision: "approve", commandKey: "maker-approve" }, currentManifest),
    (error: unknown) => hasCode(error, "MAKER_CHECKER_REQUIRED"));
    const assignment = await store.approve(checker(),
      { requestId: request.id, decision: "approve", commandKey: "checker-approve" }, currentManifest);
    assert.deepEqual({ state: assignment.state, routing: assignment.routing, version: assignment.version },
      { state: "evaluated_experimental", routing: "shadow", version: 1 });
  });

  test("authenticated release HTTP read returns the durable assignment", async () => {
    const response = await fetch(`${apiOrigin}/evolution/releases`, {
      headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { state: string; routing: string; version: number };
    assert.deepEqual({ state: body.state, routing: body.routing, version: body.version },
      { state: "evaluated_experimental", routing: "shadow", version: 1 });
  });

  test("revoked and expired requests cannot be consumed", async () => {
    const store = new PgEvolutionReleaseStore(db);
    const revoked = await store.request(maker(), { target: "canary", candidateId, qualificationId,
      expectedVersion: 1, candidateBps: 500, commandKey: "canary-revoke" }, currentManifest);
    assert.equal((await store.revoke(maker(), revoked.id, "revoke-1")).status, "revoked");
    await assert.rejects(store.approve(checker(),
      { requestId: revoked.id, decision: "approve", commandKey: "approve-revoked" }, currentManifest),
      (error: unknown) => hasCode(error, "RELEASE_REQUEST_EXPIRED"));
    const expired = await store.request(maker(), { target: "canary", candidateId, qualificationId,
      expectedVersion: 1, candidateBps: 500, commandKey: "canary-expired" }, currentManifest);
    await tamper(async (client) => client.query(
      "UPDATE pr_agent_harness.evolution_release_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]));
    await assert.rejects(store.approve(checker(),
      { requestId: expired.id, decision: "approve", commandKey: "approve-expired" }, currentManifest),
      (error: unknown) => hasCode(error, "RELEASE_REQUEST_EXPIRED"));
  });

  test("canary approval enforces the 24 hour promotion window", async () => {
    const store = new PgEvolutionReleaseStore(db);
    const request = await store.request(maker(), { target: "canary", candidateId, qualificationId,
      expectedVersion: 1, candidateBps: 500, commandKey: "canary-live" }, currentManifest);
    const canary = await store.approve(checker(),
      { requestId: request.id, decision: "approve", commandKey: "approve-canary" }, currentManifest);
    assert.deepEqual({ state: canary.state, routing: canary.routing, version: canary.version, bps: canary.candidateBps },
      { state: "approved_canary", routing: "canary", version: 2, bps: 500 });
    const promote = await store.request(maker(), { target: "promote", candidateId, qualificationId,
      expectedVersion: 2, commandKey: "promote-too-early" }, currentManifest);
    promoteRequestId = promote.id;
    await assert.rejects(store.approve(checker(), { requestId: promote.id, decision: "approve",
      commandKey: "approve-too-early" }, currentManifest),
    (error: unknown) => hasCode(error, "CANARY_WINDOW_INCOMPLETE"));
  });

  test("new deep Run freezes candidate text and component hashes before a later rollback", async () => {
    const assignment = (await pool.query<{ version: string; salt: string; fraction_bps: number }>(
      "SELECT version,salt,fraction_bps FROM pr_agent_harness.evolution_release_assignments WHERE tenant_id=$1 AND integration_id=$2",
      [tenantId, integrationId])).rows[0]!;
    let sourceKey = "";
    for (let ordinal = 0; ordinal < 100_000; ordinal += 1) {
      const candidate = `candidate-route-${ordinal}`;
      if (releaseBucket({ tenantId, integrationId, sourceKey: candidate, headSha: "b".repeat(40),
        assignmentVersion: Number(assignment.version), routingSalt: assignment.salt }) < assignment.fraction_bps) {
        sourceKey = candidate; break;
      }
    }
    assert.ok(sourceKey);
    const binding = await releaseBinding();
    candidateCreation = await buildReviewRunCreationInput(binding, reviewInput(sourceKey));
    const created = await new RunStore(db).createRun(candidateCreation);
    selectedRunId = created.id;
    const selected = (await pool.query<{ selection: string; assignment_version: string; review_text_json: unknown;
      prompt_hash: string; tool_hash: string }>(
      `SELECT selection,assignment_version,review_text_json,prompt_hash,tool_hash
       FROM pr_agent_harness.evolution_run_assignments WHERE tenant_id=$1 AND run_id=$2`, [tenantId, selectedRunId])).rows[0]!;
    assert.equal(selected.selection, "candidate"); assert.equal(Number(selected.assignment_version), 2);
    assert.deepEqual(selected.review_text_json, candidateText);
    assert.deepEqual({ prompt: selected.prompt_hash, tool: selected.tool_hash },
      { prompt: reviewTextHashes(candidateText).promptHash, tool: reviewTextHashes(candidateText).toolHash });
    const run = (await pool.query<{ runtime_config_json: { reviewText: unknown }; runtime_version_hash: string;
      workflow_version_hash: string; model_version_hash: string; policy_version_hash: string }>(
      "SELECT runtime_config_json,runtime_version_hash,workflow_version_hash,model_version_hash,policy_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
      [tenantId, selectedRunId])).rows[0]!;
    assert.deepEqual(run.runtime_config_json.reviewText, candidateText);
    assert.deepEqual({ runtime: run.runtime_version_hash, workflow: run.workflow_version_hash,
      model: run.model_version_hash, policy: run.policy_version_hash },
    { runtime: currentManifest.runtimeVersionHash, workflow: currentManifest.workflowVersionHash,
      model: currentManifest.modelVersionHash, policy: currentManifest.policyVersionHash });
  });

  test("candidate release selection is visible as hash-only trace metadata within its integration", async () => {
    const selection = await releaseTrace(selectedRunId, apiToken);
    assert.deepEqual({ assignmentVersion: selection.assignmentVersion, routing: selection.routing,
      selection: selection.selection, candidateId: selection.candidateId, qualificationId: selection.qualificationId,
      reviewTextHash: selection.reviewTextHash, promptHash: selection.promptHash, toolHash: selection.toolHash },
    { assignmentVersion: 2, routing: "canary", selection: "candidate", candidateId, qualificationId,
      reviewTextHash: reviewTextHashes(candidateText).contentHash, promptHash: reviewTextHashes(candidateText).promptHash,
      toolHash: reviewTextHashes(candidateText).toolHash });
    assert.equal(typeof selection.releaseReceiptId, "string");
    assert.match(String(selection.selectionHash), /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(selection), /prompt_text|tool_description_text|P3C_RELEASE_CANDIDATE/);
    assert.equal((await fetch(`${apiOrigin}/runs/${selectedRunId}/trace`, {
      headers: { authorization: `Bearer ${crossApiToken}` }, signal: AbortSignal.timeout(5_000) })).status, 404);
  });

  test("aged canary rejects 99 observations per arm", async () => {
    assert.ok(promoteRequestId);
    await tamper(async (client) => client.query(`UPDATE pr_agent_harness.evolution_release_assignments
      SET activated_at=clock_timestamp()-interval '24 hours 1 second' WHERE tenant_id=$1 AND integration_id=$2`,
    [tenantId, integrationId]));
    await seedCanaryObservations(2, 99, 0);
    const store = new PgEvolutionReleaseStore(db);
    await assert.rejects(store.approve(checker(), { requestId: promoteRequestId, decision: "approve",
      commandKey: "approve-promote" }, currentManifest), (error: unknown) => hasCode(error, "CANARY_GATE_FAILED"));
  });

  test("control release selection trace freezes the product baseline hashes", async () => {
    const controlRunId = (await pool.query<{ run_id: string }>(`SELECT run_id FROM pr_agent_harness.evolution_run_assignments
      WHERE tenant_id=$1 AND integration_id=$2 AND assignment_version=2 AND selection='control' ORDER BY run_id LIMIT 1`,
    [tenantId, integrationId])).rows[0]!.run_id;
    const selection = await releaseTrace(controlRunId, apiToken);
    assert.deepEqual({ assignmentVersion: selection.assignmentVersion, routing: selection.routing,
      selection: selection.selection, reviewTextHash: selection.reviewTextHash,
      promptHash: selection.promptHash, toolHash: selection.toolHash },
    { assignmentVersion: 2, routing: "canary", selection: "control",
      reviewTextHash: reviewTextHashes(BASELINE_REVIEW_TEXT).contentHash,
      promptHash: reviewTextHashes(BASELINE_REVIEW_TEXT).promptHash,
      toolHash: reviewTextHashes(BASELINE_REVIEW_TEXT).toolHash });
  });

  test("pending canary work blocks promotion after both arms reach 100 observations", async () => {
    await seedCanaryObservations(2, 1, 99);
    assert.ok(selectedRunId);
    const store = new PgEvolutionReleaseStore(db);
    await assert.rejects(store.approve(checker(), { requestId: promoteRequestId, decision: "approve",
      commandKey: "approve-promote" }, currentManifest), (error: unknown) => hasCode(error, "CANARY_GATE_FAILED"));
    const errors: unknown[] = [];
    const worker = new RunWorker({ store: new RunExecutionStore(db), budget: new ModelBudgetStore(db),
      bindings: async () => [await releaseBinding()], runtimeHash: async () => currentManifest.runtimeVersionHash,
      execute: executeAgentRun, onError: (error) => errors.push(error) }, 1);
    await worker.tick(); await worker.drain();
    assert.equal(errors.length, 0, errors.map(String).join("\n"));
    assert.equal((await new RunExecutionStore(db).load(tenantId, selectedRunId))?.status, "succeeded");
    const promoted = await store.approve(checker(), { requestId: promoteRequestId, decision: "approve",
      commandKey: "approve-promote" }, currentManifest);
    assert.deepEqual({ state: promoted.state, routing: promoted.routing, version: promoted.version },
      { state: "promoted", routing: "full", version: 3 });
    assert.equal((await pool.query(`SELECT 1 FROM pr_agent_harness.evolution_release_receipts
      WHERE tenant_id=$1 AND integration_id=$2 AND kind='promote' AND assignment_version=3`,
    [tenantId, integrationId])).rowCount, 1);
  });

  test("late canary observations do not mutate the immutable promotion receipt", async () => {
    const before = (await pool.query<{ evidence_json: unknown; evidence_hash: string }>(`SELECT evidence_json,evidence_hash
      FROM pr_agent_harness.evolution_release_receipts WHERE tenant_id=$1 AND integration_id=$2 AND kind='promote'`,
    [tenantId, integrationId])).rows[0]!;
    await seedCanaryObservations(2, 1, 100);
    const after = (await pool.query<{ evidence_json: unknown; evidence_hash: string }>(`SELECT evidence_json,evidence_hash
      FROM pr_agent_harness.evolution_release_receipts WHERE tenant_id=$1 AND integration_id=$2 AND kind='promote'`,
    [tenantId, integrationId])).rows[0]!;
    assert.deepEqual(after, before);
  });

  test("concurrent rollback uses assignment CAS and preserves one immutable receipt", async () => {
    const store = new PgEvolutionReleaseStore(db);
    const attempts = await Promise.allSettled([
      store.rollback(principal("rollback-a", ["evolution:release:rollback"]),
        { expectedVersion: 3, reason: "engineering rollback race A", commandKey: "rollback-a" }),
      store.rollback(principal("rollback-b", ["evolution:release:rollback"]),
        { expectedVersion: 3, reason: "engineering rollback race B", commandKey: "rollback-b" }),
    ]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
    const assignment = await store.read(principal("reader", ["evolution:release:read"]));
    assert.deepEqual({ state: assignment.state, routing: assignment.routing, version: assignment.version },
      { state: "rolled_back", routing: "off", version: 4 });
    const receipts = await pool.query(
      `SELECT 1 FROM pr_agent_harness.evolution_release_receipts
       WHERE tenant_id=$1 AND integration_id=$2 AND kind='rollback' AND assignment_version=4`, [tenantId, integrationId]);
    assert.equal(receipts.rowCount, 1);
  });

  test("rollback affects only new Runs while duplicate delivery preserves the frozen candidate selection", async () => {
    assert.ok(candidateCreation && selectedRunId);
    const runs = new RunStore(db);
    const duplicate = await runs.createRun(candidateCreation);
    assert.equal(duplicate.id, selectedRunId); assert.equal(duplicate.created, false);
    const baselineCreation = await buildReviewRunCreationInput(await releaseBinding(), reviewInput("after-rollback"));
    const baseline = await runs.createRun(baselineCreation);
    baselineRunId = baseline.id;
    const assignments = await pool.query<{ run_id: string; selection: string; assignment_version: string }>(
      `SELECT run_id,selection,assignment_version FROM pr_agent_harness.evolution_run_assignments
       WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY run_id`, [tenantId, [selectedRunId, baseline.id]]);
    assert.deepEqual(new Map(assignments.rows.map((row) => [row.run_id, [row.selection, Number(row.assignment_version)]])),
      new Map([[selectedRunId, ["candidate", 2]], [baseline.id, ["baseline", 4]]]));

    const errors: unknown[] = [];
    const execution = new RunExecutionStore(db); const budget = new ModelBudgetStore(db);
    const worker = new RunWorker({ store: execution, budget, bindings: async () => [await releaseBinding()],
      runtimeHash: async () => currentManifest.runtimeVersionHash, execute: executeAgentRun,
      onError: (error) => errors.push(error) }, 1);
    for (let count = 0; count < 2; count += 1) { await worker.tick(); await worker.drain(); }
    assert.equal(errors.length, 0, errors.map(String).join("\n"));
    assert.equal((await execution.load(tenantId, selectedRunId))?.status, "succeeded");
    assert.equal((await execution.load(tenantId, baseline.id))?.status, "succeeded");
    const candidateRequests = providerBodies.filter((body) => body.includes(candidateText.prompt_text));
    const baselineRequests = providerBodies.filter((body) => body.includes(BASELINE_REVIEW_TEXT.prompt_text));
    assert.ok(candidateRequests.length > 0); assert.ok(baselineRequests.length > 0);
    assert.ok(candidateRequests.every((body) => body.includes(candidateText.tool_description_text)));
  });

  test("post-rollback baseline selection is visible in hash-only trace metadata", async () => {
    const selection = await releaseTrace(baselineRunId, apiToken);
    assert.deepEqual({ assignmentVersion: selection.assignmentVersion, routing: selection.routing,
      selection: selection.selection, reviewTextHash: selection.reviewTextHash },
    { assignmentVersion: 4, routing: "off", selection: "baseline",
      reviewTextHash: reviewTextHashes(BASELINE_REVIEW_TEXT).contentHash });
    assert.equal(selection.candidateId, null);
    assert.equal(selection.qualificationId, null);
    assert.equal(selection.releaseReceiptId, null);
  });

  test("release qualifications prevent candidate retention purge", async () => {
    await assert.rejects(pool.query(`UPDATE pr_agent_harness.evolution_candidates
      SET candidate_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`, [tenantId, candidateId]));
  });

  test("retention excludes qualified sources and nonbaseline release selections", async () => {
    assert.ok(selectedRunId && baselineRunId);
    const sourceRunId = (await pool.query<{ source_run_id: string }>(`SELECT source_run_id
      FROM pr_agent_harness.eval_cases WHERE tenant_id=$1 AND dataset_id=$2 ORDER BY ordinal LIMIT 1`,
    [tenantId, datasetId])).rows[0]!.source_run_id;
    await tamper((client) => client.query(`UPDATE pr_agent_harness.agent_runs
      SET finished_at=clock_timestamp()-interval '40 days'
      WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
    [tenantId, [sourceRunId, proposalRunId, selectedRunId, baselineRunId]]));
    const preview = await new RuntimeMaintenanceStore(pool).preview({ tenantId, olderThanDays: 30, limit: 1000 });
    const candidates = new Set(preview.candidates.map(({ runId }) => runId));
    assert.ok(candidates.has(baselineRunId), "an unprotected baseline Run proves the preview scanned this cutoff");
    assert.ok(!candidates.has(sourceRunId));
    assert.ok(!candidates.has(proposalRunId));
    assert.ok(!candidates.has(selectedRunId));
  });

  test("FORCE RLS and store scope hide another tenant and integration", async () => {
    const tables = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='pr_agent_harness'::regnamespace
       AND relname=ANY($1::text[])`, [["evolution_release_qualifications", "evolution_release_assignments",
        "evolution_release_requests", "evolution_release_decisions", "evolution_release_receipts", "evolution_run_assignments"]]);
    assert.equal(tables.rowCount, 6); assert.ok(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    const hidden = await db.transaction(otherTenantId, (client) => client.query(
      `SELECT id FROM pr_agent_harness.evolution_release_qualifications WHERE tenant_id=$1`, [tenantId]));
    assert.equal(hidden.rowCount, 0);
    await assert.rejects(new PgEvolutionReleaseStore(db).read(principal("wrong", ["evolution:release:read"],
      otherTenantId, randomUUID())), (error: unknown) => hasCode(error, "RELEASE_ASSIGNMENT_NOT_FOUND") || error instanceof Error);
  });

  test("application-role writes cannot attach a qualification to another integration", async () => {
    await assert.rejects(db.transaction(tenantId, (client) => client.query(`INSERT INTO
      pr_agent_harness.evolution_release_requests
      (id,tenant_id,integration_id,target,candidate_id,qualification_id,expected_assignment_version,candidate_bps,
       maker_actor_type,maker_actor_id,command_key,request_hash,expires_at)
      VALUES ($1,$2,$3,'shadow',$4,$5,0,10000,'user','cross-scope','cross-scope',$6,clock_timestamp()+interval '1 hour')`,
    [randomUUID(), tenantId, otherIntegrationId, candidateId, qualificationId, fingerprint("cross-scope")])),
    (error: unknown) => error instanceof Error);
  });

  function qualificationInput(commandKey: string) {
    return { candidateId, datasetId, validationEvaluationId, holdoutEvaluationId, commandKey };
  }

  async function releaseBinding() {
    return { id: integrationId, tenantId, platform: "github" as const, origin, repository: "acme/release",
      providerRepositoryId: 700, providerActorId: 7, credentialRef: "env:GITHUB_TOKEN",
      generation: 1, version: 0, state: "active" as const, reviewExecutionMode: "harness_async" as const,
      executionModeGeneration: 1, reviewExecutionState: "active" as const };
  }

  function reviewInput(sourceKey: string) {
    return { schemaVersion: 1 as const, workflow: "review.deep.v1" as const, platform: "github" as const,
      target: { origin, repository: "acme/release", number: 42, providerRepositoryId: 700 },
      source: { key: sourceKey, hash: fingerprint(sourceKey) },
      revision: { baseSha: "a".repeat(40), headSha: "b".repeat(40) }, mode: "report" as const,
      trigger: "comment-command" as const, options: { customRules: [], includeCiChecks: true,
        enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Release", body: "", author: "fixture", baseBranch: "main", headBranch: "feature",
        webUrl: `${origin}/acme/release/pull/42`, draft: false } };
  }

  async function expectGateFailure(code: string, mutation: (client: PoolClient) => Promise<void>): Promise<void> {
    await withTamperedEvidence(async (client) => {
      await mutation(client);
      await assert.rejects(evaluateOfflineReleaseGates(client, gateInput()),
        (error: unknown) => error instanceof EvolutionReleaseGateError && error.code === code);
    });
  }

  async function expectAnyGateFailure(mutation: (client: PoolClient) => Promise<void>): Promise<void> {
    await withTamperedEvidence(async (client) => {
      await mutation(client);
      await assert.rejects(evaluateOfflineReleaseGates(client, gateInput()), EvolutionReleaseGateError);
    });
  }

  function gateInput() { return { tenantId, integrationId, candidateId, datasetId, validationEvaluationId,
    holdoutEvaluationId, policy: evolutionReleasePolicy(), currentManifest }; }

  async function withTamperedEvidence(action: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL session_replication_role=replica");
      await action(client); await client.query("ROLLBACK");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async function tamper(action: (client: PoolClient) => Promise<unknown>): Promise<void> {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query("SET LOCAL session_replication_role=replica");
      await action(client); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async function evaluationMetrics(client: PoolClient, id: string): Promise<any> {
    return structuredClone((await client.query<{ metrics_json: any }>(
      "SELECT metrics_json FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0]!.metrics_json);
  }
  async function replaceMetrics(client: PoolClient, id: string, metrics: unknown): Promise<void> {
    await client.query("UPDATE pr_agent_harness.eval_runs SET metrics_json=$3::jsonb,metrics_hash=$4 WHERE tenant_id=$1 AND id=$2",
      [tenantId, id, JSON.stringify(metrics), fingerprint(metrics)]);
  }
  async function setCandidateQuality(client: PoolClient, id: string, quality: number) {
    const metrics = await evaluationMetrics(client, id); metrics.candidate.meanSeverityWeightedF1 = quality;
    await replaceMetrics(client, id, metrics);
  }
  async function setCandidateCost(client: PoolClient, id: string, cost: number) {
    const metrics = await evaluationMetrics(client, id); metrics.candidate.p50CostMicros = cost;
    await replaceMetrics(client, id, metrics);
  }

  async function seedReleaseEvidence(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await seedBinding(client); await seedDatasetCases(client); await seedCandidate(client);
      await seedEvaluation(client, validationEvaluationId, "validation");
      await seedEvaluation(client, holdoutEvaluationId, "holdout");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async function seedCanaryObservations(assignmentVersion: number, perArm: number, offset: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const receiptId = (await client.query<{ id: string }>(`SELECT id FROM pr_agent_harness.evolution_release_receipts
        WHERE tenant_id=$1 AND integration_id=$2 AND assignment_version=$3`,
      [tenantId, integrationId, assignmentVersion])).rows[0]!.id;
      const pricingHash = (await client.query<{ pricing_hash: string }>(`SELECT pricing_hash
        FROM pr_agent_harness.model_pricing_snapshots WHERE tenant_id=$1 ORDER BY created_at LIMIT 1`, [tenantId])).rows[0]!.pricing_hash;
      const rows = (["control", "candidate"] as const).flatMap((selection) => Array.from({ length: perArm }, (_, index) => ({
        run_id: randomUUID(), step_id: randomUUID(), attempt_id: randomUUID(), call_id: randomUUID(),
        selection, ordinal: offset + index,
      })));
      await client.query(`INSERT INTO pr_agent_harness.agent_runs
        (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
         run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
         policy_version_hash,runtime_version_hash,input_json,status,created_at,finished_at,authority_generation,execution_mode_generation)
        SELECT x.run_id,$1,$2,'system','canary-fixture','canary-observation',x.run_id::text,
         encode(digest(x.run_id::text,'sha256'),'hex'),'review.deep.v1',$3,$4,$5,$6,$7,$8,$9,$10,
         '{}'::jsonb,'succeeded',transaction_timestamp()-interval '2 seconds',transaction_timestamp(),1,1
        FROM jsonb_to_recordset($11::jsonb) x(run_id uuid)`,
      [tenantId, integrationId, "a".repeat(40), "b".repeat(40), currentManifest.workflowVersionHash,
        currentManifest.promptVersionHash, currentManifest.modelVersionHash, currentManifest.toolVersionHash,
        currentManifest.policyVersionHash, currentManifest.runtimeVersionHash, JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.run_events
        (tenant_id,run_id,sequence,event_type,actor_type,actor_id,payload_json,created_at)
        SELECT $1,x.run_id,1,'run.claimed','worker','canary-fixture','{}'::jsonb,transaction_timestamp()-interval '1 second'
        FROM jsonb_to_recordset($2::jsonb) x(run_id uuid)`, [tenantId, JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.agent_steps
        (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
        SELECT x.step_id,$1,x.run_id,'canary.model','model',$2,'succeeded',$2,'{"value":{}}'::jsonb,1,1,clock_timestamp()
        FROM jsonb_to_recordset($3::jsonb) x(step_id uuid,run_id uuid)`,
      [tenantId, fingerprint({}), JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.step_attempts
        (id,tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
        SELECT x.attempt_id,$1,x.run_id,x.step_id,1,'canary-fixture',1,'succeeded',clock_timestamp()
        FROM jsonb_to_recordset($2::jsonb) x(attempt_id uuid,run_id uuid,step_id uuid)`, [tenantId, JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.model_calls
        (id,tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,provider,model,request_kind,request_hash,
         input_token_bound,output_token_bound,provider_request_id,provider_model_version,response_json,response_hash,
         status,lease_epoch,sent_at,finished_at)
        SELECT x.call_id,$1,x.run_id,x.step_id,x.attempt_id,1,'openai-compatible','p3c-model','canary',$2,
         10,10,x.call_id::text,'p3c-provider-v1','{}'::jsonb,$2,'succeeded',1,clock_timestamp(),clock_timestamp()
        FROM jsonb_to_recordset($3::jsonb) x(call_id uuid,run_id uuid,step_id uuid,attempt_id uuid)`,
      [tenantId, fingerprint({}), JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.usage_records
        (tenant_id,run_id,model_call_id,measurement_status,input_tokens,output_tokens,total_tokens,cost_micros,
         currency,pricing_hash,original_usage_json)
        SELECT $1,x.run_id,x.call_id,'actual',10,10,20,100,'USD',$2,'{}'::jsonb
        FROM jsonb_to_recordset($3::jsonb) x(run_id uuid,call_id uuid)`, [tenantId, pricingHash, JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.review_artifacts
        (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
        SELECT encode(digest('artifact-'||x.run_id::text,'sha256'),'hex'),$1,$2,x.run_id,'review.deep.v1','shadow',$3,$4,
          '{"schemaVersion":1,"analysisStatus":"complete","summary":"canary","findings":[],"sourceCoverage":{"status":"complete","reasonCodes":[]}}'::jsonb
        FROM jsonb_to_recordset($5::jsonb) x(run_id uuid)`,
      [tenantId, integrationId, "b".repeat(40), artifactHash, JSON.stringify(rows)]);
      await client.query(`INSERT INTO pr_agent_harness.evolution_run_assignments
        (tenant_id,integration_id,run_id,assignment_version,selection,routing,bucket,candidate_id,qualification_id,
         release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
        SELECT $1,$2,x.run_id,$3,x.selection,'canary',CASE WHEN x.selection='candidate' THEN 1 ELSE 9999 END,
          $4,$5,$6,CASE WHEN x.selection='candidate' THEN $7::jsonb ELSE $8::jsonb END,
          CASE WHEN x.selection='candidate' THEN $9 ELSE $10 END,
          CASE WHEN x.selection='candidate' THEN $11 ELSE $12 END,
          CASE WHEN x.selection='candidate' THEN $13 ELSE $14 END,
          encode(digest(x.run_id::text||x.selection,'sha256'),'hex')
        FROM jsonb_to_recordset($15::jsonb) x(run_id uuid,selection text)`,
      [tenantId, integrationId, assignmentVersion, candidateId, qualificationId, receiptId,
        JSON.stringify(candidateText), JSON.stringify(BASELINE_REVIEW_TEXT), reviewTextHashes(candidateText).contentHash,
        reviewTextHashes(BASELINE_REVIEW_TEXT).contentHash, reviewTextHashes(candidateText).promptHash,
        reviewTextHashes(BASELINE_REVIEW_TEXT).promptHash, reviewTextHashes(candidateText).toolHash,
        reviewTextHashes(BASELINE_REVIEW_TEXT).toolHash, JSON.stringify(rows)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async function seedBinding(client: PoolClient): Promise<void> {
    await client.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,quiescence_receipt,review_execution_mode,execution_mode_generation,review_execution_state)
      VALUES ($1,$2,'github',$3,'acme/release',700,7,'env:GITHUB_TOKEN',
       'active',1,'{}'::jsonb,'harness_async',1,'active')`, [integrationId, tenantId, origin]);
    await client.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,quiescence_receipt,review_execution_mode,execution_mode_generation,review_execution_state)
      VALUES ($1,$2,'github',$3,'acme/other-release',701,7,'env:GITHUB_TOKEN',
       'active',1,'{}'::jsonb,'harness_async',1,'active')`, [otherIntegrationId, tenantId, origin]);
  }

  async function seedDatasetCases(client: PoolClient): Promise<void> {
    const cases = Array.from({ length: 300 }, (_, index) => ({ ordinal: index, runId: randomUUID(), stepId: randomUUID(),
      labelId: randomUUID(), fixtureId: fingerprint(`release-fixture-${index}`), repository: `repo-${Math.floor(index / 10)}`,
      split: index < 150 ? "validation" : "holdout" }));
    await client.query(`INSERT INTO pr_agent_harness.eval_datasets
      (id,tenant_id,name,status,version,curator_actor_type,curator_actor_id,split_policy_json,split_policy_hash)
      VALUES ($1,$2,'release-engineering','draft',1,'user','qualifier','{}'::jsonb,$3)`,
    [datasetId, tenantId, fingerprint({})]);
    await client.query(`INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
       run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
       policy_version_hash,runtime_version_hash,input_json,status,finished_at,authority_generation,execution_mode_generation)
      SELECT x.run_id,$1,$2,'service','release-fixture','release-case',x.run_id::text,encode(digest(x.run_id::text,'sha256'),'hex'),
       'review.deep.v1',$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb,'succeeded',clock_timestamp(),1,1
      FROM jsonb_to_recordset($11::jsonb) x(run_id uuid)`, [tenantId, integrationId, "a".repeat(40), "b".repeat(40),
      currentManifest.workflowVersionHash, currentManifest.promptVersionHash, currentManifest.modelVersionHash,
      currentManifest.toolVersionHash, currentManifest.policyVersionHash, currentManifest.runtimeVersionHash,
      JSON.stringify(cases.map(({ runId }) => ({ run_id: runId })))]);
    await client.query(`INSERT INTO pr_agent_harness.agent_steps
      (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
      SELECT x.step_id,$1,x.run_id,'github.collect_context.v1','tool',$2,'succeeded',$2,'{"value":{}}'::jsonb,1,1,clock_timestamp()
      FROM jsonb_to_recordset($3::jsonb) x(step_id uuid,run_id uuid)`,
    [tenantId, fingerprint({}), JSON.stringify(cases.map(({ stepId, runId }) => ({ step_id: stepId, run_id: runId })))]);
    await client.query(`INSERT INTO pr_agent_harness.trusted_review_label_sets
      (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,label_set_json,
       version,active,resolution_kind,resolution_json)
      SELECT x.label_id,$1,$2,x.run_id,$3,'review-quality.v1',$4,$5::jsonb,1,true,'consensus','{}'::jsonb
      FROM jsonb_to_recordset($6::jsonb) x(label_id uuid,run_id uuid)`,
    [tenantId, integrationId, artifactHash, labelHash, JSON.stringify(labelSet),
      JSON.stringify(cases.map(({ labelId, runId }) => ({ label_id: labelId, run_id: runId })))]);
    await client.query(`INSERT INTO pr_agent_harness.eval_fixtures
      (id,tenant_id,integration_id,run_id,repository,base_sha,head_sha,input_hash,source_step_id,
       source_step_output_hash,artifact_hash,fixture_hash,input_json,files_manifest_json,coverage_json,ci_json,total_bytes)
      SELECT x.fixture_id,$1,$2,x.run_id,x.repository,$3,$4,$5,x.step_id,$5,$6,x.fixture_id,
       '{}'::jsonb,'[]'::jsonb,'{"status":"complete","reasonCodes":[]}'::jsonb,'{}'::jsonb,2
      FROM jsonb_to_recordset($7::jsonb) x(fixture_id text,run_id uuid,repository text,step_id uuid)`,
    [tenantId, integrationId, "a".repeat(40), "b".repeat(40), fingerprint({}), artifactHash,
      JSON.stringify(cases.map(({ fixtureId, runId, repository, stepId }) =>
        ({ fixture_id: fixtureId, run_id: runId, repository, step_id: stepId })))]);
    const files = cases.flatMap(({ fixtureId }) => [{ fixture_id: fixtureId, path: "src/value.ts" },
      { fixture_id: fixtureId, path: "src/value.js" }]);
    await client.query(`INSERT INTO pr_agent_harness.eval_fixture_files
      (tenant_id,fixture_id,path,kind,content_text,content_hash,size_bytes)
      SELECT $1,x.fixture_id,x.path,'source','x',$2,1 FROM jsonb_to_recordset($3::jsonb) x(fixture_id text,path text)`,
    [tenantId, fingerprint("x"), JSON.stringify(files)]);
    await client.query(`INSERT INTO pr_agent_harness.eval_cases
      (tenant_id,integration_id,dataset_id,source_run_id,fixture_id,label_set_id,source_artifact_hash,
       fixture_hash,label_set_hash,label_set_json,lineage_hash,shingle_hash,shingle_hashes_json,
       source_created_at,repository,pull_number,split,ordinal)
      SELECT $1,$2,$3,x.run_id,x.fixture_id,x.label_id,$4,x.fixture_id,$5,$6::jsonb,
       encode(digest('lineage-'||x.ordinal,'sha256'),'hex'),encode(digest('shingle-'||x.ordinal,'sha256'),'hex'),
       '[]'::jsonb,clock_timestamp(),x.repository,x.ordinal+1,x.split,x.ordinal
      FROM jsonb_to_recordset($7::jsonb) x(run_id uuid,fixture_id text,label_id uuid,repository text,split text,ordinal integer)`,
    [tenantId, integrationId, datasetId, artifactHash, labelHash, JSON.stringify(labelSet), JSON.stringify(cases.map(
      ({ runId, fixtureId, labelId, repository, split, ordinal }) => ({ run_id: runId, fixture_id: fixtureId,
        label_id: labelId, repository, split, ordinal })))]);
    await client.query(`UPDATE pr_agent_harness.eval_datasets SET status='frozen',manifest_hash=$3,case_count=300,
      dev_count=0,validation_count=150,holdout_count=150,frozen_at=clock_timestamp(),version=2,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`, [tenantId, datasetId, manifestHash]);
  }

  async function seedCandidate(client: PoolClient): Promise<void> {
    const base = reviewTextHashes(BASELINE_REVIEW_TEXT);
    const sourceWithoutHash = { schemaVersion: 1 as const, datasetId, datasetVersion: 2, datasetManifestHash: manifestHash,
      baselinePromptText: BASELINE_REVIEW_TEXT.prompt_text,
      baselineToolDescriptionText: BASELINE_REVIEW_TEXT.tool_description_text,
      baselinePromptHash: base.promptHash, baselineToolHash: base.toolHash,
      developmentCases: [{ caseId: randomUUID(), sourceRunId: randomUUID(), repository: "engineering-only",
        sourceArtifactHash: artifactHash, labelSetHash: labelHash, expectedFindings: [] }] };
    const source = { ...sourceWithoutHash, sourceHash: fingerprint(sourceWithoutHash) };
    await client.query(`INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
       run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
       policy_version_hash,runtime_version_hash,input_json,status,finished_at,authority_generation,execution_mode_generation)
      VALUES ($1,$2,$3,'user','qualifier','release-proposal','proposal',$4,'evolution.propose.v1',$5,$6,
       $7,$8,$9,$10,$11,$12,$13::jsonb,'succeeded',clock_timestamp(),1,1)`,
    [proposalRunId, tenantId, integrationId, fingerprint(source), "a".repeat(40), "b".repeat(40),
      currentManifest.workflowVersionHash, currentManifest.promptVersionHash, currentManifest.modelVersionHash,
      currentManifest.toolVersionHash, currentManifest.policyVersionHash, currentManifest.runtimeVersionHash,
      JSON.stringify({ schemaVersion: 1, workflow: "evolution.propose.v1", datasetId, datasetVersion: 2,
        datasetManifestHash: manifestHash, sourceHash: source.sourceHash })]);
    await client.query(`INSERT INTO pr_agent_harness.evolution_proposal_sources
      (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
       baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
      VALUES ($1,$2,$3,2,$4,$5,$6,$7,$8::jsonb,'user','qualifier')`,
    [tenantId, proposalRunId, datasetId, manifestHash, base.promptHash, base.toolHash, source.sourceHash, JSON.stringify(source)]);
    await client.query(`INSERT INTO pr_agent_harness.evolution_candidates
      (id,tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,candidate_json,candidate_hash,
       baseline_prompt_hash,baseline_tool_hash,model_config_hash,source_hash,provenance_json,created_by_actor_type,created_by_actor_id)
      VALUES ($1,$2,$3,$4,2,$5,$6::jsonb,$7,$8,$9,$10,$11,'{}'::jsonb,'user','qualifier')`,
    [candidateId, tenantId, proposalRunId, datasetId, manifestHash, JSON.stringify(candidateText), fingerprint(candidateText),
      base.promptHash, base.toolHash, fingerprint(getModelExecutionPolicy("openai-compatible", "p3c-model")), source.sourceHash]);
  }

  async function seedEvaluation(client: PoolClient, evaluationId: string, split: "validation" | "holdout"): Promise<void> {
    const metrics = goodMetrics(); const cases = await client.query<{ id: string; fixture_hash: string;
      label_set_id: string; label_set_hash: string }>(
      `SELECT id,fixture_hash,label_set_id,label_set_hash FROM pr_agent_harness.eval_cases
       WHERE tenant_id=$1 AND dataset_id=$2 AND split=$3 ORDER BY ordinal`, [tenantId, datasetId, split]);
    const baseHashes = reviewTextHashes(BASELINE_REVIEW_TEXT); const candidateHashes = reviewTextHashes(candidateText);
    await client.query(`INSERT INTO pr_agent_harness.eval_runs
      (id,tenant_id,dataset_id,candidate_id,curator_actor_type,curator_actor_id,split,command_key,request_hash,status,
       repetitions,manifest_hash,baseline_component_hash,candidate_component_hash,model_version_hash,runtime_version_hash,
       scheduling_policy_json,scheduling_policy_hash,total_result_count,planned_result_count,completed_result_count,
       failed_result_count,deadline_at,metrics_json,metrics_hash,completed_at)
      VALUES ($1,$2,$3,$4,'user','qualifier',$5,$6,$7,'succeeded',3,$8,$9,$10,$11,$12,$13::jsonb,$14,
       900,900,900,0,clock_timestamp()+interval '7 days',$15::jsonb,$16,clock_timestamp())`,
    [evaluationId, tenantId, datasetId, candidateId, split, `release-${split}`, fingerprint({ split }),
      fingerprint({ split, manifestHash }), baseHashes.contentHash, candidateHashes.contentHash,
      currentManifest.modelVersionHash, currentManifest.runtimeVersionHash, JSON.stringify(EVALUATION_SCHEDULING_POLICY),
      EVALUATION_SCHEDULING_POLICY_HASH, JSON.stringify(metrics), fingerprint(metrics)]);
    const rows = cases.rows.flatMap((item) => (["baseline", "candidate"] as const).flatMap((variant) =>
      [1, 2, 3].map((repetition) => ({ case_id: item.id, variant, repetition,
        seed_hash: fingerprint({ evaluationId, caseId: item.id, variant, repetition }), fixture_hash: item.fixture_hash,
        label_set_id: item.label_set_id, label_set_hash: item.label_set_hash }))));
    await client.query(`INSERT INTO pr_agent_harness.eval_results
      (tenant_id,eval_run_id,dataset_id,case_id,integration_id,variant,repetition,seed_hash,fixture_hash,label_set_id,
       label_set_hash,component_hash,expected_workflow_hash,expected_prompt_hash,expected_model_hash,expected_tool_hash,
       expected_policy_hash,expected_runtime_hash,expected_verifier_hash,status,score_json,score_hash,usage_json,latency_ms,completed_at)
      SELECT $1,$2,$3,x.case_id,$4,x.variant,x.repetition,x.seed_hash,x.fixture_hash,x.label_set_id,x.label_set_hash,
       CASE WHEN x.variant='baseline' THEN $5 ELSE $6 END,
       CASE WHEN x.variant='baseline' THEN $7 ELSE $13 END,CASE WHEN x.variant='baseline' THEN $8 ELSE $14 END,
       CASE WHEN x.variant='baseline' THEN $9 ELSE $15 END,CASE WHEN x.variant='baseline' THEN $10 ELSE $16 END,
       CASE WHEN x.variant='baseline' THEN $11 ELSE $17 END,CASE WHEN x.variant='baseline' THEN $12 ELSE $18 END,
       $19,'succeeded','{}'::jsonb,$20,'{"costMicros":100,"modelCallCount":1,"providerModelVersions":["provider-v1"]}'::jsonb,
       100,clock_timestamp()
      FROM jsonb_to_recordset($21::jsonb) x(case_id uuid,variant text,repetition integer,seed_hash text,
        fixture_hash text,label_set_id uuid,label_set_hash text)`,
    [tenantId, evaluationId, datasetId, integrationId, baseHashes.contentHash, candidateHashes.contentHash,
      baselineManifest.workflowVersionHash, baselineManifest.promptVersionHash, baselineManifest.modelVersionHash,
      baselineManifest.toolVersionHash, baselineManifest.policyVersionHash, baselineManifest.runtimeVersionHash,
      candidateManifest.workflowVersionHash, candidateManifest.promptVersionHash, candidateManifest.modelVersionHash,
      candidateManifest.toolVersionHash, candidateManifest.policyVersionHash, candidateManifest.runtimeVersionHash,
      REPLAY_VERIFIER_HASH, fingerprint({}), JSON.stringify(rows)]);
  }

  function goodMetrics() {
    const side = { total: 450, succeeded: 450, meanSeverityWeightedF1: 1, p50CostMicros: 100,
      safetyRegressions: 0, highFalsePositives: 0, highFalseNegatives: 0, incompleteAnalyses: 0 };
    return { schemaVersion: 1, repetitions: 3, completeMatrix: true, comparable: true,
      providerModelVersions: ["provider-v1"], unavailableUsageMeasurements: 0, missingModelCallResults: 0,
      pendingExternalCostResults: 0, manifestDriftResults: 0, missingLatencyMeasurements: 0, failedResults: 0,
      baseline: side, candidate: { ...side, meanSeverityWeightedF1: 1.03, p50CostMicros: 120 } };
  }

  async function apiRequest(path: string, idempotencyKey: string, body: unknown): Promise<Response> {
    return fetch(`${apiOrigin}${path}`, { method: "POST", headers: { authorization: `Bearer ${apiToken}`,
      "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000) });
  }

  async function releaseTrace(runId: string, token: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${apiOrigin}/runs/${runId}/trace`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { entries: Array<{ kind: string; metadata: Record<string, unknown> }> };
    const selection = body.entries.find(({ kind }) => kind === "release_selection")?.metadata;
    assert.ok(selection, "release selection trace entry is required");
    return selection;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

function pricing(): string {
  return JSON.stringify({ version: "p3c-tests", currency: "USD", periodKey: "p3c-tests",
    tenantLimits: { inputTokens: 50_000_000, outputTokens: 50_000_000, costMicros: 50_000_000 },
    runLimits: { inputTokens: 100_000, outputTokens: 50_000, costMicros: 5_000_000 },
    models: { "openai-compatible:p3c-model": { rates: { inputMicrosPerMillion: 1_000_000,
      cachedInputMicrosPerMillion: 1_000_000, cacheWriteInputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000, thoughtOutputMicrosPerMillion: 1_000_000,
      toolInputMicrosPerMillion: 1_000_000 }, maxOutputTokens: 8_192,
      maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } } });
}
