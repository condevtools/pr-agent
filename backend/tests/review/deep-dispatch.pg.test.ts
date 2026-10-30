import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore, type PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { ModelBudgetStore } from "../../src/agent-runtime/budget/model-budget-store.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { enqueueReviewRun } from "../../src/review/intake/run-intake.js";
import type { ReviewRunInput } from "../../src/review/intake/run-input.js";
import { RunWorker } from "../../src/agent-runtime/execution/run-worker.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { closeAgentRuntime } from "../../src/agent-runtime/runtime.js";
import { executeReviewRun } from "../../src/review/run.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Deep dispatch PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const adminDb = new RuntimeDatabase(adminPool);
  const role = `deep_dispatch_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID();
  const githubId = randomUUID();
  const gitlabId = randomUUID();
  const githubRepository = "acme/deep-dispatch";
  const gitlabRepository = "acme/deep-dispatch-gitlab";
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  let origin = "";
  let server: Server;
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  let execution: RunExecutionStore;
  let budget: ModelBudgetStore;
  let github: PublicationBinding;
  let gitlab: PublicationBinding;
  const calls: Array<{ method: string; path: string }> = [];
  let retryFixtureActive = false;
  let retryReadFailures = 0;

  before(async () => {
    server = createServer(async (request, response) => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      calls.push({ method, path });
      let body = "";
      for await (const chunk of request) body += chunk;
      if (method === "POST" && path === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } };
          messages?: Array<{ role?: string; content?: string }> };
        const name = parsed.response_format?.json_schema?.name;
        const prompt = JSON.parse(parsed.messages?.findLast(({ role }) => role === "user")?.content ?? "{}") as
          { evidence?: unknown[] };
        const content = retryFixtureActive && name === "deep_security_turn" && (prompt.evidence?.length ?? 0) === 0
          ? { action: "tool", request: { name: "read_file_range", path: "src/value.ts", startLine: 1, endLine: 2 } }
          : name === "deep_review_critic"
          ? { decisions: [] }
          : { action: "finish", candidates: [] };
        return json(response, 200, { id: `local-${randomUUID()}`, object: "chat.completion", created: 1,
          model: "deep-dispatch-model", choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
      }
      if (method === "GET" && path === "/repos/acme/deep-dispatch/pulls/42") {
        return json(response, 200, { id: 42, number: 42, title: "Zero diff", body: "", user: { login: "alice" },
          base: { ref: "main", sha: baseSha }, head: { ref: "feature", sha: headSha },
          additions: retryFixtureActive ? 1 : 0, deletions: retryFixtureActive ? 1 : 0,
          changed_files: retryFixtureActive ? 1 : 0, draft: false, html_url: `${origin}/acme/deep-dispatch/pull/42` });
      }
      if (method === "GET" && path === `/repos/acme/deep-dispatch/compare/${baseSha}...${headSha}`) {
        return json(response, 200, { files: retryFixtureActive ? [{ filename: "src/value.ts", status: "modified",
          additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }] : [] });
      }
      if (method === "GET" && path === `/repos/acme/deep-dispatch/git/trees/${headSha}?recursive=1`) {
        return json(response, 200, { truncated: false,
          tree: [{ path: "src/value.ts", mode: "100644", type: "blob" }] });
      }
      if (method === "GET" && path === `/repos/acme/deep-dispatch/contents/src/value.ts?ref=${headSha}`) {
        if (retryReadFailures++ === 0) return json(response, 500, { message: "transient fixture failure" });
        return json(response, 200, { type: "file", path: "src/value.ts", encoding: "base64",
          content: Buffer.from("export const value = 'new';\n").toString("base64"), size: 28 });
      }
      if (method === "GET" && path.startsWith(`/repos/acme/deep-dispatch/commits/${headSha}/check-runs`)) {
        return json(response, 200, { check_runs: [] });
      }
      if (method === "GET" && path === "/api/v4/projects/9090/merge_requests/42/changes") {
        return json(response, 200, { diff_refs: { base_sha: baseSha, head_sha: headSha }, changes: [] });
      }
      if (method === "GET" && path.startsWith(`/api/v4/projects/9090/repository/commits/${headSha}/statuses`)) {
        return json(response, 200, []);
      }
      return json(response, 404, { message: "fixture route not found" });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local dispatch fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;

    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await grantRuntime(adminPool, role);
    const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.GITHUB_API_URL = origin;
    process.env.GITLAB_BASE_URL = origin;
    process.env.GITHUB_TOKEN = "local-github-read-token";
    process.env.GITLAB_TOKEN = "local-gitlab-read-token";
    process.env.ALLOW_INSECURE_GITLAB_HTTP = "true";
    process.env.AI_PROVIDER = "openai-compatible";
    process.env.AI_MODEL = "deep-dispatch-model";
    process.env.OPENAI_BASE_URL = `${origin}/v1`;
    process.env.OPENAI_COMPATIBLE_API_KEY = "local-model-key";
    process.env.HARNESS_MODEL_PRICING_JSON = pricing();
    appPool = new Pool({ connectionString: appUrl.toString(), max: 16 });
    appDb = new RuntimeDatabase(appPool);
    execution = new RunExecutionStore(appDb, { leaseTtlMs: 60_000, initialRetryMs: 10, maxRetryMs: 100 });
    budget = new ModelBudgetStore(appDb);
    github = await bind(githubId, "github", githubRepository, 8080, "env:GITHUB_TOKEN");
    gitlab = await bind(gitlabId, "gitlab", gitlabRepository, 9090, "env:GITLAB_TOKEN");
  });

  after(async () => {
    await closeAgentRuntime();
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    await adminPool.end();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("GitHub production deep dispatch is fixed-revision read-only and leaves the old batch untouched", async () => {
    await assertProductionDispatch(github, "github", githubRepository);
  });

  test("GitLab production deep dispatch is fixed-revision read-only and leaves the old batch untouched", async () => {
    await assertProductionDispatch(gitlab, "gitlab", gitlabRepository);
  });

  test("GitHub deep read retries a transient provider failure without rerunning completed model steps", async () => {
    retryFixtureActive = true;
    retryReadFailures = 0;
    calls.length = 0;
    const runId = await enqueue(github, "github", githubRepository);
    const runtimeHash = await runRuntimeHash(runId);
    const errors: unknown[] = [];
    const storeErrors: unknown[] = [];
    const observedExecution = new Proxy(execution, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try { return await value.apply(target, args); }
        catch (error) { storeErrors.push(error); throw error; }
      };
    } });
    const worker = new RunWorker({ store: observedExecution, budget, bindings: async () => [github],
      runtimeHash: async () => runtimeHash, execute: executeReviewRun,
      onError: (error) => errors.push(error) }, 1);
    try {
      await worker.tick(); await worker.drain();
      assert.equal((await execution.load(tenantId, runId))?.status, "retry_wait");
      assert.equal(modelRequestCount(), 2, await failureDiagnostics(runId));
      assert.equal(retryReadFailures, 1);

      await adminPool.query("UPDATE pr_agent_harness.job_queue SET available_at=now() WHERE tenant_id=$1 AND run_id=$2",
        [tenantId, runId]);
      await worker.tick(); await worker.drain();

      assert.equal((await execution.load(tenantId, runId))?.status, "succeeded",
        `${[...errors, ...storeErrors].map((error) => error instanceof Error ? error.stack ?? error.message : String(error)).join("\n")}\n` +
        await failureDiagnostics(runId));
      assert.equal(retryReadFailures, 2);
      assert.equal(modelRequestCount(), 4, await failureDiagnostics(runId));
      const ledger = await appDb.transaction(tenantId, async (client) => {
        const modelCalls = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pr_agent_harness.model_calls WHERE tenant_id=$1 AND run_id=$2",
          [tenantId, runId]);
        const peerAttempts = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pr_agent_harness.step_attempts a
           JOIN pr_agent_harness.agent_steps s ON s.tenant_id=a.tenant_id AND s.run_id=a.run_id AND s.id=a.step_id
           WHERE s.tenant_id=$1 AND s.run_id=$2 AND s.step_key='deep.role.correctness.turn.1'`, [tenantId, runId]);
        return { modelCalls: Number(modelCalls.rows[0]!.count), peerAttempts: Number(peerAttempts.rows[0]!.count) };
      });
      assert.deepEqual(ledger, { modelCalls: 4, peerAttempts: 1 });
      assert.ok(errors.some((error) => error instanceof Error && error.name === "ProviderHttpError"));
    } finally {
      retryFixtureActive = false;
    }
  });

  async function assertProductionDispatch(binding: PublicationBinding, platform: "github" | "gitlab", repository: string) {
    const baseline = await publicationCounts(binding.id);
    calls.length = 0;
    const runId = await enqueue(binding, platform, repository);
    const runtimeHash = await appDb.transaction(tenantId, async (client) => (await client.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId])).rows[0]!.runtime_version_hash);
    const errors: unknown[] = [];
    const worker = new RunWorker({ store: execution, budget, bindings: async () => [binding],
      runtimeHash: async () => runtimeHash, execute: async (lease, activeBinding) => {
        assert.equal(lease.headSha, headSha);
        assert.equal(activeBinding.providerRepositoryId, platform === "github" ? 8080 : 9090);
        await executeReviewRun(lease, activeBinding);
      }, onError: (error) => errors.push(error) }, 1);
    await worker.tick(); await worker.drain();
    const diagnostics = errors.length === 0 ? "" : await failureDiagnostics(runId);
    assert.equal(errors.length, 0, `${errors.map((error) => error instanceof Error
      ? error.stack ?? `${error.name}:${error.message}` : String(error)).join(",")}\n${diagnostics}`);
    assert.equal((await execution.load(tenantId, runId))?.status, "succeeded");
    const artifact = await appDb.transaction(tenantId, (client) => client.query<{ workflow_id: string; publication_mode: string }>(
      "SELECT workflow_id,publication_mode FROM pr_agent_harness.review_artifacts WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId]));
    assert.deepEqual(artifact.rows[0], { workflow_id: "review.deep.v1", publication_mode: "shadow" });
    assert.deepEqual(await publicationCounts(binding.id), baseline);
    const providerWrites = calls.filter(({ method, path }) => !path.startsWith("/v1/") && !["GET", "HEAD"].includes(method));
    assert.deepEqual(providerWrites, []);
    assert.ok(calls.some(({ method, path }) => method === "POST" && path === "/v1/chat/completions"));
    if (platform === "github") assert.ok(calls.some(({ path }) => path.includes(`compare/${baseSha}...${headSha}`)));
    else assert.ok(calls.some(({ path }) => path.includes("merge_requests/42/changes")));
  }

  async function bind(id: string, platform: "github" | "gitlab", repository: string, repositoryId: number,
    credentialRef: "env:GITHUB_TOKEN" | "env:GITLAB_TOKEN") {
    const runs = new RunStore(adminDb);
    const authority = new PublicationAuthorityStore(adminDb);
    await runs.registerIntegration({ tenantId, id, platform, origin, repository });
    await authority.configure({ tenantId, integrationId: id, providerRepositoryId: repositoryId, providerActorId: 99,
      credentialRef, expectedVersion: 0 });
    let value = await authority.transition({ tenantId, integrationId: id, expectedVersion: 1, action: "activate",
      actor: "dispatch-test", actorType: "service", quiescenceEvidence: "isolated local provider" });
    assert.equal(value.reviewExecutionMode, "harness_async");
    assert.equal(value.reviewExecutionState, "active");
    assert.equal(value.executionModeGeneration, 1);
    return value;
  }

  async function enqueue(binding: PublicationBinding, platform: "github" | "gitlab", repository: string) {
    const input: ReviewRunInput = { schemaVersion: 1, workflow: "review.deep.v1", platform,
      target: { origin, repository, number: 42, providerRepositoryId: platform === "github" ? 8080 : 9090 },
      source: { key: `dispatch:${platform}:${randomUUID()}`, hash: hash(`dispatch:${platform}:${randomUUID()}`) },
      revision: { baseSha, headSha }, mode: "report", trigger: "comment-command",
      options: { customRules: [], includeCiChecks: true, enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Zero diff", body: "", author: "alice", baseBranch: "main", headBranch: "feature",
        webUrl: `${origin}/${repository}/42`, draft: false } };
    return (await enqueueReviewRun(binding, input)).id;
  }

  async function publicationCounts(integrationId: string) {
    return appDb.transaction(tenantId, async (client) => {
      const operations = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pr_agent_harness.repository_operations WHERE tenant_id=$1 AND integration_id=$2",
        [tenantId, integrationId]);
      const batches = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pr_agent_harness.publication_batches WHERE tenant_id=$1 AND integration_id=$2",
        [tenantId, integrationId]);
      return { operations: Number(operations.rows[0]!.count), batches: Number(batches.rows[0]!.count) };
    });
  }

  async function runRuntimeHash(runId: string): Promise<string> {
    return appDb.transaction(tenantId, async (client) => (await client.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
      [tenantId, runId])).rows[0]!.runtime_version_hash);
  }

  function modelRequestCount(): number {
    return calls.filter(({ method, path }) => method === "POST" && path === "/v1/chat/completions").length;
  }

  async function failureDiagnostics(runId: string): Promise<string> {
    return appDb.transaction(tenantId, async (client) => {
      const steps = await client.query<{ step_key: string; status: string; output_json: unknown }>(
        `SELECT step_key,status,output_json FROM pr_agent_harness.agent_steps
         WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at`, [tenantId, runId]);
      const models = await client.query<{ status: string; error_code: string | null }>(
        `SELECT status,error_code FROM pr_agent_harness.model_calls
         WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at`, [tenantId, runId]);
      return JSON.stringify({ steps: steps.rows, models: models.rows, calls }, null, 2);
    });
  }
}

