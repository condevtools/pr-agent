import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { createDeepReviewWorkflow } from "../src/agents/deep-workflow.js";
import type { DeepReviewArtifact, DeepReviewSource, DeepReviewStore as DeepReviewStorePort,
  DeepWorkflowContext, DeepWorkflowPolicy, StructuredModel, StructuredModelRequest } from "../src/agents/contracts.js";
import { PublicationAuthorityStore, type PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import { DeepReviewEvidenceError, DeepReviewStore } from "../src/review/deep/persistence/store.js";
import { ModelBudgetStore, type ModelExecutionPolicy } from "../src/agent-runtime/budget/model-budget-store.js";
import { executeModelRequest, modelRequestHash } from "../src/model/execution-context.js";
import { PublicationBatchStore } from "../src/agent-runtime/publication/batches.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../src/agent-runtime/postgres/run-store.js";
import { currentRunExecutionContext } from "../src/agent-runtime/execution/run-context.js";
import { enqueueReviewRun } from "../src/review/intake/run-intake.js";
import type { ReviewRunInput } from "../src/review/intake/run-input.js";
import { RunWorker } from "../src/agent-runtime/execution/run-worker.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import { RunExecutionStore } from "../src/agent-runtime/execution/store.js";
import { closeAgentRuntime } from "../src/agent-runtime/runtime.js";
import { fingerprint } from "../src/agent-runtime/versions.js";
import { RepositoryReadToolRegistry } from "../src/integrations/shared/repository-read-tools.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Deep workflow PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const adminDb = new RuntimeDatabase(adminPool);
  const role = `deep_workflow_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const origin = "https://capacity.example.test";
  const repository = "acme/deep-review";
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  let execution: RunExecutionStore;
  let budget: ModelBudgetStore;
  let binding: PublicationBinding;
  let runtimeHash: string;
  let publicationBaseline: { operations: number; batches: number };

  before(async () => {
    await migrateRuntime(adminPool);
    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await grantRuntime(adminPool, role);
    const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.AI_PROVIDER = "openai-compatible";
    process.env.AI_MODEL = "deep-fixture-model";
    process.env.HARNESS_MODEL_PRICING_JSON = pricing();
    appPool = new Pool({ connectionString: appUrl.toString(), max: 16 });
    appDb = new RuntimeDatabase(appPool);
    execution = new RunExecutionStore(appDb, { leaseTtlMs: 60_000, initialRetryMs: 10, maxRetryMs: 100 });
    budget = new ModelBudgetStore(appDb);
    const adminRuns = new RunStore(adminDb);
    const authority = new PublicationAuthorityStore(adminDb);
    await adminRuns.registerIntegration({ tenantId, id: integrationId, platform: "github", origin, repository });
    await authority.configure({ tenantId, integrationId, providerRepositoryId: 8080, providerActorId: 99,
      credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
    binding = await authority.transition({ tenantId, integrationId, expectedVersion: 1, action: "activate",
      actor: "deep-test", actorType: "service", quiescenceEvidence: "isolated deep workflow fixture" });
    await new PublicationBatchStore(appDb).freeze({ executionModeGeneration: 0,
      scope: { tenantId, integrationId, platform: "github", origin, repository, target: "pull:old", revision: "old-head",
        authorityGeneration: binding.generation }, sourceKey: "preexisting-batch", sourceHash: hash("preexisting-batch"),
      operations: [{ slot: "old-comment", payload: { body: "do not dispatch" } }] });
    publicationBaseline = await publicationCounts();
    await adminPool.query(`UPDATE pr_agent_harness.integration_bindings
      SET review_execution_mode='harness_async',review_execution_state='active',execution_mode_generation=1
      WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId]);
    binding = { ...binding, reviewExecutionMode: "harness_async", reviewExecutionState: "active", executionModeGeneration: 1 };
    const fixture = await enqueue("runtime-probe");
    runtimeHash = await runRuntimeHash(fixture);
    await cancelFixture(fixture);
  });

  after(async () => {
    await closeAgentRuntime();
    await appPool?.end();
    await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    await adminPool.end();
  });

  test("worker persists budgeted role, critic, gate, evidence, checkpoints, and immutable shadow artifact", async () => {
    const runId = await enqueue("complete");
    let artifact: DeepReviewArtifact | undefined;
    let immutableRejected = false;
    const scripted = scriptedModel();
    const errors: unknown[] = [];
    const storeErrors: unknown[] = [];
    const worker = makeWorker(async (lease) => {
      const store = observedStore(new DeepReviewStore(appDb), storeErrors);
      artifact = await execute(lease, store, scripted.model, source(lease));
      await assert.rejects(store.saveArtifact(lease, { ...artifact, analysisStatus: "partial", verdict: "incomplete" }),
        (error: unknown) => error instanceof DeepReviewEvidenceError && error.code === "immutable_artifact_conflict");
      immutableRejected = true;
    }, errors);
    await worker.tick(); await worker.drain();

    assert.equal(errors.length, 0, [...errors, ...storeErrors].map((error) => error instanceof Error ? `${error.name}:${error.message}` : String(error)).join(","));
    assert.equal(artifact?.analysisStatus, "complete");
    assert.equal(artifact?.verdict, "findings");
    assert.equal(artifact?.gateDecisions[0]?.reasonCode, "accepted");
    assert.equal(immutableRejected, true);
    assert.equal(scripted.calls(), 4, `first attempt coverage=${JSON.stringify(await ledgerCounts(runId))}; errors=${errors.map((error) => error instanceof Error ? error.message : String(error)).join(",")}`);
    const ledger = await ledgerCounts(runId);
    assert.deepEqual(ledger, { steps: 9, checkpoints: 9, evidence: 1, candidates: 1, decisions: 2, artifacts: 1, models: 4 });
    assert.deepEqual(await publicationCounts(), publicationBaseline);
    assert.equal((await execution.load(tenantId, runId))?.status, "succeeded");
  });

  test("retry after a process fault reuses every completed role and model step", async () => {
    const runId = await enqueue("retry-reuse");
    const actual = new DeepReviewStore(appDb);
    let failLoad = true;
    const flaky: DeepReviewStorePort = {
      loadArtifact: actual.loadArtifact.bind(actual),
      registerEvidence: actual.registerEvidence.bind(actual), registerCandidates: actual.registerCandidates.bind(actual),
      registerDecisions: actual.registerDecisions.bind(actual), saveArtifact: actual.saveArtifact.bind(actual),
      loadUsableEvidence: async (...args) => { if (failLoad) { failLoad = false; throw new Error("fixture_process_loss"); }
        return actual.loadUsableEvidence(...args); },
    };
    const scripted = scriptedModel();
    const errors: unknown[] = [];
    const worker = makeWorker((lease) => execute(lease, flaky, scripted.model, source(lease)).then(() => undefined), errors);
    await worker.tick(); await worker.drain();
    assert.equal((await execution.load(tenantId, runId))?.status, "retry_wait");
    assert.equal(scripted.calls(), 4, `ledger=${JSON.stringify(await ledgerCounts(runId))}; errors=${errors.map((error) => error instanceof Error ? error.message : String(error)).join(",")}`);
    await adminPool.query("UPDATE pr_agent_harness.job_queue SET available_at=now() WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId]);
    await worker.tick(); await worker.drain();
    assert.equal((await execution.load(tenantId, runId))?.status, "succeeded");
    assert.equal(scripted.calls(), 4);
    assert.equal((await ledgerCounts(runId)).models, 4);
    assert.ok(errors.some((error) => error instanceof Error && error.message === "fixture_process_loss"));
  });

  test("a role that exceeds its frozen budget produces incomplete coverage instead of a clean review", async () => {
    const runId = await enqueue("role-budget");
    let artifact: DeepReviewArtifact | undefined;
    const scripted = scriptedModel({ securityInputBound: 3_001 });
    const worker = makeWorker(async (lease) => {
      artifact = await execute(lease, new DeepReviewStore(appDb), scripted.model, source(lease));
    }, []);
    await worker.tick(); await worker.drain();
    assert.equal(artifact?.analysisStatus, "partial");
    assert.equal(artifact?.verdict, "incomplete");
    assert.equal(artifact?.coverage.find(({ role: value }) => value === "security")?.status, "failed");
    assert.notEqual(artifact?.verdict, "no_findings");
  });

  test("retry after artifact commit reuses the exact partial artifact before any model or tool action", async () => {
    const runId = await enqueue("artifact-commit-crash");
    const scripted = scriptedModel({ securityInputBound: 3_001 });
    let crashAfterCommit = true;
    let recovered: DeepReviewArtifact | undefined;
    const errors: unknown[] = [];
    const worker = makeWorker(async (lease) => {
      recovered = await execute(lease, new DeepReviewStore(appDb), scripted.model, source(lease));
      if (crashAfterCommit) {
        crashAfterCommit = false;
        throw new Error("fixture_after_artifact_commit");
      }
    }, errors);
    await worker.tick(); await worker.drain();
    assert.equal((await execution.load(tenantId, runId))?.status, "retry_wait");
    const callsAfterCommit = scripted.calls();
    assert.equal(recovered?.analysisStatus, "partial");
    await adminPool.query("UPDATE pr_agent_harness.job_queue SET available_at=now() WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId]);
    await worker.tick(); await worker.drain();
    assert.equal((await execution.load(tenantId, runId))?.status, "succeeded");
    assert.equal(scripted.calls(), callsAfterCommit);
    assert.equal(recovered?.analysisStatus, "partial");
    assert.ok(errors.some((error) => error instanceof Error && error.message === "fixture_after_artifact_commit"));
  });

  test("zero-diff deep review remains shadow-only and never advances an old publication batch", async () => {
    const runId = await enqueue("zero-diff");
    let artifact: DeepReviewArtifact | undefined;
    const worker = makeWorker(async (lease) => {
      artifact = await execute(lease, new DeepReviewStore(appDb), scriptedModel({ noCandidates: true }).model,
        source(lease, []));
    }, []);
    await worker.tick(); await worker.drain();
    assert.equal(artifact?.verdict, "no_findings");
    assert.equal(artifact?.publicationMode, "shadow");
    assert.deepEqual(await publicationCounts(), publicationBaseline);
    const old = await appDb.transaction(tenantId, (client) => client.query<{ status: string; attempt_count: number }>(
      "SELECT status,attempt_count FROM pr_agent_harness.repository_operations WHERE tenant_id=$1", [tenantId]));
    assert.deepEqual(old.rows, [{ status: "prepared", attempt_count: 0 }]);
    assert.equal((await execution.load(tenantId, runId))?.status, "succeeded");
  });

  test("worker stops before the next deep action when execution authority is revoked after a checkpoint", async () => {
    const runId = await enqueue("authority-revoked");
    const scripted = scriptedModel();
    const errors: unknown[] = [];
    let revoked = false;
    let repositoryReads = 0;
    const worker = makeWorker(async (lease) => {
      const workerContext = currentRunExecutionContext();
      assert.ok(workerContext);
      const guardedStep: DeepWorkflowContext["step"] = async (key, kind, inputHash, action) => {
        const result = await workerContext.step(key, kind, inputHash, action);
        if (!revoked && key === "deep.role.security.turn.1") {
          await adminPool.query(`UPDATE pr_agent_harness.integration_bindings
            SET execution_mode_generation=execution_mode_generation+1
            WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId]);
          revoked = true;
        }
        return result;
      };
      const deepSource = source(lease);
      const context: DeepWorkflowContext = { lease, step: guardedStep, signal: workerContext.signal,
        model: scripted.model, store: new DeepReviewStore(appDb),
        tools: new RepositoryReadToolRegistry({ identity: deepSource.identity,
          changedPaths: deepSource.files.map(({ path }) => path), adapter: {
          readFile: async () => { repositoryReads += 1; return undefined; },
          readCiStatus: async () => { repositoryReads += 1; return { state: "success" }; },
        } }) };
      await createDeepReviewWorkflow().execute(deepSource, context, workflowPolicy());
    }, errors);
    try {
      await worker.tick(); await worker.drain();
      assert.equal(revoked, true);
      assert.equal(repositoryReads, 0);
      assert.equal((await execution.load(tenantId, runId))?.status, "running");
      const ledger = await appDb.transaction(tenantId, async (client) => {
        const steps = await client.query<{ step_key: string }>(
          "SELECT step_key FROM pr_agent_harness.agent_steps WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at",
          [tenantId, runId]);
        const checkpoints = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pr_agent_harness.checkpoints WHERE tenant_id=$1 AND run_id=$2",
          [tenantId, runId]);
        const artifacts = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pr_agent_harness.review_artifacts WHERE tenant_id=$1 AND run_id=$2",
          [tenantId, runId]);
        return { stepKeys: steps.rows.map(({ step_key }) => step_key),
          checkpoints: Number(checkpoints.rows[0]!.count), artifacts: Number(artifacts.rows[0]!.count) };
      });
      assert.ok(ledger.checkpoints >= 1, JSON.stringify(ledger));
      assert.ok(!ledger.stepKeys.some((key) => key.startsWith("deep.role.security.tool.")), JSON.stringify(ledger));
      assert.equal(ledger.artifacts, 0);
      assert.deepEqual(errors, []);
    } finally {
      await adminPool.query(`UPDATE pr_agent_harness.integration_bindings SET execution_mode_generation=1
        WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId]);
      await cancelFixture(runId);
    }
  });

  function makeWorker(executor: (lease: RunLease) => Promise<void>,
    errors: unknown[]) {
    return new RunWorker({ store: execution, budget, bindings: async () => [binding], runtimeHash: async () => runtimeHash,
      execute: executor, onError: (error) => errors.push(error) }, 1);
  }

  function observedStore(actual: DeepReviewStore, errors: unknown[]): DeepReviewStore {
    return new Proxy(actual, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try { return await value.apply(target, args); }
        catch (error) { errors.push(error); throw error; }
      };
    } });
  }

  async function execute(lease: RunLease, store: DeepReviewStorePort, model: StructuredModel, deepSource: DeepReviewSource) {
    const workerContext = currentRunExecutionContext();
    assert.ok(workerContext);
    const context: DeepWorkflowContext = { lease, step: workerContext.step, signal: workerContext.signal, model, store,
      tools: new RepositoryReadToolRegistry({ identity: deepSource.identity,
        changedPaths: deepSource.files.map(({ path }) => path), adapter: {
        readFile: async (path) => path === "src/value.ts"
          ? { path, bytes: new TextEncoder().encode("export const safe = true;\nunsafe(input);\n") } : undefined,
        readCiStatus: async () => ({ state: "success" }),
      } }) };
    return createDeepReviewWorkflow().execute(deepSource, context, workflowPolicy());
  }

  function scriptedModel(options: { securityInputBound?: number; noCandidates?: boolean } = {}) {
    let calls = 0;
    const model: StructuredModel = { generate: async <T>(request: StructuredModelRequest<T>) => {
      const prompt = JSON.parse(request.prompt) as Record<string, any>;
      let value: unknown;
      if (request.schemaName === "deep_security_turn" && request.turn === 1 && !options.noCandidates) {
        value = { action: "tool", request: { name: "read_file_range", path: "src/value.ts", startLine: 1, endLine: 3 } };
      } else if (request.schemaName === "deep_security_turn" && !options.noCandidates) {
        value = { action: "finish", candidates: [{ severity: "high", title: "Unsafe input", body: "Validate before use",
          location: { path: "src/value.ts", side: "new", startLine: 2, endLine: 2 },
          evidenceIds: [prompt.evidence[0].id], crossFileEvidenceIds: [] }] };
      } else if (request.schemaName === "deep_review_critic") {
        value = { decisions: (prompt.candidates ?? []).map((candidate: { id: string }) =>
          ({ candidateId: candidate.id, decision: "accept", reasonCode: "supported" })) };
      } else value = { action: "finish", candidates: [] };
      calls += 1;
      const inputTokenUpperBound = request.role === "security" ? options.securityInputBound ?? 100 : 100;
      return executeModelRequest({ provider: "openai-compatible", model: "deep-fixture-model", requestKind: request.schemaName,
        requestHash: modelRequestHash({ schema: request.schemaName, prompt: request.prompt }), inputTokenUpperBound,
        maxOutputTokens: 50 }, async () => ({ value: request.schema.parse(value), rawResponse: { fixture: value },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, original: { local: true } } })) as Promise<T>;
    } };
    return { model, calls: () => calls };
  }

  function source(lease: RunLease, files = [{ path: "src/value.ts", oldPath: "src/value.ts", status: "modified", changedLines: [2] }]): DeepReviewSource {
    return { identity: { tenantId, integrationId, runId: lease.runId, platform: "github", repository,
      baseSha: lease.baseSha, headSha: lease.headSha }, input: { platform: "github", repository, number: 42,
      title: "Deep review", body: "", author: "alice", baseBranch: "main", headBranch: "feature",
      additions: files.length, deletions: 0, changedFilesCount: files.length, changedFiles: files.map((file) => ({
        newPath: file.path, oldPath: file.oldPath, status: file.status, additions: 1, deletions: 0, extendedDiff: "+unsafe(input);" })) },
      files, coverage: { status: "complete", reasonCodes: [] } };
  }

  async function enqueue(key: string): Promise<string> {
    const input: ReviewRunInput = { schemaVersion: 1, workflow: "review.deep.v1", platform: "github",
      target: { origin, repository, number: 42, providerRepositoryId: 8080 }, source: { key: `deep:${key}`, hash: hash(key) },
      revision: { baseSha: "base-sha", headSha: "head-sha" }, mode: "report", trigger: "comment-command",
      options: { customRules: [], includeCiChecks: true, enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: false },
      presentation: { title: "Deep review", body: "", author: "alice", baseBranch: "main", headBranch: "feature",
        webUrl: "https://example.test/pull/42", draft: false } };
    return (await enqueueReviewRun(binding, input)).id;
  }

  async function runRuntimeHash(runId: string): Promise<string> {
    const result = await appDb.transaction(tenantId, (client) => client.query<{ runtime_version_hash: string }>(
      "SELECT runtime_version_hash FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId]));
    return result.rows[0]!.runtime_version_hash;
  }

  async function cancelFixture(runId: string): Promise<void> {
    await adminPool.query(`UPDATE pr_agent_harness.agent_runs
      SET status='cancelled',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND id=$2`,
      [tenantId, runId]);
    await adminPool.query("UPDATE pr_agent_harness.job_queue SET status='cancelled',completed_at=now() WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId]);
  }

  async function ledgerCounts(runId: string) {
    return appDb.transaction(tenantId, async (client) => {
      const names = [["steps", "agent_steps"], ["checkpoints", "checkpoints"], ["evidence", "evidence_records"],
        ["candidates", "finding_candidates"], ["decisions", "finding_decisions"], ["artifacts", "review_artifacts"],
        ["models", "model_calls"]] as const;
      const result: Record<string, number> = {};
      for (const [name, table] of names) {
        const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM pr_agent_harness.${table} WHERE tenant_id=$1 AND run_id=$2`, [tenantId, runId]);
        result[name] = Number(count.rows[0]!.count);
      }
      return result;
    });
  }

  async function publicationCounts() {
    return appDb.transaction(tenantId, async (client) => {
      const operations = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pr_agent_harness.repository_operations WHERE tenant_id=$1", [tenantId]);
      const batches = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pr_agent_harness.publication_batches WHERE tenant_id=$1", [tenantId]);
      return { operations: Number(operations.rows[0]!.count), batches: Number(batches.rows[0]!.count) };
    });
  }
}

function workflowPolicy(): DeepWorkflowPolicy {
  const limits = { maxTurns: 3, maxToolCalls: 3, maxCandidates: 10, maxWallTimeMs: 30_000,
    maxInputBytesPerTurn: 100_000, maxOutputTokensPerTurn: 100 };
  return { roleLimits: { security: limits, correctness: limits }, criticInputCandidateLimit: 20,
    criticLimits: { maxWallTimeMs: 30_000, maxInputBytes: 100_000, maxOutputTokens: 100 } };
}

function pricing(): string {
  return JSON.stringify({ version: "deep-fixture-v1", currency: "USD", periodKey: "deep-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
    models: { "openai-compatible:deep-fixture-model": { rates: { inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 }, maxOutputTokens: 1_000,
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
      pr_agent_harness.lock_active_legacy_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_legacy_review_execution_authority(uuid,uuid,bigint,bigint),
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

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
