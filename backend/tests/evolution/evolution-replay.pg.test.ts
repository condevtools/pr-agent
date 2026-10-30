import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore, type PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { ModelBudgetStore, getModelExecutionPolicy } from "../../src/agent-runtime/budget/model-budget-store.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { RunWorker } from "../../src/agent-runtime/execution/run-worker.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { closeAgentRuntime, executeAgentRun } from "../../src/agent-runtime/runtime.js";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { RunControlError } from "../../src/agent-runtime/runs/control-contracts.js";
import { fingerprint, runtimeVersionManifest } from "../../src/agent-runtime/versions.js";
import { resolveModelConfiguration } from "../../src/model/configuration.js";
import { PgEvolutionDatasetStore } from "../../src/evolution/datasets/store.js";
import { buildDatasetFixture, type DatasetRepositoryAdapter } from "../../src/evolution/datasets/fixture.js";
import { PgEvolutionFeedbackStore } from "../../src/evolution/feedback/store.js";
import { PgEvolutionCandidateStore } from "../../src/evolution/proposals/candidate-store.js";
import { admitEvolutionProposalRun } from "../../src/evolution/proposals/intake.js";
import { admitEvaluation, buildReplayRunCreationInput } from "../../src/evolution/evaluations/intake.js";
import { EVALUATION_SCHEDULING_POLICY, EVALUATION_SCHEDULING_POLICY_HASH } from "../../src/evolution/evaluations/contracts.js";
import { EvaluationCoordinator } from "../../src/evolution/evaluations/run.js";
import { PgEvolutionEvaluationStore } from "../../src/evolution/evaluations/store.js";
import type { TrustedLabelSetV1 } from "../../src/evolution/feedback/contracts.js";
import { BASELINE_REVIEW_TEXT, reviewTextHashes } from "../../src/review/strategy/text-components.js";
import { prepareHarnessRuntimeRoles, reapplyVersionedRuntimeGrants } from "../support/harness-runtime-roles.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Evolution replay PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("evolution replay requires a disposable database");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const adminDb = new RuntimeDatabase(adminPool);
  const appPassword = randomUUID(); const tenantId = randomUUID();
  const developmentIntegrationId = randomUUID(); const holdoutIntegrationId = randomUUID();
  const developmentRunId = randomUUID(); const holdoutRunId = randomUUID();
  const baseSha = "a".repeat(40); const headSha = "b".repeat(40);
  const candidateText = { schemaVersion: 1 as const, prompt_text: "P3B_CANDIDATE_PROMPT_SENTINEL",
    tool_description_text: "P3B_CANDIDATE_TOOL_SENTINEL" };
  const secretFindingTitle = "Credential exposure: api_key=p3b-super-secret-value";
  const labels: TrustedLabelSetV1 = { schemaVersion: 1, rubricVersion: "review-quality.v1",
    completeness: "complete", expectedFindings: [{ path: "src/a.ts", startLine: 1, endLine: 1,
      severity: "high", title: secretFindingTitle }] };
  const calls: Array<{ method: string; path: string; body: string }> = [];
  let origin = ""; let server: Server; let appPool: Pool; let appDb: RuntimeDatabase;
  let developmentBinding: PublicationBinding; let holdoutBinding: PublicationBinding;
  let datasetId = ""; let candidateId = ""; let proposalRunId = "";
  let execution: RunExecutionStore; let budget: ModelBudgetStore;
  let blockedModelRequest: ModelRequestGate | undefined;

  const curator = (integrationId = developmentIntegrationId, extra: RunPrincipal["permissions"] = []): RunPrincipal => ({
    subjectId: "evolution-curator", actorType: "user", tenantId, integrationId,
    permissions: ["evolution:propose", "evaluations:create", "evaluations:read", ...extra],
  });

  before(async () => {
    server = createServer(async (request, response) => {
      const method = request.method ?? "GET"; const path = request.url ?? "/";
      let body = ""; for await (const chunk of request) body += chunk;
      calls.push({ method, path, body });
      if (method === "POST" && path === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } };
        const schema = parsed.response_format?.json_schema?.name;
        if (blockedModelRequest && schema === "deep_security_turn") {
          const gate = blockedModelRequest; blockedModelRequest = undefined;
          gate.markStarted(); await gate.waitForRelease;
        }
        const content = schema === "evolution_candidate_v1" ? candidateText
          : schema === "deep_review_critic" ? { decisions: [] }
          : { action: "finish", candidates: [] };
        return json(response, 200, { id: `p3b-${randomUUID()}`, object: "chat.completion", created: 1,
          model: "p3b-provider-model-v1", choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
      }
      return json(response, 404, { message: "no live provider route exists in replay fixture" });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("mock server did not bind");
    origin = `http://127.0.0.1:${address.port}`;

    await prepareHarnessRuntimeRoles(adminPool, { app: appPassword, verifier: randomUUID() });
    await migrateRuntime(adminPool);
    process.env.AI_PROVIDER = "openai-compatible"; process.env.AI_MODEL = "p3b-model";
    process.env.FEATURE_EVOLUTION = "on";
    process.env.OPENAI_BASE_URL = `${origin}/v1`; process.env.OPENAI_COMPATIBLE_API_KEY = "local-model-key";
    process.env.HARNESS_MODEL_PRICING_JSON = pricing();
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    appPool = new Pool({ connectionString: appUrl.toString(), max: 16 }); appDb = new RuntimeDatabase(appPool);
    execution = new RunExecutionStore(appDb); budget = new ModelBudgetStore(appDb);
    developmentBinding = await bind(developmentIntegrationId, "acme/development-sentinel", 501);
    holdoutBinding = await bind(holdoutIntegrationId, "acme/HOLDOUT_SECRET_SENTINEL", 502);
    await seedReview(developmentRunId, developmentBinding, "2024-01-01T00:00:00Z", "development unique alpha beta gamma delta epsilon");
    await seedReview(holdoutRunId, holdoutBinding, "2026-01-01T00:00:00Z", "holdout unique quartz violet zebra nickel tungsten");
    await createTrustedLabels(developmentRunId, developmentIntegrationId);
    await createTrustedLabels(holdoutRunId, holdoutIntegrationId);
    datasetId = await createFrozenDataset();
  });

  after(async () => {
    await closeAgentRuntime(); await appPool?.end(); await adminPool.end();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("production structured model creates one immutable development-only research draft idempotently", async () => {
    calls.length = 0;
    const created = await admitEvolutionProposalRun({ db: appDb, binding: developmentBinding,
      principal: curator(), datasetId, commandKey: "proposal-1" });
    proposalRunId = created.id; assert.equal(created.created, true);
    const duplicate = await admitEvolutionProposalRun({ db: appDb, binding: developmentBinding,
      principal: curator(), datasetId, commandKey: "proposal-1" });
    assert.equal(duplicate.id, created.id); assert.equal(duplicate.created, false);
    await assert.rejects(admitEvolutionProposalRun({ db: appDb, binding: developmentBinding,
      principal: curator(), datasetId: randomUUID(), commandKey: "proposal-1" }),
    (error: unknown) => error instanceof RunControlError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409);

    const errors: unknown[] = [];
    const worker = workerFor(errors);
    await worker.tick(); await worker.drain();
    assert.equal((await execution.load(tenantId, created.id))?.status, "succeeded", formatErrors(errors));
    const row = (await adminPool.query<{ id: string; status: string; candidate_json: typeof candidateText;
      provenance_json: { proposalRunId: string; modelStepId: string }; created_by_actor_id: string }>(
      "SELECT id,status,candidate_json,provenance_json,created_by_actor_id FROM pr_agent_harness.evolution_candidates WHERE tenant_id=$1 AND proposal_run_id=$2",
      [tenantId, created.id])).rows[0]!;
    candidateId = row.id;
    assert.equal(row.status, "research_draft"); assert.deepEqual(row.candidate_json, candidateText);
    assert.equal(row.provenance_json.proposalRunId, created.id); assert.equal(row.created_by_actor_id, curator().subjectId);
    assert.ok((await adminPool.query("SELECT 1 FROM pr_agent_harness.agent_steps WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='succeeded'",
      [tenantId, created.id, row.provenance_json.modelStepId])).rowCount);
    const modelBodies = calls.filter(({ path }) => path === "/v1/chat/completions").map(({ body }) => body);
    assert.equal(modelBodies.length, 1);
    assert.match(modelBodies[0]!, /acme\/development-sentinel/);
    assert.doesNotMatch(modelBodies[0]!, /HOLDOUT_SECRET_SENTINEL/);
    assert.doesNotMatch(modelBodies[0]!, /p3b-super-secret-value/);
    assert.match(modelBodies[0]!, /api_key=\[REDACTED\]/);
    assert.match(modelBodies[0]!, new RegExp(BASELINE_REVIEW_TEXT.prompt_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const provenance = (await adminPool.query<{ candidate_hash: string; source_hash: string; baseline_prompt_hash: string;
      baseline_tool_hash: string; source_json: { developmentCases: Array<{ repository: string;
        expectedFindings: Array<{ title: string }> }> } }>(
      `SELECT c.candidate_hash,c.source_hash,c.baseline_prompt_hash,c.baseline_tool_hash,s.source_json
       FROM pr_agent_harness.evolution_candidates c JOIN pr_agent_harness.evolution_proposal_sources s
         ON s.tenant_id=c.tenant_id AND s.proposal_run_id=c.proposal_run_id
       WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, candidateId])).rows[0]!;
    assert.equal(provenance.candidate_hash, fingerprint(candidateText));
    assert.deepEqual({ promptHash: provenance.baseline_prompt_hash, toolHash: provenance.baseline_tool_hash },
      { promptHash: reviewTextHashes(BASELINE_REVIEW_TEXT).promptHash, toolHash: reviewTextHashes(BASELINE_REVIEW_TEXT).toolHash });
    assert.deepEqual(provenance.source_json.developmentCases.map(({ repository }) => repository), ["acme/development-sentinel"]);
    assert.equal(provenance.source_json.developmentCases[0]!.expectedFindings[0]!.title,
      "Credential exposure: api_key=[REDACTED]");
    assert.doesNotMatch(JSON.stringify(provenance.source_json), /p3b-super-secret-value/);
    const roleSecurity = await adminPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='pr_agent_app'");
    assert.deepEqual(roleSecurity.rows[0], { rolsuper: false, rolbypassrls: false });
    const rls = await adminPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE relnamespace='pr_agent_harness'::regnamespace
         AND relname=ANY($1::text[]) ORDER BY relname`,
      [["eval_results", "eval_runs", "evolution_candidates", "evolution_proposal_sources"]]);
    assert.equal(rls.rowCount, 4); assert.ok(rls.rows.every(({ relrowsecurity, relforcerowsecurity }) =>
      relrowsecurity && relforcerowsecurity));
    assert.deepEqual(calls.filter(({ method, path }) => path !== "/v1/chat/completions" && !["GET", "HEAD"].includes(method)), []);
    assert.equal((await new PgEvolutionCandidateStore(appDb).read(curator(), candidateId)).status, "research_draft");
    await assert.rejects(new PgEvolutionCandidateStore(appDb).read({ ...curator(), subjectId: "other-curator" }, candidateId),
      (error: unknown) => error instanceof RunControlError && error.status === 404);
    await assert.rejects(new PgEvolutionCandidateStore(appDb).read(curator(holdoutIntegrationId), candidateId),
      (error: unknown) => error instanceof RunControlError && error.code === "CANDIDATE_NOT_FOUND" && error.status === 404);

    await adminPool.query(`GRANT INSERT,UPDATE,DELETE ON pr_agent_harness.evolution_proposal_sources,
      pr_agent_harness.evolution_candidates,pr_agent_harness.eval_runs,pr_agent_harness.eval_results TO pr_agent_app`);
    await reapplyVersionedRuntimeGrants(adminPool);
    const privileges = await appPool.query<Record<string, boolean>>(
      `SELECT has_table_privilege(current_user,'pr_agent_harness.evolution_candidates','INSERT') candidate_insert,
        has_table_privilege(current_user,'pr_agent_harness.eval_runs','UPDATE') eval_update,
        has_table_privilege(current_user,'pr_agent_harness.eval_results','DELETE') result_delete,
        has_column_privilege(current_user,'pr_agent_harness.evolution_candidates','status','INSERT') candidate_status_insert,
        has_column_privilege(current_user,'pr_agent_harness.evolution_candidates','content_purged_at','INSERT') candidate_purge_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_runs','metrics_json','INSERT') metrics_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_results','score_json','INSERT') score_insert,
        has_column_privilege(current_user,'pr_agent_harness.eval_results','created_at','INSERT') result_created_insert`);
    assert.deepEqual(privileges.rows[0], Object.fromEntries(Object.keys(privileges.rows[0]!).map((key) => [key, false])));
    await assert.rejects(appDb.transaction(tenantId, (client) => client.query(
      "INSERT INTO pr_agent_harness.evolution_candidates (status) VALUES ('research_draft')")),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "42501");
  });

  test("production replay executes three baseline and candidate repetitions with exact text injection and terminal scoring", async () => {
    assert.ok(candidateId, "proposal test must create candidate"); calls.length = 0;
    const receipt = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-success",
      request: { datasetId, candidateId, split: "development" } });
    assert.equal(receipt.plannedResults, 6); assert.equal(receipt.repetitions, 3);
    const duplicate = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-success",
      request: { datasetId, candidateId, split: "development" } });
    assert.equal(duplicate.id, receipt.id);
    await assert.rejects(new PgEvolutionEvaluationStore(appDb).read(curator(holdoutIntegrationId), receipt.id),
      (error: unknown) => error instanceof RunControlError && error.code === "EVALUATION_NOT_FOUND" && error.status === 404);
    await assert.rejects(admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-success",
      request: { datasetId, candidateId, split: "validation" } }),
    (error: unknown) => error instanceof RunControlError && error.status === 409);
    await assert.rejects(admitEvaluation({ db: appDb, principal: curator(), commandKey: "holdout-denied",
      request: { datasetId, candidateId, split: "holdout" } }),
    (error: unknown) => error instanceof RunControlError && error.status === 403);

    await executeEvaluation(receipt.id);
    const completed = await new PgEvolutionEvaluationStore(appDb).read(curator(), receipt.id);
    assert.equal(completed.status, "succeeded"); assert.equal(completed.completedResults, 6);
    const completeMetrics = completed.metrics as { comparable?: boolean; baseline?: { total?: number; succeeded?: number; costMicros?: number };
      candidate?: { total?: number; succeeded?: number; costMicros?: number } };
    assert.equal(completeMetrics.comparable, true);
    assert.deepEqual({ total: completeMetrics.baseline?.total, succeeded: completeMetrics.baseline?.succeeded },
      { total: 3, succeeded: 3 });
    assert.deepEqual({ total: completeMetrics.candidate?.total, succeeded: completeMetrics.candidate?.succeeded },
      { total: 3, succeeded: 3 });
    assert.ok((completeMetrics.baseline?.costMicros ?? 0) > 0); assert.ok((completeMetrics.candidate?.costMicros ?? 0) > 0);
    const results = await adminPool.query<{ variant: string; repetition: number; status: string; score_json: unknown;
      child_run_id: string; component_hash: string; fixture_hash: string; label_set_hash: string }>(
      `SELECT variant,repetition,status,score_json,child_run_id,component_hash,fixture_hash,label_set_hash
       FROM pr_agent_harness.eval_results WHERE tenant_id=$1 AND eval_run_id=$2 ORDER BY variant,repetition`,
      [tenantId, receipt.id]);
    assert.deepEqual(results.rows.map(({ variant, repetition, status }) => ({ variant, repetition, status })), [
      { variant: "baseline", repetition: 1, status: "succeeded" }, { variant: "baseline", repetition: 2, status: "succeeded" },
      { variant: "baseline", repetition: 3, status: "succeeded" }, { variant: "candidate", repetition: 1, status: "succeeded" },
      { variant: "candidate", repetition: 2, status: "succeeded" }, { variant: "candidate", repetition: 3, status: "succeeded" },
    ]);
    assert.ok(results.rows.every(({ score_json }) => score_json !== null));
    const child = await adminPool.query<{ input_json: Record<string, unknown> }>(
      "SELECT input_json FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, results.rows[0]!.child_run_id]);
    assert.equal(child.rows[0]!.input_json.fixtureHash, results.rows[0]!.fixture_hash);
    assert.equal(child.rows[0]!.input_json.labelSetHash, results.rows[0]!.label_set_hash);
    assert.equal(child.rows[0]!.input_json.componentHash, results.rows[0]!.component_hash);

    const requests = modelRequests();
    const candidateRequests = requests.filter((body) => body.includes("P3B_CANDIDATE_PROMPT_SENTINEL"));
    const baselineRequests = requests.filter((body) => !body.includes("P3B_CANDIDATE_PROMPT_SENTINEL"));
    assert.equal(candidateRequests.length, 9); assert.equal(baselineRequests.length, 9);
    assert.ok(candidateRequests.every((body) => body.includes("P3B_CANDIDATE_TOOL_SENTINEL")));
    assert.ok(candidateRequests.some((body) => body.includes("deep_review_critic")));
    const securityRequests = requests.map((body) => JSON.parse(body) as { response_format?: { json_schema?: { name?: string } };
      messages?: Array<{ role?: string; content?: string }> }).filter((body) =>
      body.response_format?.json_schema?.name === "deep_security_turn");
    assert.equal(securityRequests.length, 6);
    assert.equal(new Set(securityRequests.map((body) => body.messages?.find(({ role }) => role === "user")?.content)).size, 1);
    const hashes = await adminPool.query<{ variant: string; input_hash: string }>(
      `SELECT x.variant,s.input_hash FROM pr_agent_harness.eval_results x JOIN pr_agent_harness.agent_steps s
         ON s.tenant_id=x.tenant_id AND s.run_id=x.child_run_id AND s.step_key='deep.role.security.turn.1'
       WHERE x.tenant_id=$1 AND x.eval_run_id=$2 ORDER BY x.variant,x.repetition`, [tenantId, receipt.id]);
    const baselineHashes = new Set(hashes.rows.filter(({ variant }) => variant === "baseline").map(({ input_hash }) => input_hash));
    const candidateHashes = new Set(hashes.rows.filter(({ variant }) => variant === "candidate").map(({ input_hash }) => input_hash));
    assert.equal(baselineHashes.size, 1); assert.equal(candidateHashes.size, 1);
    assert.notEqual([...baselineHashes][0], [...candidateHashes][0]);
    assert.deepEqual(calls.filter(({ method, path }) => path !== "/v1/chat/completions" && !["GET", "HEAD"].includes(method)), []);
  });

  test("failed or cancelled proposal Runs cannot admit evaluations for their retained candidates", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const retainedCandidateId = await cloneCandidateForTerminalProposal(status);
      await assert.rejects(admitEvaluation({ db: appDb, principal: curator(), commandKey: `terminal-proposal-${status}`,
        request: { datasetId, candidateId: retainedCandidateId, split: "development" } }),
      (error: unknown) => error instanceof RunControlError && error.code === "CANDIDATE_NOT_FOUND" && error.status === 404);
    }
  });

  test("current admission manifest drift terminalizes every undispatched result without creating child Runs", async () => {
    const receipt = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-admission-drift",
      request: { datasetId, candidateId, split: "development" } });
    const store = new PgEvolutionEvaluationStore(appDb);
    const inspectionLease = await store.claim(tenantId, developmentIntegrationId, "frozen-policy-inspection");
    assert.ok(inspectionLease);
    const pending = await store.nextPending(inspectionLease, developmentIntegrationId);
    assert.ok(pending);
    const frozenSource = (await adminPool.query<{ source_json: { baselinePromptText: string;
      baselineToolDescriptionText: string } }>(
      `SELECT s.source_json FROM pr_agent_harness.evolution_proposal_sources s
       JOIN pr_agent_harness.evolution_candidates c ON c.tenant_id=s.tenant_id AND c.proposal_run_id=s.proposal_run_id
       WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, candidateId])).rows[0]!.source_json;
    assert.deepEqual(pending.baselineText, { schemaVersion: 1, prompt_text: frozenSource.baselinePromptText,
      tool_description_text: frozenSource.baselineToolDescriptionText });
    await store.releaseAndFinalize(inspectionLease);
    await adminPool.query("UPDATE pr_agent_harness.eval_runs SET available_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [tenantId, receipt.id]);

    const originalModel = process.env.AI_MODEL;
    process.env.AI_MODEL = "p3b-drift-model";
    try {
      assert.equal(await new EvaluationCoordinator(store).tick(developmentBinding), true);
    } finally {
      process.env.AI_MODEL = originalModel;
    }

    const completed = await store.read(curator(), receipt.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.completedResults, 6); assert.equal(completed.failedResults, 6);
    assert.equal(completed.metrics?.comparable, false);
    assert.equal(completed.metrics?.manifestDriftResults, 6);
    const rows = await adminPool.query<{ status: string; error_code: string; child_run_id: string | null;
      usage_json: { costMeasurement?: string } }>(
      `SELECT status,error_code,child_run_id,usage_json FROM pr_agent_harness.eval_results
       WHERE tenant_id=$1 AND eval_run_id=$2 ORDER BY variant,repetition`, [tenantId, receipt.id]);
    assert.equal(rows.rowCount, 6);
    assert.ok(rows.rows.every((row) => row.status === "failed" && row.error_code === "admission_manifest_drift"
      && row.child_run_id === null && row.usage_json.costMeasurement === "not_dispatched"));
    assert.equal((await adminPool.query(
      "SELECT 1 FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND input_json->>'evaluationId'=$2",
      [tenantId, receipt.id])).rowCount, 0);
    const durable = (await adminPool.query<{ scheduling_policy_json: unknown; scheduling_policy_hash: string;
      deadline_at: Date; created_at: Date; metrics_json: unknown; metrics_hash: string }>(
      `SELECT scheduling_policy_json,scheduling_policy_hash,deadline_at,created_at,metrics_json,metrics_hash
       FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2`, [tenantId, receipt.id])).rows[0]!;
    assert.deepEqual(durable.scheduling_policy_json, EVALUATION_SCHEDULING_POLICY);
    assert.equal(durable.scheduling_policy_hash, EVALUATION_SCHEDULING_POLICY_HASH);
    assert.ok(durable.deadline_at.getTime() - durable.created_at.getTime()
      >= EVALUATION_SCHEDULING_POLICY.minimumDeadlineMs);
    assert.equal(durable.metrics_hash, fingerprint(durable.metrics_json));
  });

  test("deadline expiry preserves completed cost and marks running child cost as externally pending", async () => {
    const receipt = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-deadline",
      request: { datasetId, candidateId, split: "development" } });
    const store = new PgEvolutionEvaluationStore(appDb); const coordinator = new EvaluationCoordinator(store);
    const errors: unknown[] = []; const worker = workerFor(errors);
    assert.equal(await coordinator.tick(developmentBinding), true);
    assert.equal(await activeReplayChildren(receipt.id), EVALUATION_SCHEDULING_POLICY.maxConcurrentChildrenPerIntegration);

    await worker.tick(); await worker.drain();
    await adminPool.query("UPDATE pr_agent_harness.eval_runs SET available_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [tenantId, receipt.id]);
    assert.equal(await coordinator.tick(developmentBinding), true);
    assert.equal(await activeReplayChildren(receipt.id), EVALUATION_SCHEDULING_POLICY.maxConcurrentChildrenPerIntegration);

    const gate = createModelRequestGate(); blockedModelRequest = gate;
    try {
      await worker.tick();
      await withTimeout(gate.started, 5_000, "running replay model request did not start");
      const running = (await adminPool.query<{ result_id: string; child_run_id: string }>(
        `SELECT x.id AS result_id,x.child_run_id FROM pr_agent_harness.eval_results x
         JOIN pr_agent_harness.agent_runs r ON r.tenant_id=x.tenant_id AND r.id=x.child_run_id
         WHERE x.tenant_id=$1 AND x.eval_run_id=$2 AND r.status='running'`, [tenantId, receipt.id])).rows[0]!;
      assert.ok(running);
      await expireEvaluationDeadlines([receipt.id]);
      assert.equal(await store.claim(tenantId, developmentIntegrationId, "deadline-expirer"), undefined);

      const completed = await store.read(curator(), receipt.id);
      assert.equal(completed.status, "failed"); assert.equal(completed.completedResults, 6);
      assert.equal(completed.failedResults, 5); assert.equal(completed.metrics?.comparable, false);
      assert.ok(Number(completed.metrics?.pendingExternalCostResults ?? 0) >= 1);
      const metrics = completed.metrics as { baseline?: { costMicros?: number }; candidate?: { costMicros?: number } };
      assert.ok((metrics.baseline?.costMicros ?? 0) + (metrics.candidate?.costMicros ?? 0) > 0);
      const runningResult = (await adminPool.query<{ status: string; error_code: string;
        usage_json: { modelCallCount?: number; pendingExternalCost?: boolean } }>(
        "SELECT status,error_code,usage_json FROM pr_agent_harness.eval_results WHERE tenant_id=$1 AND id=$2",
        [tenantId, running.result_id])).rows[0]!;
      assert.deepEqual({ status: runningResult.status, errorCode: runningResult.error_code,
        pendingExternalCost: runningResult.usage_json.pendingExternalCost },
      { status: "cancelled", errorCode: "evaluation_deadline_exceeded", pendingExternalCost: true });
      assert.ok((runningResult.usage_json.modelCallCount ?? 0) >= 1);
      const durable = (await adminPool.query<{ completed_result_count: number; failed_result_count: number;
        metrics_json: unknown; metrics_hash: string }>(
        `SELECT completed_result_count,failed_result_count,metrics_json,metrics_hash
         FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2`, [tenantId, receipt.id])).rows[0]!;
      assert.deepEqual({ completed: durable.completed_result_count, failed: durable.failed_result_count },
        { completed: 6, failed: 5 });
      assert.equal(durable.metrics_hash, fingerprint(durable.metrics_json));
      assert.ok((await adminPool.query(
        "SELECT 1 FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2 AND cancel_requested_at IS NOT NULL",
        [tenantId, running.child_run_id])).rowCount);
    } finally {
      gate.release(); blockedModelRequest = undefined;
      await worker.drain();
    }
  });

  test("component model drift retains the complete repetition matrix and makes metrics incomparable", async () => {
    const receipt = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-drift",
      request: { datasetId, candidateId, split: "development" } });
    const coordinator = new EvaluationCoordinator(new PgEvolutionEvaluationStore(appDb)); const errors: unknown[] = [];
    const worker = workerFor(errors);
    assert.equal(await coordinator.tick(developmentBinding), true);
    const attached = (await adminPool.query<{ id: string; child_run_id: string }>(
      `SELECT id,child_run_id FROM pr_agent_harness.eval_results WHERE tenant_id=$1 AND eval_run_id=$2 AND child_run_id IS NOT NULL`,
      [tenantId, receipt.id])).rows[0]!;
    const before = await adminPool.query("SELECT score_json FROM pr_agent_harness.eval_results WHERE id=$1", [attached.id]);
    assert.equal(before.rows[0]!.score_json, null);
    await adminPool.query("UPDATE pr_agent_harness.agent_runs SET model_version_hash=$3 WHERE tenant_id=$1 AND id=$2",
      [tenantId, attached.child_run_id, fingerprint("forced-model-drift")]);
    await worker.tick(); await worker.drain();
    await runCoordinatorToTerminal(receipt.id, coordinator, worker, errors);

    const rows = await adminPool.query<{ variant: string; repetition: number; status: string; error_code: string | null;
      usage_json: { inputTokens?: number; outputTokens?: number; costMicros?: number } | null }>(
      `SELECT variant,repetition,status,error_code,usage_json FROM pr_agent_harness.eval_results
       WHERE tenant_id=$1 AND eval_run_id=$2 ORDER BY variant,repetition`, [tenantId, receipt.id]);
    assert.equal(rows.rowCount, 6); assert.deepEqual(new Set(rows.rows.map(({ repetition }) => repetition)), new Set([1, 2, 3]));
    const drifted = rows.rows.filter(({ error_code }) => error_code === "component_manifest_drift");
    assert.equal(drifted.length, 1);
    assert.ok((drifted[0]!.usage_json?.inputTokens ?? 0) > 0);
    assert.ok((drifted[0]!.usage_json?.costMicros ?? 0) > 0);
    const completed = await new PgEvolutionEvaluationStore(appDb).read(curator(), receipt.id);
    assert.equal(completed.failedResults, 1);
    assert.equal(completed.metrics?.comparable, false);
    const metrics = completed.metrics as { baseline?: { total?: number; failed?: number; costMicros?: number };
      candidate?: { total?: number; failed?: number; costMicros?: number }; manifestDrift?: number };
    assert.equal((metrics.baseline?.total ?? 0) + (metrics.candidate?.total ?? 0), 6);
    assert.equal((metrics.baseline?.failed ?? 0) + (metrics.candidate?.failed ?? 0), 1);
    assert.ok((metrics.baseline?.costMicros ?? 0) + (metrics.candidate?.costMicros ?? 0) > 0);
    assert.equal((await new PgEvolutionCandidateStore(appDb).read(curator(), candidateId)).status, "research_draft");
  });

  test("frozen scheduling policy limits active children globally across evaluations for one integration", async () => {
    const first = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-cap-first",
      request: { datasetId, candidateId, split: "development" } });
    const second = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-cap-second",
      request: { datasetId, candidateId, split: "development" } });
    const store = new PgEvolutionEvaluationStore(appDb); const coordinator = new EvaluationCoordinator(store);
    assert.equal(await coordinator.tick(developmentBinding), true);
    assert.equal(await coordinator.tick(developmentBinding), true);
    const counts = await adminPool.query<{ eval_run_id: string; active: string }>(
      `SELECT eval_run_id,count(*) FILTER (WHERE status IN ('queued','running'))::text AS active
       FROM pr_agent_harness.eval_results WHERE tenant_id=$1 AND eval_run_id=ANY($2::uuid[])
       GROUP BY eval_run_id ORDER BY eval_run_id`, [tenantId, [first.id, second.id]]);
    const byEvaluation = new Map(counts.rows.map((row) => [row.eval_run_id, Number(row.active)]));
    assert.equal((byEvaluation.get(first.id) ?? 0) + (byEvaluation.get(second.id) ?? 0),
      EVALUATION_SCHEDULING_POLICY.maxConcurrentChildrenPerIntegration);
    assert.deepEqual(new Set(byEvaluation.values()), new Set([0, EVALUATION_SCHEDULING_POLICY.maxConcurrentChildrenPerIntegration]));

    await expireEvaluationDeadlines([first.id, second.id]);
    assert.equal(await store.claim(tenantId, developmentIntegrationId, "capacity-cleanup"), undefined);
  });

  test("disabling Evolution pauses queued and already-leased evaluation work without creating a child", async () => {
    const receipt = await admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-disabled-queue",
      request: { datasetId, candidateId, split: "development" } });
    const store = new PgEvolutionEvaluationStore(appDb);
    const lease = await store.claim(tenantId, developmentIntegrationId, "disable-race-worker");
    assert.ok(lease);
    const pending = await store.nextPending(lease, developmentIntegrationId);
    assert.ok(pending);
    const authority = new PublicationAuthorityStore(adminDb);
    const current = await authority.get(tenantId, developmentIntegrationId);
    const disabled = await authority.configureCapabilities({ tenantId, integrationId: developmentIntegrationId,
      expectedVersion: current.version, reviewDeep: true, fix: false, evolution: false,
      defaultReviewWorkflow: "review.single.v1", actor: "p3b-fixture", actorType: "service" });
    assert.equal((await new PgEvolutionCandidateStore(appDb).read(curator(), candidateId)).id, candidateId);
    assert.equal((await store.read(curator(), receipt.id)).id, receipt.id);
    const proposalReplay = await admitEvolutionProposalRun({ db: appDb, binding: developmentBinding,
      principal: curator(), datasetId, commandKey: "proposal-1" });
    assert.equal(proposalReplay.id, proposalRunId); assert.equal(proposalReplay.created, false);
    await assert.rejects(admitEvolutionProposalRun({ db: appDb, binding: developmentBinding,
      principal: curator(), datasetId, commandKey: "proposal-disabled-new" }),
    (error: unknown) => error instanceof RunControlError && error.code === "CAPABILITY_DISABLED");
    await assert.rejects(admitEvaluation({ db: appDb, principal: curator(), commandKey: "evaluation-disabled-new",
      request: { datasetId, candidateId, split: "development" } }),
    (error: unknown) => error instanceof RunControlError && error.code === "CAPABILITY_DISABLED");
    await assert.rejects(store.attachChild(lease, pending,
      await buildReplayRunCreationInput(developmentBinding, pending)),
    (error: unknown) => error instanceof RunControlError
      && (error.code === "CAPABILITY_DISABLED" || error.code === "BINDING_CAPABILITY_CHANGED"));
    await store.releaseAndFinalize(lease);
    assert.equal(await store.claim(tenantId, developmentIntegrationId, "disabled-evaluation-worker"), undefined);
    assert.equal(await new EvaluationCoordinator(store).tick(developmentBinding), false);
    const unchanged = await adminPool.query<{ status: string; lease_epoch: string; children: number }>(
      `SELECT e.status,e.lease_epoch,
         (SELECT count(*)::int FROM pr_agent_harness.eval_results x
          WHERE x.tenant_id=e.tenant_id AND x.eval_run_id=e.id AND x.child_run_id IS NOT NULL) AS children
       FROM pr_agent_harness.eval_runs e WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, receipt.id]);
    assert.deepEqual(unchanged.rows[0], { status: "queued", lease_epoch: "1", children: 0 });
    assert.equal((await adminPool.query<{ count: string }>(
      `SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND create_key='proposal:proposal-disabled-new'`,
      [tenantId])).rows[0]!.count, "0");
    assert.equal((await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND command_key='evaluation-disabled-new'",
      [tenantId])).rows[0]!.count, "0");
    developmentBinding = await authority.configureCapabilities({ tenantId, integrationId: developmentIntegrationId,
      expectedVersion: disabled.version, reviewDeep: true, fix: false, evolution: true,
      defaultReviewWorkflow: "review.single.v1", actor: "p3b-fixture", actorType: "service" });
  });

  async function cloneCandidateForTerminalProposal(status: "failed" | "cancelled"): Promise<string> {
    const runId = randomUUID(); const retainedCandidateId = randomUUID();
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
          run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
          policy_version_hash,runtime_version_hash,input_json,status,finished_at,authority_generation,execution_mode_generation)
       SELECT $1,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,$2,$3,$4,
          'evolution.propose.v1',base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,
          tool_version_hash,policy_version_hash,runtime_version_hash,'{"workflow":"evolution.propose.v1"}'::jsonb,
          $5,clock_timestamp(),authority_generation,execution_mode_generation
       FROM pr_agent_harness.agent_runs WHERE tenant_id=$6 AND id=$7`,
      [runId, `retained-${status}`, `retained-${status}`, fingerprint({ runId, status }), status, tenantId, proposalRunId]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.evolution_proposal_sources
         (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
          baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
       SELECT tenant_id,$1,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
          baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id
       FROM pr_agent_harness.evolution_proposal_sources WHERE tenant_id=$2 AND proposal_run_id=$3`,
      [runId, tenantId, proposalRunId]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.evolution_candidates
         (id,tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,status,candidate_json,
          candidate_hash,baseline_prompt_hash,baseline_tool_hash,model_config_hash,source_hash,provenance_json,
          created_by_actor_type,created_by_actor_id)
       SELECT $1,tenant_id,$2::uuid,dataset_id,dataset_version,dataset_manifest_hash,status,candidate_json,candidate_hash,
          baseline_prompt_hash,baseline_tool_hash,model_config_hash,source_hash,
          provenance_json || jsonb_build_object('proposalRunId',($2::uuid)::text),created_by_actor_type,created_by_actor_id
       FROM pr_agent_harness.evolution_candidates WHERE tenant_id=$3 AND id=$4`,
      [retainedCandidateId, runId, tenantId, candidateId]);
    return retainedCandidateId;
  }

  async function activeReplayChildren(evaluationId: string): Promise<number> {
    const result = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pr_agent_harness.eval_results
       WHERE tenant_id=$1 AND eval_run_id=$2 AND status IN ('queued','running')`, [tenantId, evaluationId]);
    return Number(result.rows[0]!.count);
  }

  async function expireEvaluationDeadlines(evaluationIds: string[]): Promise<void> {
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE pr_agent_harness.eval_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [tenantId, evaluationIds]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  }

  async function executeEvaluation(evaluationId: string): Promise<void> {
    const coordinator = new EvaluationCoordinator(new PgEvolutionEvaluationStore(appDb)); const errors: unknown[] = [];
    const worker = workerFor(errors);
    await runCoordinatorToTerminal(evaluationId, coordinator, worker, errors);
  }

  async function runCoordinatorToTerminal(evaluationId: string, coordinator: EvaluationCoordinator,
    worker: RunWorker, errors: unknown[]): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await adminPool.query("UPDATE pr_agent_harness.eval_runs SET available_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [tenantId, evaluationId]);
      await coordinator.tick(developmentBinding);
      await worker.tick(); await worker.drain();
      const status = (await adminPool.query<{ status: string }>(
        "SELECT status FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2", [tenantId, evaluationId])).rows[0]!.status;
      if (["succeeded", "failed", "cancelled"].includes(status)) {
        assert.equal(errors.length, 0, formatErrors(errors)); return;
      }
    }
    throw new Error(`evaluation did not finish: ${formatErrors(errors)}`);
  }

  function workerFor(errors: unknown[]): RunWorker {
    return new RunWorker({ store: execution, budget, bindings: async () => [developmentBinding, holdoutBinding],
      runtimeHash: async () => runtimeVersionManifest(getModelExecutionPolicy(
        resolveModelConfiguration().provider, resolveModelConfiguration().model)).then(({ runtimeVersionHash }) => runtimeVersionHash),
      execute: executeAgentRun,
      onError: (error) => errors.push(error) }, 1);
  }

  async function createFrozenDataset(): Promise<string> {
    const store = new PgEvolutionDatasetStore(appDb);
    let dataset = await store.create(curator(), { name: "p3b-frozen", developmentBefore: "2025-01-01T00:00:00Z",
      validationBefore: "2025-12-01T00:00:00Z" });
    for (const item of [{ runId: developmentRunId, integrationId: developmentIntegrationId, token: "development" },
      { runId: holdoutRunId, integrationId: holdoutIntegrationId, token: "holdout" }]) {
      const labelId = (await adminPool.query<{ id: string }>(
        "SELECT id FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2 AND active",
        [tenantId, item.runId])).rows[0]!.id;
      const principal = curator(item.integrationId);
      const source = await store.loadCaseSource(principal, dataset.id, item.runId, labelId);
      const fixture = await buildDatasetFixture(source, fixtureAdapter(item.token));
      dataset = await store.addCase(principal, dataset.id, dataset.version, source, fixture);
    }
    return (await store.freeze(curator(), dataset.id, dataset.version)).id;
  }

  async function createTrustedLabels(runId: string, integrationId: string): Promise<void> {
    const feedback = new PgEvolutionFeedbackStore(appDb); const artifactHash = fingerprint(reviewArtifact());
    const request = { artifactHash, labelSet: labels, provenance: { method: "full_diff_review" as const } };
    await feedback.createAnnotation({ ...curator(integrationId), subjectId: `reviewer-a-${runId}` }, runId, "a", request);
    await feedback.createAnnotation({ ...curator(integrationId), subjectId: `reviewer-b-${runId}` }, runId, "b", request);
  }

  async function bind(id: string, repository: string, providerRepositoryId: number): Promise<PublicationBinding> {
    const runs = new RunStore(adminDb); const authority = new PublicationAuthorityStore(adminDb);
    await runs.registerIntegration({ tenantId, id, platform: "github", origin, repository });
    await authority.configure({ tenantId, integrationId: id, providerRepositoryId, providerActorId: 7,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0, evolutionEnabled: true });
    const active = await authority.transition({ tenantId, integrationId: id, expectedVersion: 1, action: "activate",
      actor: "p3b-fixture", actorType: "service", quiescenceEvidence: "local replay fixture" });
    await adminPool.query(`UPDATE pr_agent_harness.integration_bindings
      SET review_execution_mode='harness_async',review_execution_state='active',execution_mode_generation=1
      WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return { ...active, reviewExecutionMode: "harness_async", reviewExecutionState: "active", executionModeGeneration: 1 };
  }

  async function seedReview(runId: string, binding: PublicationBinding, createdAt: string, sourceText: string): Promise<void> {
    const input = reviewInput(binding); const requestHash = fingerprint(input);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,run_type,
          base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,policy_version_hash,
          runtime_version_hash,input_json,status,created_at,finished_at)
       VALUES ($1,$2,$3,'service','p3b-seed',$4,$10,$5,'review.deep.v1',$6,$7,$5,$5,$5,$5,$5,$5,$8::jsonb,
          'succeeded',$9,$9)`,
      [runId, tenantId, binding.id, `p3b:${runId}`, requestHash, baseSha, headSha, JSON.stringify(input), createdAt, runId]);
    const collected = collectedFixture(binding.repository, sourceText);
    const stepId = randomUUID();
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'github.collect_context.v1','tool',$4,'succeeded',$5,$6::jsonb,1,1,$7)`,
      [stepId, tenantId, runId, requestHash, fingerprint({ value: collected }), JSON.stringify({ value: collected }), createdAt]);
    const artifact = reviewArtifact();
    await adminPool.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json,created_at)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,$7::jsonb,$8)`,
      [fingerprint(`p3b-artifact:${runId}`), tenantId, binding.id, runId, headSha,
        fingerprint(artifact), JSON.stringify(artifact), createdAt]);
  }

  function reviewInput(binding: PublicationBinding) {
    const sourceKey = `p3b-source:${binding.id}`;
    return { schemaVersion: 1, workflow: "review.deep.v1", platform: "github",
      target: { origin, repository: binding.repository, number: 42, providerRepositoryId: binding.providerRepositoryId },
      source: { key: sourceKey, hash: fingerprint(sourceKey) }, revision: { baseSha, headSha }, mode: "report",
      trigger: "comment-command", options: { customRules: [], includeCiChecks: true, enableSecretScan: true,
        secretScanCustomPatterns: [], enableAutoLabel: false }, presentation: { title: "P3b fixture", body: "",
        author: "fixture", baseBranch: "main", headBranch: "feature", webUrl: `${origin}/${binding.repository}/pull/42`, draft: false } };
  }

  function collectedFixture(repository: string, sourceText: string) {
    return { input: { platform: "github", repository, number: 42, title: "P3b", body: "", author: "fixture",
      baseBranch: "main", headBranch: "feature", additions: 1, deletions: 0, changedFilesCount: 1,
      changedFiles: [{ newPath: "src/a.ts", oldPath: "src/a.ts", status: "modified", additions: 1, deletions: 0,
        extendedDiff: `+${sourceText}` }] }, files: [{ newPath: "src/a.ts", oldPath: "src/a.ts", status: "modified",
      patch: `@@ -0,0 +1 @@\n+${sourceText}\n`, additions: 1, deletions: 0, extendedDiff: `+${sourceText}`,
      oldLinesWithNumber: [], newLinesWithNumber: [[1, sourceText]] }], coverage: { status: "complete", reasonCodes: [] } };
  }

  function reviewArtifact() {
    return { schemaVersion: 1, summary: "p3b durable artifact", findings: [],
      sourceCoverage: { status: "complete", reasonCodes: [] } };
  }

  function fixtureAdapter(token: string): DatasetRepositoryAdapter {
    const files = new Map([["package.json", `{"name":"${token}-fixture"}\n`],
      ["src/a.ts", `export const ${token} = '${token} unique tokens one two three four five';\n`]]);
    return { listFiles: async () => [...files.keys()], readFile: async (path) => {
      const content = files.get(path); return content === undefined ? undefined
        : { path, mode: "100644", bytes: Buffer.from(content) }; }, readCiStatus: async () => ({ state: "success" }) };
  }

  function modelRequests(): string[] { return calls.filter(({ path }) => path === "/v1/chat/completions").map(({ body }) => body); }
  function formatErrors(errors: unknown[]): string { return errors.map((error) => error instanceof Error ? error.stack : String(error)).join("\n"); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

function pricing(): string {
  const model = { rates: { inputMicrosPerMillion: 1_000_000,
    cachedInputMicrosPerMillion: 1_000_000, cacheWriteInputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 1_000_000, thoughtOutputMicrosPerMillion: 1_000_000,
    toolInputMicrosPerMillion: 1_000_000 }, maxOutputTokens: 8_192,
    maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" };
  return JSON.stringify({ version: "p3b-tests", currency: "USD", periodKey: "p3b-tests",
    tenantLimits: { inputTokens: 5_000_000, outputTokens: 5_000_000, costMicros: 50_000_000 },
    runLimits: { inputTokens: 100_000, outputTokens: 50_000, costMicros: 5_000_000 },
    models: { "openai-compatible:p3b-model": model, "openai-compatible:p3b-drift-model": model } });
}

interface ModelRequestGate {
  started: Promise<void>;
  waitForRelease: Promise<void>;
  markStarted(): void;
  release(): void;
}

function createModelRequestGate(): ModelRequestGate {
  let markStarted = () => {}; let release = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
  return { started, waitForRelease, markStarted, release };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