function pricing(): string {
  return JSON.stringify({ version: "deep-dispatch-v1", currency: "USD", periodKey: "deep-dispatch-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    // The 30% security partition must admit two strict-schema wire requests (~14.1k conservative bytes).
    runLimits: { inputTokens: 48_000, outputTokens: 12_000, costMicros: 0 },
    models: { "openai-compatible:deep-dispatch-model": { rates: { inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 }, maxOutputTokens: 4_096,
      maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } } });
}

async function grantRuntime(pool: Pool, role: string): Promise<void> {
  await pool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role};
    GRANT SELECT ON pr_agent_harness.integration_bindings TO ${role};
    GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.agent_runs,pr_agent_harness.job_queue,
      pr_agent_harness.repository_operations,pr_agent_harness.publication_slots,pr_agent_harness.publication_batches TO ${role};
    GRANT SELECT,INSERT ON pr_agent_harness.publication_batch_operations,pr_agent_harness.run_events,
      pr_agent_harness.audit_logs,pr_agent_harness.publication_command_receipts TO ${role};
    REVOKE UPDATE,DELETE ON pr_agent_harness.publication_batch_operations FROM ${role};
    GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint),
      pr_agent_harness.skip_failed_batch_successors(uuid,uuid),
      pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
      pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${role};
    GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.agent_steps,pr_agent_harness.step_attempts,
      pr_agent_harness.tool_calls,pr_agent_harness.model_calls,pr_agent_harness.tenant_budget_accounts,
      pr_agent_harness.run_budget_envelopes,pr_agent_harness.model_budget_reservations,
      pr_agent_harness.run_command_receipts,pr_agent_harness.run_waits TO ${role};
    GRANT SELECT,INSERT ON pr_agent_harness.checkpoints,pr_agent_harness.run_publication_batches,
      pr_agent_harness.dead_letter_jobs,pr_agent_harness.usage_records,pr_agent_harness.model_pricing_snapshots,
      pr_agent_harness.run_wait_decisions,pr_agent_harness.evidence_records,pr_agent_harness.finding_candidates,
      pr_agent_harness.finding_decisions,pr_agent_harness.review_artifacts TO ${role};
    GRANT SELECT ON pr_agent_harness.evolution_release_assignments,
      pr_agent_harness.evolution_release_qualifications,pr_agent_harness.evolution_candidates,
      pr_agent_harness.evolution_proposal_sources,pr_agent_harness.eval_runs,pr_agent_harness.eval_results,
      pr_agent_harness.eval_cases,pr_agent_harness.trusted_review_label_sets,
      pr_agent_harness.evolution_release_receipts,pr_agent_harness.evolution_run_assignments TO ${role};
    GRANT INSERT (tenant_id,integration_id,run_id,assignment_version,routing,selection,bucket,candidate_id,
      qualification_id,release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
      ON pr_agent_harness.evolution_run_assignments TO ${role};
    GRANT UPDATE (updated_at) ON pr_agent_harness.evolution_release_assignments TO ${role}`);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
