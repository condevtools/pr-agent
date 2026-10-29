import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { expectedSandboxPolicyHash } from "../src/fix/sandbox-policy.js";
import type { FixProposal, VerificationResult } from "../src/fix/contracts.js";
import { PublicationAuthorityStore, type PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import { getModelExecutionPolicy, ModelBudgetStore } from "../src/agent-runtime/budget/model-budget-store.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import { RunWorker } from "../src/agent-runtime/execution/run-worker.js";
import { RunExecutionStore } from "../src/agent-runtime/execution/store.js";
import { closeAgentRuntime } from "../src/agent-runtime/runtime.js";
import { runtimeVersionManifest, fingerprint } from "../src/agent-runtime/versions.js";
import { executeReviewRun } from "../src/review/run.js";
import type { ReviewRunInput } from "../src/review/intake/run-input.js";
import type { RunPrincipal } from "../src/agent-runtime/runs/control-contracts.js";
import { RunsService } from "../src/modules/harness/runs.service.js";
import { resolveModelConfiguration } from "../src/review/ai-reviewer.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Fix dispatch PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("fix dispatch requires a disposable database");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const adminDb = new RuntimeDatabase(adminPool);
  const appPassword = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const sourceRunId = randomUUID();
  const findingId = fingerprint("fix-dispatch-finding");
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const repository = "acme/fix-dispatch";
  const imageDigest = `sha256:${"c".repeat(64)}`;
  const lockContent = "{\"lockfileVersion\":3}\n";
  const sourceContent = "export function divide(a, b) { return a / b; }\n";
  const existingTest = "import test from 'node:test';\ntest('existing', () => {});\n";
  const principal: RunPrincipal = { subjectId: "maker", actorType: "user", tenantId, integrationId,
    permissions: ["fixes:create", "runs:read", "runs:trace"] };
  const calls: Array<{ method: string; path: string }> = [];
  let origin = "";
  let server: Server;
  let snapshotRoot = "";
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  let binding: PublicationBinding;
  let service: RunsService;

  before(async () => {
    snapshotRoot = await mkdtemp(join(tmpdir(), "pr-agent-fix-dispatch-"));
    server = createServer(async (request, response) => {
      const method = request.method ?? "GET"; const path = request.url ?? "/";
      calls.push({ method, path });
      let body = ""; for await (const chunk of request) body += chunk;
      if (method === "POST" && path === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } };
        assert.equal(parsed.response_format?.json_schema?.name, "fix_patch_draft");
        const content = { summary: "Reject division by zero and add a regression test.",
          codePatch: "diff --git a/src/divide.js b/src/divide.js\n--- a/src/divide.js\n+++ b/src/divide.js\n@@ -1,1 +1,1 @@\n-export function divide(a, b) { return a / b; }\n+export function divide(a, b) { if (b === 0) throw new Error('zero'); return a / b; }\n",
          testPatch: "diff --git a/tests/divide-regression.test.js b/tests/divide-regression.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/divide-regression.test.js\n@@ -0,0 +1,4 @@\n+import test from 'node:test';\n+import assert from 'node:assert/strict';\n+import { divide } from '../src/divide.js';\n+test('zero', () => assert.throws(() => divide(1, 0)));\n" };
        return json(response, 200, { id: "fix-model-1", object: "chat.completion", created: 1,
          model: "fix-dispatch-model", choices: [{ index: 0, finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } });
      }
      if (method === "GET" && path === "/repos/acme/fix-dispatch/pulls/42") {
        return json(response, 200, { id: 42, number: 42, title: "Fix divide", body: "", user: { login: "alice" },
          base: { ref: "main", sha: baseSha }, head: { ref: "feature", sha: headSha }, draft: false,
          html_url: `${origin}/acme/fix-dispatch/pull/42` });
      }
      if (method === "GET" && path === `/repos/acme/fix-dispatch/git/trees/${headSha}?recursive=1`) {
        return json(response, 200, { truncated: false, tree: [
          { path: "package-lock.json", mode: "100644", type: "blob" },
          { path: "src/divide.js", mode: "100644", type: "blob" },
          { path: "tests/existing.test.js", mode: "100644", type: "blob" },
        ] });
      }
      const contents = new Map([
        ["package-lock.json", lockContent], ["src/divide.js", sourceContent], ["tests/existing.test.js", existingTest],
      ]);
      const match = /^\/repos\/acme\/fix-dispatch\/contents\/(.+)\?ref=/.exec(path);
      if (method === "GET" && match && contents.has(decodeURIComponent(match[1]!))) {
        const name = decodeURIComponent(match[1]!); const content = contents.get(name)!;
        return json(response, 200, { type: "file", path: name, encoding: "base64",
          content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
      }
      return json(response, 404, { message: "fixture route not found" });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;

    await migrateRuntime(adminPool);
    const appRole = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app'");
    const roleDdl = await adminPool.query<{ sql: string }>(appRole.rowCount
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) AS sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) AS sql",
    [appPassword]);
    await adminPool.query(roleDdl.rows[0]!.sql);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.GITHUB_API_URL = origin; process.env.GITHUB_TOKEN = "local-read-token";
    process.env.AI_PROVIDER = "openai-compatible"; process.env.AI_MODEL = "fix-dispatch-model";
    process.env.OPENAI_BASE_URL = `${origin}/v1`; process.env.OPENAI_COMPATIBLE_API_KEY = "local-model-key";
    process.env.HARNESS_MODEL_PRICING_JSON = pricing(); process.env.FIX_DEFAULT_POLICY_ID = "node-fixture";
    process.env.FIX_VERIFIER_SNAPSHOT_ROOT = snapshotRoot;
    const rawPolicy = policy(); process.env.FIX_POLICY_REGISTRY_JSON = JSON.stringify({ "node-fixture": rawPolicy });
    const configured = spawnSync(process.execPath, ["--import", "tsx", "src/agent-runtime/cli.ts", "migrate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HARNESS_DATABASE_URL: databaseUrl },
    });
    if (configured.status !== 0) throw new Error(`runtime grant CLI failed: ${configured.stderr}`);
    appPool = new Pool({ connectionString: appUrl.toString(), max: 12 }); appDb = new RuntimeDatabase(appPool);
    binding = await bind();
    await seedAcceptedReview();
    service = new RunsService();
  });

  after(async () => {
    await closeAgentRuntime(); await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE"); await adminPool.end();
    await rm(snapshotRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("creates and executes a FixRun from an accepted deep finding through the production worker", async () => {
    calls.length = 0;
    const created = await service.createFix(principal, sourceRunId, "fix-command-1", { findingId });
    assert.equal(created.created, true);
    const runtime = await appDb.transaction(tenantId, async (client) => (await client.query<{
      runtime_version_hash: string }>("SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
    [tenantId, created.id])).rows[0]!.runtime_version_hash);
    const { provider, model } = resolveModelConfiguration();
    assert.equal(runtime, (await runtimeVersionManifest(getModelExecutionPolicy(provider, model))).runtimeVersionHash);

    const execution = new RunExecutionStore(appDb);
    const errors: unknown[] = [];
    const worker = new RunWorker({ store: execution, budget: new ModelBudgetStore(appDb), bindings: async () => [binding],
      runtimeHash: async () => runtime, execute: executeReviewRun, onError: (error) => errors.push(error) }, 1);
    const verifier = completeNextVerification(created.id);
    await worker.tick(); await worker.drain(); await verifier;
    assert.equal((await execution.load(tenantId, created.id))?.status, "succeeded",
      errors.map((error) => error instanceof Error ? error.stack : String(error)).join("\n"));
    assert.equal(errors.length, 0);
    const artifact = await service.artifact(principal, created.id, "false") as Record<string, unknown>;
    assert.equal(artifact.outcome, "suggestion_only");
    assert.equal(artifact.publicationMode, "suggestion_only");
    const raw = await service.artifact(principal, created.id, "true") as { proposal?: { codePatch?: string }; verification?: { relevance?: string } };
    assert.match(raw.proposal?.codePatch ?? "", /throw new Error\('zero'\)/);
    assert.equal(raw.verification?.relevance, "unknown");
    assert.equal(calls.filter(({ method, path }) => method === "POST" && path === "/v1/chat/completions").length, 1);

    const bundleCount = (await readdir(snapshotRoot)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length;
    const duplicate = await service.createFix(principal, sourceRunId, "fix-command-1", { findingId });
    assert.equal(duplicate.id, created.id); assert.equal(duplicate.created, false);
    assert.equal((await readdir(snapshotRoot)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, bundleCount);
    assert.equal(calls.filter(({ method, path }) => method === "POST" && path === "/v1/chat/completions").length, 1);
  });

  async function completeNextVerification(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const claim = await adminPool.query<{ id: string; tenant_id: string; proposal_hash: string; policy_hash: string;
        image_digest: string; lease_epoch: string; proposal_json: FixProposal }>(
        "SELECT * FROM pr_agent_harness.claim_verification_job($1,$2)", ["fixture-verifier", 60]);
      const row = claim.rows[0];
      if (row) {
        assert.equal(row.proposal_json.runId, runId);
        const result: VerificationResult = { outcome: "suggestion_only", reasonCodes: ["relevance_not_verified"],
          baselineTarget: "fail", patchedTarget: "pass", baselineRegression: [], patchedRegression: [],
          relevance: "unknown", logRefs: {}, logHashes: {}, imageDigest: row.image_digest,
          policyHash: row.policy_hash, proposalHash: row.proposal_hash };
        const completed = await adminPool.query<{ complete_verification_job: boolean }>(
          "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6)",
          [row.tenant_id,row.id,"fixture-verifier",Number(row.lease_epoch),JSON.stringify(result),fingerprint(result)]);
        assert.equal(completed.rows[0]!.complete_verification_job, true); return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("verification job was not enqueued");
  }

  async function bind(): Promise<PublicationBinding> {
    const runs = new RunStore(adminDb); const authority = new PublicationAuthorityStore(adminDb);
    await runs.registerIntegration({ tenantId, id: integrationId, platform: "github", origin, repository });
    await authority.configure({ tenantId, integrationId, providerRepositoryId: 88, providerActorId: 99,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    const active = await authority.transition({ tenantId, integrationId, expectedVersion: 1, action: "activate",
      actor: "fixture", actorType: "service", quiescenceEvidence: "local fixture" });
    await adminPool.query(`UPDATE pr_agent_harness.integration_bindings
      SET review_execution_mode='harness_async',review_execution_state='active',execution_mode_generation=1
      WHERE tenant_id=$1 AND id=$2`, [tenantId,integrationId]);
    return { ...active, reviewExecutionMode: "harness_async", reviewExecutionState: "active", executionModeGeneration: 1 };
  }

  async function seedAcceptedReview(): Promise<void> {
    const review: ReviewRunInput = { schemaVersion: 1, workflow: "review.deep.v1", platform: "github",
      target: { origin, repository, number: 42, providerRepositoryId: 88 },
      source: { key: "source-deep", hash: fingerprint("source-deep") }, revision: { baseSha, headSha },
      mode: "report", trigger: "comment-command", options: { customRules: [], includeCiChecks: true,
        enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Fix divide", body: "", author: "alice", baseBranch: "main", headBranch: "feature",
        webUrl: `${origin}/acme/fix-dispatch/pull/42`, draft: false } };
    const stepId = randomUUID(); const gateId = fingerprint("fix-dispatch-gate");
    const finding = { id: findingId, sourceRole: "correctness", severity: "high", title: "Division by zero",
      body: "The changed line divides without rejecting a zero divisor.",
      location: { path: "src/divide.js", side: "new", startLine: 1, endLine: 1 },
      evidenceIds: [fingerprint("evidence")], crossFileEvidenceIds: [] };
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
          run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
          policy_version_hash,runtime_version_hash,input_json,status,authority_generation,execution_mode_generation,deadline_at,finished_at)
       VALUES ($1,$2,$3,'user','maker','review.deep.v1','source-deep',$4,'review.deep.v1',$5,$6,$4,$4,$4,$4,$4,$4,$7::jsonb,
         'succeeded',1,1,clock_timestamp()+interval '15 minutes',clock_timestamp())`,
      [sourceRunId,tenantId,integrationId,fingerprint("review-version"),baseSha,headSha,JSON.stringify(review)]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'deep.role.correctness.candidates','coordination',$4,'succeeded',$4,'{"value":{}}'::jsonb,1,1,clock_timestamp())`,
      [stepId,tenantId,sourceRunId,fingerprint("candidate-step")]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.finding_candidates
         (id,tenant_id,integration_id,run_id,step_id,source_role,head_sha,content_hash,record_json)
       VALUES ($1,$2,$3,$4,$5,'correctness',$6,$7,$8::jsonb)`,
      [findingId,tenantId,integrationId,sourceRunId,stepId,headSha,fingerprint(finding),JSON.stringify(finding)]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.finding_decisions
         (id,tenant_id,integration_id,run_id,step_id,candidate_id,stage,head_sha,content_hash,record_json)
       VALUES ($1,$2,$3,$4,$5,$6,'gate',$7,$8,'{"accepted":true}'::jsonb)`,
      [gateId,tenantId,integrationId,sourceRunId,stepId,findingId,headSha,fingerprint({ accepted: true })]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,'{}'::jsonb)`,
      [fingerprint("deep-artifact"),tenantId,integrationId,sourceRunId,headSha,fingerprint({})]);
  }

  function policy() {
    const value = { nodeImageDigest: imageDigest, argv: ["node", "--test", "tests/existing.test.js"],
      dependencyLockPath: "package-lock.json", dependencyLockHash: sha256(lockContent),
      allowedTestPrefixes: ["tests"], relevanceTokens: ["divide", "zero"], deadlineMs: 60_000,
      maxLogBytes: 64 * 1024, memoryMb: 256, cpuCount: 1, pidsLimit: 64, tmpfsMb: 128,
      publisherPolicyId: "github-draft-v1", publisherPolicyHash: fingerprint("github-draft-v1"), publishEnabled: false };
    return { ...value, sandboxHash: expectedSandboxPolicyHash({ ...value, sandboxHash: "" }) };
  }
}

function pricing(): string {
  return JSON.stringify({ version: "fix-dispatch-v1", currency: "USD", periodKey: "fix-dispatch-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 30_000, outputTokens: 12_000, costMicros: 0 },
    models: { "openai-compatible:fix-dispatch-model": { rates: { inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 }, maxOutputTokens: 4_096,
      maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } } });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
