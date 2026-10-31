import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore, type PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { ModelBudgetExceededError, ModelBudgetStore } from "../../src/agent-runtime/budget/model-budget-store.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { RunWorker } from "../../src/agent-runtime/execution/run-worker.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { PgPublicationStore } from "../../src/agent-runtime/publication/publication.js";
import { closeAgentRuntime } from "../../src/agent-runtime/runtime.js";
import { publicationRuntimeForBinding } from "../../src/agent-runtime/runtime/publication.js";
import type { GitHubIssueIdentity } from "../../src/integrations/github/issues/identity.js";
import { handlePlainGitHubWebhook } from "../../src/integrations/github/webhooks/handler.js";
import { enqueueIssueTriage, IssueTriageRateLimitError } from "../../src/issues/triage/intake.js";
import { executeIssueTriageRun } from "../../src/issues/triage/run.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Issue triage PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const roleName = `issue_triage_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const repository = "acme/issue-triage";
  const providerRepositoryId = 4242;
  let origin: string;
  let server: Server;
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  let executionStore: RunExecutionStore;
  let budget: ModelBudgetStore;
  let binding: PublicationBinding;
  const calls: string[] = [];
  const postedComments: string[] = [];
  const postedLabels: string[][] = [];
  const storedComments: Array<{ issueNumber: number; id: number; body: string; user: { id: number } }> = [];
  const actualLabels = new Map<number, string[]>();
  const currentIssues = new Map<number, GitHubIssueIdentity>();
  let modelMode: "valid" | "invalid" = "valid";
  let policyText: string | undefined;
  let managedCommentFailures = 0;
  let commentResponseLosses = 0;
  const plainWebhookSecret = "issue-triage-plain-webhook-secret";

  before(async () => {
    server = createServer(async (request, response) => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      calls.push(`${method} ${path}`);
      const body = await readBody(request);
      if (method === "POST" && path === "/v1/chat/completions") {
        const content = modelMode === "valid"
          ? { summary: "The report is actionable", feasibility: { level: "medium", reason: "Needs a reproduction" },
            risks: ["The trigger is not isolated"], actions: ["Add a minimal reproduction"] }
          : { unexpected: true };
        return json(response, 200, { id: "chatcmpl-issue-triage", object: "chat.completion", created: 1,
          model: "fixture-model", choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
      }
      if (method === "GET" && path === "/user") return json(response, 200, { id: 4343, login: "pr-agent", type: "Bot" });
      if (method === "GET" && path === "/repos/acme/issue-triage") {
        return json(response, 200, { id: providerRepositoryId, full_name: repository });
      }
      const issueMatch = path.match(/^\/repos\/acme\/issue-triage\/issues\/(\d+)$/u);
      if (method === "GET" && issueMatch) {
        const issue = currentIssues.get(Number(issueMatch[1]));
        const issueNumber = Number(issueMatch[1]);
        return issue ? json(response, 200, { ...issue,
          html_url: `https://github.com/acme/issue-triage/issues/${issueNumber}`,
          labels: (actualLabels.get(issueNumber) ?? []).map((name) => ({ name })) })
          : json(response, 404, { message: "not found" });
      }
      if (method === "GET" && path.startsWith("/repos/acme/issue-triage/issues?")) {
        return json(response, 200, [...currentIssues.values()].map((issue) => ({ ...issue,
          updated_at: "2026-10-31T00:00:00Z",
          html_url: `https://github.com/acme/issue-triage/issues/${issue.number}`,
          labels: (actualLabels.get(issue.number) ?? []).map((name) => ({ name })) })));
      }
      if (method === "GET" && path.startsWith("/repos/acme/issue-triage/labels?")) {
        return json(response, 200, [{ name: "Bug" }, { name: "Security" }, { name: "ai-triaged" },
          { name: "has-similar-issue" }]);
      }
      if (method === "GET" && path.includes("/contents/")) {
        if (!policyText) return json(response, 404, { message: "not found" });
        return json(response, 200, { type: "file", encoding: "base64",
          content: Buffer.from(policyText).toString("base64") });
      }
      const commentsMatch = path.match(/^\/repos\/acme\/issue-triage\/issues\/(\d+)\/comments\?/u);
      if (method === "GET" && commentsMatch) {
        if (managedCommentFailures > 0) {
          managedCommentFailures -= 1;
          return json(response, 503, { message: "transient managed-comment lookup failure" });
        }
        return json(response, 200, storedComments.filter(({ issueNumber }) => issueNumber === Number(commentsMatch[1])));
      }
      const labelsMatch = path.match(/^\/repos\/acme\/issue-triage\/issues\/(\d+)\/labels$/u);
      if (method === "POST" && labelsMatch) {
        const labels = (JSON.parse(body) as { labels: string[] }).labels;
        postedLabels.push(labels); actualLabels.set(Number(labelsMatch[1]), labels);
        return json(response, 200, labels.map((name) => ({ name })));
      }
      const createCommentMatch = path.match(/^\/repos\/acme\/issue-triage\/issues\/(\d+)\/comments$/u);
      if (method === "POST" && createCommentMatch) {
        const commentBody = (JSON.parse(body) as { body: string }).body;
        const id = 9001 + postedComments.length;
        postedComments.push(commentBody);
        storedComments.push({ issueNumber: Number(createCommentMatch[1]), id, body: commentBody, user: { id: 4343 } });
        if (commentResponseLosses > 0) {
          commentResponseLosses -= 1;
          response.socket?.destroy();
          return;
        }
        return json(response, 201, { id });
      }
      return json(response, 404, { message: "fixture route not found" });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local fixture server did not bind");
    origin = `http://127.0.0.1:${address.port}`;

    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await adminPool.query(`
      GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName};
      GRANT SELECT ON pr_agent_harness.integration_bindings TO ${roleName};
      GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.agent_runs,pr_agent_harness.job_queue,
        pr_agent_harness.agent_steps,pr_agent_harness.step_attempts,pr_agent_harness.tool_calls,
        pr_agent_harness.model_calls,pr_agent_harness.tenant_budget_accounts,
        pr_agent_harness.run_budget_envelopes,pr_agent_harness.model_budget_reservations,
        pr_agent_harness.command_rate_limits,pr_agent_harness.repository_operations,
        pr_agent_harness.publication_slots,pr_agent_harness.publication_batches TO ${roleName};
      GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.run_command_receipts,
        pr_agent_harness.run_waits TO ${roleName};
      GRANT SELECT,INSERT ON pr_agent_harness.publication_batch_operations,pr_agent_harness.run_events,
        pr_agent_harness.audit_logs,pr_agent_harness.checkpoints,pr_agent_harness.run_publication_batches,
        pr_agent_harness.dead_letter_jobs,pr_agent_harness.usage_records,
        pr_agent_harness.model_pricing_snapshots,pr_agent_harness.run_artifacts,
        pr_agent_harness.publication_command_receipts,pr_agent_harness.run_wait_decisions TO ${roleName};
      GRANT SELECT ON pr_agent_harness.evolution_release_assignments,
        pr_agent_harness.evolution_release_qualifications,pr_agent_harness.evolution_candidates,
        pr_agent_harness.evolution_proposal_sources,pr_agent_harness.eval_runs,pr_agent_harness.eval_results,
        pr_agent_harness.eval_cases,pr_agent_harness.trusted_review_label_sets,
        pr_agent_harness.evolution_release_receipts,pr_agent_harness.evolution_run_assignments TO ${roleName};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint),
        pr_agent_harness.lock_dispatchable_publication_authority(uuid,uuid,text,text,text,bigint),
        pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.lock_current_binding_capability(uuid,uuid,text),
        pr_agent_harness.skip_failed_batch_successors(uuid,uuid),
        pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
        pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${roleName};
    `);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName; appUrl.password = rolePassword;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 10 });
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.HARNESS_PG_USER = roleName;
    process.env.HARNESS_PG_PASSWORD = rolePassword;
    process.env.GITHUB_TOKEN = "ghp_local_issue_triage_only";
    process.env.GITHUB_WEBHOOK_TOKEN = "ghp_local_plain_webhook_only";
    process.env.GITHUB_WEBHOOK_SECRET = plainWebhookSecret;
    process.env.GITHUB_HTTP_RETRIES = "0";
    process.env.GITHUB_API_URL = origin;
    process.env.FEATURE_ISSUE_TRIAGE = "on";
    process.env.AI_PROVIDER = "openai-compatible";
    process.env.AI_MODEL = "fixture-model";
    process.env.OPENAI_BASE_URL = `${origin}/v1`;
    process.env.OPENAI_COMPATIBLE_API_KEY = "local-fixture-key";
    process.env.HARNESS_MODEL_PRICING_JSON = pricingJson();
    appDb = new RuntimeDatabase(appPool);
    executionStore = new RunExecutionStore(appDb, { leaseTtlMs: 60_000, initialRetryMs: 10, maxRetryMs: 20 });
    budget = new ModelBudgetStore(appDb);

    const runs = new RunStore(new RuntimeDatabase(adminPool));
    const authority = new PublicationAuthorityStore(new RuntimeDatabase(adminPool));
    await runs.registerIntegration({ tenantId, id: integrationId, platform: "github", origin, repository });
    await authority.configure({ tenantId, integrationId, providerRepositoryId, providerActorId: 4343,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    binding = await authority.transition({ tenantId, integrationId, expectedVersion: 1, action: "activate",
      actor: "issue-triage-test", actorType: "service", quiescenceEvidence: "isolated Docker fixture" });
    await adminPool.query(`UPDATE pr_agent_harness.integration_bindings
      SET review_execution_mode='harness_async',execution_mode_generation=1 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, integrationId]);
    binding = { ...binding, reviewExecutionMode: "harness_async", executionModeGeneration: 1 };
  });

  after(async () => {
    await closeAgentRuntime();
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await adminPool.end();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("production worker budgets one content revision and publishes one comment plus existing labels", async () => {
    const issue = fixtureIssue(42, 1042, 7001, "Security bug: token refresh fails");
    currentIssues.set(issue.number, issue);
    const [firstDelivery, duplicateDelivery] = await Promise.all([
      signedIssueIntake(issue, "issue-delivery-1"), signedIssueIntake(issue, "issue-delivery-2"),
    ]);
    assert.deepEqual([firstDelivery.ok, duplicateDelivery.ok], [true, true]);
    assert.ok([firstDelivery.message, duplicateDelivery.message].some((message) => /queued/u.test(message)));
    assert.ok([firstDelivery.message, duplicateDelivery.message].some((message) => /already queued or analyzed/u.test(message)));
    const first = await runForIssue(issue.id);
    const beforeModel = countCalls("POST /v1/chat/completions");
    assert.deepEqual(await run(first.id), []);
    assert.equal((await executionStore.load(tenantId, first.id))?.status, "succeeded");
    assert.equal((await executionStore.load(tenantId, first.id))?.outcomeCode, "issue_triage_completed");
    assert.equal(countCalls("POST /v1/chat/completions") - beforeModel, 1);
    assert.equal(postedComments.length, 1); assert.match(postedComments[0]!, /## AI Issue Triage/u);
    assert.deepEqual(postedLabels, [["Bug", "Security", "ai-triaged"]]);
    const evidence = await adminPool.query<{ runs: string; models: string; batches: string; operations: string }>(`
      SELECT (SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2) runs,
        (SELECT count(*) FROM pr_agent_harness.model_calls WHERE tenant_id=$1 AND run_id=$2) models,
        (SELECT count(*) FROM pr_agent_harness.run_publication_batches WHERE tenant_id=$1 AND run_id=$2) batches,
        (SELECT count(*) FROM pr_agent_harness.repository_operations ro JOIN pr_agent_harness.run_publication_batches rpb
          ON rpb.tenant_id=ro.tenant_id JOIN pr_agent_harness.publication_batch_operations pbo
          ON pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id AND pbo.business_operation_id=ro.business_operation_id
          WHERE rpb.run_id=$2 AND ro.status='succeeded') operations`, [tenantId, first.id]);
    assert.deepEqual(evidence.rows[0], { runs: "1", models: "1", batches: "1", operations: "2" });
    assert.deepEqual(await admissionEvidence(issue.user.id),
      { repositoryCount: 1, authorCount: 1, runs: "1", jobs: "1", budgets: "1" });
    await run(first.id);
    assert.equal(countCalls("POST /v1/chat/completions") - beforeModel, 1);
    assert.equal(postedComments.length, 1);
  });

  test("publication planning retry reuses the successful model checkpoint before freezing the batch", async () => {
    const issue = fixtureIssue(46, 1046, 7005, "Retry publication without repeating analysis");
    currentIssues.set(issue.number, issue);
    const queued = await enqueueIssueTriage(binding, issue, false);
    const modelBefore = countCalls("POST /v1/chat/completions");
    managedCommentFailures = 1;
    const firstErrors = await run(queued.id);
    assert.equal(firstErrors.length, 1);
    assert.equal(countCalls("POST /v1/chat/completions") - modelBefore, 1);
    assert.equal((await executionStore.load(tenantId, queued.id))?.status, "retry_wait");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(await run(queued.id), []);
    assert.equal((await executionStore.load(tenantId, queued.id))?.status, "succeeded");
    assert.equal(countCalls("POST /v1/chat/completions") - modelBefore, 1);
    const frozen = await adminPool.query<{ batches: string; models: string }>(`
      SELECT (SELECT count(*) FROM pr_agent_harness.run_publication_batches WHERE tenant_id=$1 AND run_id=$2) batches,
        (SELECT count(*) FROM pr_agent_harness.model_calls WHERE tenant_id=$1 AND run_id=$2) models`,
    [tenantId, queued.id]);
    assert.deepEqual(frozen.rows[0], { batches: "1", models: "1" });
  });

  test("reconciliation finds a remotely accepted comment after its socket response is lost", async () => {
    const issue = fixtureIssue(47, 1047, 7006, "Reconcile an accepted remote comment");
    currentIssues.set(issue.number, issue);
    const queued = await enqueueIssueTriage(binding, issue, false);
    const modelBefore = countCalls("POST /v1/chat/completions");
    const commentsBefore = postedComments.length;
    commentResponseLosses = 1;
    const errors = await run(queued.id);
    assert.equal(errors.length, 1);
    assert.equal((await executionStore.load(tenantId, queued.id))?.status, "waiting_for_reconciliation");
    assert.equal(postedComments.length, commentsBefore + 1);
    assert.equal(countCalls("POST /v1/chat/completions") - modelBefore, 1);
    const operationRow = await adminPool.query<{ business_operation_id: string; status: string }>(`
      SELECT ro.business_operation_id,ro.status FROM pr_agent_harness.repository_operations ro
      JOIN pr_agent_harness.publication_batch_operations pbo
        ON pbo.tenant_id=ro.tenant_id AND pbo.business_operation_id=ro.business_operation_id
      JOIN pr_agent_harness.run_publication_batches rpb
        ON rpb.tenant_id=pbo.tenant_id AND rpb.batch_id=pbo.batch_id
      WHERE rpb.tenant_id=$1 AND rpb.run_id=$2`, [tenantId, queued.id]);
    assert.equal(operationRow.rowCount, 1);
    assert.equal(operationRow.rows[0]!.status, "unknown");
    const runtime = await publicationRuntimeForBinding(binding);
    const store = new PgPublicationStore(appDb);
    const operation = await store.get(tenantId, operationRow.rows[0]!.business_operation_id);
    assert.ok(operation);
    const reconciled = await runtime.service.reconcileOperation(tenantId, operation.businessOperationId,
      await runtime.createAdapter(operation));
    assert.equal(reconciled.remoteId, String(storedComments.at(-1)!.id));
    assert.equal((await store.get(tenantId, operation.businessOperationId))?.status, "succeeded");
    assert.equal(postedComments.length, commentsBefore + 1);
    assert.equal(countCalls("POST /v1/chat/completions") - modelBefore, 1);
  });

  test("stale content fails before model or publication", async () => {
    const issue = fixtureIssue(43, 1043, 7002, "Original timeout");
    currentIssues.set(issue.number, issue);
    const queued = await enqueueIssueTriage(binding, issue, true);
    currentIssues.set(issue.number, { ...issue, title: "Changed after intake" });
    const modelBefore = countCalls("POST /v1/chat/completions");
    const commentsBefore = postedComments.length;
    await run(queued.id);
    const snapshot = await executionStore.load(tenantId, queued.id);
    assert.equal(snapshot?.status, "failed"); assert.equal(snapshot?.errorCode, "StalePublicationError");
    assert.equal(countCalls("POST /v1/chat/completions"), modelBefore);
    assert.equal(postedComments.length, commentsBefore);
  });

  test("invalid structured model output never reaches publication", async () => {
    const issue = fixtureIssue(44, 1044, 7003, "Invalid model response");
    currentIssues.set(issue.number, issue); modelMode = "invalid";
    const queued = await enqueueIssueTriage(binding, issue, true);
    const commentsBefore = postedComments.length;
    try { await run(queued.id); } finally { modelMode = "valid"; }
    assert.notEqual((await executionStore.load(tenantId, queued.id))?.status, "succeeded");
    assert.equal(postedComments.length, commentsBefore);
  });

  test("repository policy disablement stops before model and publication", async () => {
    const issue = fixtureIssue(45, 1045, 7004, "Disabled triage");
    currentIssues.set(issue.number, issue); policyText = "issue:\n  triageEnabled: false\n";
    const queued = await enqueueIssueTriage(binding, issue, true);
    const modelBefore = countCalls("POST /v1/chat/completions");
    const commentsBefore = postedComments.length;
    try { await run(queued.id); } finally { policyText = undefined; }
    assert.equal((await executionStore.load(tenantId, queued.id))?.status, "failed");
    assert.equal(countCalls("POST /v1/chat/completions"), modelBefore);
    assert.equal(postedComments.length, commentsBefore);
  });

  test("author admission limit rolls back the denied Run, counters, job and budget", async () => {
    const authorId = 9090;
    const created: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const issue = fixtureIssue(100 + index, 2000 + index, authorId, `Rate limited revision ${index}`);
      currentIssues.set(issue.number, issue);
      created.push((await enqueueIssueTriage(binding, issue, false)).id);
    }
    const denied = fixtureIssue(111, 2011, authorId, "Eleventh revision");
    currentIssues.set(denied.number, denied);
    await assert.rejects(enqueueIssueTriage(binding, denied, false), IssueTriageRateLimitError);
    const counts = await adminPool.query<{ runs: string; jobs: string; budgets: string; author_count: number }>(`
      SELECT (SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=ANY($2::uuid[])) runs,
        (SELECT count(*) FROM pr_agent_harness.job_queue WHERE tenant_id=$1 AND run_id=ANY($2::uuid[])) jobs,
        (SELECT count(*) FROM pr_agent_harness.run_budget_envelopes WHERE tenant_id=$1 AND run_id=ANY($2::uuid[])) budgets,
        (SELECT request_count FROM pr_agent_harness.command_rate_limits WHERE tenant_id=$1 AND integration_id=$3
          AND scope_key=$4) author_count`,
    [tenantId, created, integrationId, `issue-triage:author:${authorId}`]);
    assert.deepEqual(counts.rows[0], { runs: "10", jobs: "10", budgets: "10", author_count: 10 });
    const deniedRows = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND input_json->'issue'->>'id'=$2",
      [tenantId, String(denied.id)]);
    assert.equal(deniedRows.rows[0]?.count, "0");
  });

  test("budget denial rolls back the Run, job and both admission counters", async () => {
    const issue = fixtureIssue(112, 2012, 9191, "Budget-denied revision");
    currentIssues.set(issue.number, issue);
    const before = await admissionEvidence(issue.user.id);
    await adminPool.query(`UPDATE pr_agent_harness.tenant_budget_accounts SET overdrawn=true
      WHERE tenant_id=$1`, [tenantId]);
    try {
      await assert.rejects(enqueueIssueTriage(binding, issue, false), ModelBudgetExceededError);
    } finally {
      await adminPool.query(`UPDATE pr_agent_harness.tenant_budget_accounts SET overdrawn=false
        WHERE tenant_id=$1`, [tenantId]);
    }
    assert.deepEqual(await admissionEvidence(issue.user.id), before);
    const deniedRows = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND input_json->'issue'->>'id'=$2",
      [tenantId, String(issue.id)]);
    assert.equal(deniedRows.rows[0]?.count, "0");
  });

  test("repository admission limit rejects the thirty-first revision atomically", async () => {
    const current = await adminPool.query<{ request_count: number }>(`SELECT request_count
      FROM pr_agent_harness.command_rate_limits WHERE tenant_id=$1 AND integration_id=$2
        AND scope_key='issue-triage:repository'`, [tenantId, integrationId]);
    const remaining = 30 - (current.rows[0]?.request_count ?? 0);
    for (let index = 0; index < remaining; index += 1) {
      const issue = fixtureIssue(200 + index, 3000 + index, 10_000 + index, `Repository revision ${index}`);
      currentIssues.set(issue.number, issue);
      await enqueueIssueTriage(binding, issue, false);
    }
    const denied = fixtureIssue(999, 9999, 99_999, "Repository limit exceeded");
    currentIssues.set(denied.number, denied);
    await assert.rejects(enqueueIssueTriage(binding, denied, false), IssueTriageRateLimitError);
    const evidence = await admissionEvidence(denied.user.id);
    assert.deepEqual(evidence, { repositoryCount: 30, authorCount: null, runs: "30", jobs: "30", budgets: "30" });
    const deniedRows = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND input_json->'issue'->>'id'=$2",
      [tenantId, String(denied.id)]);
    assert.equal(deniedRows.rows[0]?.count, "0");
  });

  async function run(runId: string): Promise<unknown[]> {
    const pinned = await adminPool.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId]);
    const errors: unknown[] = [];
    const worker = new RunWorker({ store: executionStore, budget, bindings: async () => [binding],
      runtimeHash: async () => pinned.rows[0]!.runtime_version_hash,
      supportedWorkflows: () => ["issue.triage.v1"], execute: executeIssueTriageRun,
      onError: (error) => { errors.push(error); } }, 1);
    await worker.tick(); await worker.drain();
    return errors;
  }

  async function signedIssueIntake(issue: GitHubIssueIdentity, deliveryId: string) {
    const payload = { action: "opened", sender: { login: issue.user.login, type: issue.user.type },
      repository: { id: providerRepositoryId, name: "issue-triage", owner: { login: "acme" } }, issue };
    const rawBody = JSON.stringify(payload);
    return handlePlainGitHubWebhook({ payload, rawBody, headers: { "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", plainWebhookSecret).update(rawBody).digest("hex")}` },
    logger: { info() {}, error() {} } });
  }

  async function runForIssue(issueId: number): Promise<{ id: string }> {
    const result = await adminPool.query<{ id: string }>(`SELECT id FROM pr_agent_harness.agent_runs
      WHERE tenant_id=$1 AND run_type='issue.triage.v1' AND input_json->'issue'->>'id'=$2`,
    [tenantId, String(issueId)]);
    assert.equal(result.rowCount, 1);
    return result.rows[0]!;
  }

  function countCalls(prefix: string): number { return calls.filter((call) => call.startsWith(prefix)).length; }

  async function admissionEvidence(authorId: number): Promise<{
    repositoryCount: number | null; authorCount: number | null; runs: string; jobs: string; budgets: string;
  }> {
    const result = await adminPool.query<{ repository_count: number | null; author_count: number | null;
      runs: string; jobs: string; budgets: string }>(`
      SELECT (SELECT request_count FROM pr_agent_harness.command_rate_limits
          WHERE tenant_id=$1 AND integration_id=$2 AND scope_key='issue-triage:repository') repository_count,
        (SELECT request_count FROM pr_agent_harness.command_rate_limits
          WHERE tenant_id=$1 AND integration_id=$2 AND scope_key=$3) author_count,
        (SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND run_type='issue.triage.v1') runs,
        (SELECT count(*) FROM pr_agent_harness.job_queue jq JOIN pr_agent_harness.agent_runs ar
          ON ar.tenant_id=jq.tenant_id AND ar.id=jq.run_id
          WHERE ar.tenant_id=$1 AND ar.run_type='issue.triage.v1') jobs,
        (SELECT count(*) FROM pr_agent_harness.run_budget_envelopes rbe JOIN pr_agent_harness.agent_runs ar
          ON ar.tenant_id=rbe.tenant_id AND ar.id=rbe.run_id
          WHERE ar.tenant_id=$1 AND ar.run_type='issue.triage.v1') budgets`,
    [tenantId, integrationId, `issue-triage:author:${authorId}`]);
    const row = result.rows[0]!;
    return { repositoryCount: row.repository_count, authorCount: row.author_count,
      runs: row.runs, jobs: row.jobs, budgets: row.budgets };
  }
}

function fixtureIssue(number: number, id: number, authorId: number, title: string): GitHubIssueIdentity {
  return { id, number, title, body: "Please investigate and add a regression test.", state: "open",
    user: { id: authorId, login: `author-${authorId}`, type: "User" } };
}

function pricingJson(): string {
  return JSON.stringify({ version: "issue-triage-zero-price-v1", currency: "USD", periodKey: "issue-triage-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 20_000, outputTokens: 10_000, costMicros: 0 },
    models: { "openai-compatible:fixture-model": { rates: { inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 }, maxOutputTokens: 4_096,
      maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } } });
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
