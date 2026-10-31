import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { PgRunScheduler } from "../../src/agent-runtime/execution/scheduler.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { EvaluationCoordinator } from "../../src/evolution/evaluations/run.js";
import { PgEvolutionEvaluationStore } from "../../src/evolution/evaluations/store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Runtime scheduling PostgreSQL tests require the dedicated Docker database", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const roleName = `scheduler_app_${randomUUID().replaceAll("-", "")}`;
  const rolePassword = randomUUID();
  let app: Pool;
  const db = new RuntimeDatabase(pool);
  const authority = new PublicationAuthorityStore(db);
  const scheduler = new PgRunScheduler(pool, authority, 2);
  const runtimeHash = hash("fair-runtime");

  before(async () => {
    await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(pool);
    await pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName}`);
    await pool.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.reserve_runtime_bindings(
      text,text,text[],integer,integer) TO ${roleName}`);
    const appUrl = new URL(databaseUrl);
    appUrl.username = roleName;
    appUrl.password = rolePassword;
    app = new Pool({ connectionString: appUrl.toString(), max: 1 });
  });

  after(async () => {
    await app?.end();
    await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await pool.query(`DROP ROLE IF EXISTS ${roleName}`);
    await pool.end();
  });

  test("persistent cursor gives every continuously runnable binding an opportunity before a repeat", async () => {
    const expected = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      expected.add((await createRunnableBinding(`fair-${index}`)).id);
    }

    const observed: string[] = [];
    while (observed.length < expected.size) {
      const page = await scheduler.reserve({
        queueClass: "normal",
        limit: Math.min(4, expected.size - observed.length),
        runtimeVersionHash: runtimeHash,
        supportedWorkflows: ["review"],
      });
      assert.ok(page.length > 0);
      observed.push(...page.map((binding) => binding.id));
    }
    assert.equal(new Set(observed).size, expected.size);
    assert.deepEqual(new Set(observed), expected);

    const replacement = new PgRunScheduler(pool, authority, 2);
    const next = await replacement.reserve({
      queueClass: "normal",
      limit: 1,
      runtimeVersionHash: runtimeHash,
      supportedWorkflows: ["review"],
    });
    assert.equal(next.length, 1);
    assert.equal(next[0]!.id, observed[0], "a new scheduler instance must continue from the PG cursor");
  });

  test("concurrent scheduler instances serialize cursor advancement", async () => {
    await pool.query("DELETE FROM pr_agent_harness.runtime_scheduler_cursors WHERE queue_class='normal'");
    const left = new PgRunScheduler(pool, authority, 2);
    const right = new PgRunScheduler(pool, authority, 2);
    const [first, second] = await Promise.all([
      left.reserve({ queueClass: "normal", limit: 4, runtimeVersionHash: runtimeHash,
        supportedWorkflows: ["review"] }),
      right.reserve({ queueClass: "normal", limit: 4, runtimeVersionHash: runtimeHash,
        supportedWorkflows: ["review"] }),
    ]);
    assert.equal(first.length, 4);
    assert.equal(second.length, 4);
    assert.equal(new Set([...first, ...second].map((binding) => binding.id)).size, 8);
  });

  test("database scheduler rejects null, unbounded and unknown direct requests", async () => {
    await assert.rejects(
      app.query("SELECT * FROM pr_agent_harness.runtime_scheduler_cursors"),
      /permission denied/,
    );
    await assert.rejects(
      app.query("SELECT * FROM pr_agent_harness.reserve_runtime_bindings('maintenance',$1,$2,NULL,2)",
        ["0".repeat(64), []]),
      /invalid runtime scheduling request/,
    );
    await assert.rejects(
      app.query("SELECT * FROM pr_agent_harness.reserve_runtime_bindings('normal',$1,$2,1,2)",
        [runtimeHash, ["review.future.v9"]]),
      /invalid runtime scheduling request/,
    );
    await assert.rejects(
      app.query("SELECT * FROM pr_agent_harness.reserve_runtime_bindings('normal',NULL,$1,1,2)",
        [["review"]]),
      /invalid runtime scheduling request/,
    );
  });

  test("new Runs have no outcome scan due marker before publication is linked", async () => {
    const metadata = await pool.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema='pr_agent_harness' AND table_name='agent_runs'
         AND column_name='next_outcome_scan_at'`,
    );
    assert.equal(metadata.rows[0]?.column_default, null);
    const unlinked = await createRunnableBinding("unlinked-outcome-marker");
    const state = await pool.query<{ due: boolean }>(
      `SELECT next_outcome_scan_at IS NOT NULL AS due FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND integration_id=$2`,
      [unlinked.tenantId, unlinked.id],
    );
    assert.equal(state.rows[0]?.due, false);
  });

  test("Issue Triage scheduling requires an enabled GitHub binding capability", async () => {
    const binding = await createBinding("issue-triage-scheduling");
    await new RunStore(db).createRun({
      tenantId: binding.tenantId, integrationId: binding.id,
      actorType: "service", actorId: "scheduler-test",
      createScope: `issue.triage.v1:${binding.id}`, createKey: "issue:42:content",
      requestHash: hash("issue-triage-request"), runType: "issue.triage.v1",
      baseSha: "content", headSha: "content",
      workflowVersionHash: hash("workflow"), promptVersionHash: hash("prompt"),
      modelVersionHash: hash("model"), toolVersionHash: hash("tool"),
      policyVersionHash: hash("policy"), runtimeVersionHash: runtimeHash,
      input: { schemaVersion: 1, workflow: "issue.triage.v1" },
      authorityGeneration: binding.generation,
      executionModeGeneration: binding.executionModeGeneration,
      bindingAuthorityVersion: binding.version,
      runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3 },
      limits: { maxStepAttempts: 3 },
    });
    const reserved = await scheduler.reserve({ queueClass: "normal", limit: 1,
      runtimeVersionHash: runtimeHash, supportedWorkflows: ["issue.triage.v1"] });
    assert.equal(reserved[0]?.id, binding.id);
    await pool.query("UPDATE pr_agent_harness.integration_bindings SET issue_triage_enabled=false WHERE id=$1",
      [binding.id]);
    assert.deepEqual(await scheduler.reserve({ queueClass: "normal", limit: 1,
      runtimeVersionHash: runtimeHash, supportedWorkflows: ["issue.triage.v1"] }), []);
  });

  test("maintenance skips an idle page and reserves only bindings with due work", async () => {
    await pool.query("DELETE FROM pr_agent_harness.runtime_scheduler_cursors WHERE queue_class='maintenance'");
    for (let index = 0; index < 35; index += 1) {
      await createBinding(
        `maintenance-idle-${index}`,
        orderedUuid(1_000 + index),
        orderedUuid(2_000 + index),
      );
    }

    const expired = await createRunnableBinding(
      "maintenance-expired-9001", orderedUuid(60_001), orderedUuid(61_001));
    const deadline = await createRunnableBinding(
      "maintenance-deadline-9002", orderedUuid(60_002), orderedUuid(61_002));
    const outcome = await createRunnableBinding(
      "maintenance-outcome-9003", orderedUuid(60_003), orderedUuid(61_003));
    const evaluation = await createBinding(
      "maintenance-evaluation-9004", orderedUuid(60_004), orderedUuid(61_004), false);

    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='running',lease_owner='expired-worker',lease_epoch=1,
           lease_expires_at=clock_timestamp()-interval '1 second',execution_attempt_count=1
       WHERE tenant_id=$1 AND integration_id=$2`,
      [expired.tenantId, expired.id],
    );
    await pool.query(
      `UPDATE pr_agent_harness.job_queue j
       SET status='running',attempt_count=1,claimed_run_epoch=1
       FROM pr_agent_harness.agent_runs r
       WHERE j.tenant_id=r.tenant_id AND j.run_id=r.id
         AND r.tenant_id=$1 AND r.integration_id=$2`,
      [expired.tenantId, expired.id],
    );
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET deadline_at=created_at+interval '1 millisecond'
       WHERE tenant_id=$1 AND integration_id=$2`,
      [deadline.tenantId, deadline.id],
    );
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='succeeded',outcome_code='test_completed',finished_at=clock_timestamp(),
           next_outcome_scan_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id=$1 AND integration_id=$2`,
      [outcome.tenantId, outcome.id],
    );
    await pool.query(
      `UPDATE pr_agent_harness.job_queue j SET status='completed',completed_at=clock_timestamp()
       FROM pr_agent_harness.agent_runs r
       WHERE j.tenant_id=r.tenant_id AND j.run_id=r.id
         AND r.tenant_id=$1 AND r.integration_id=$2`,
      [outcome.tenantId, outcome.id],
    );
    const outcomeBatchId = randomUUID();
    const outcomeSetHash = hash("maintenance-outcome-link");
    await pool.query(
      `INSERT INTO pr_agent_harness.publication_batches
         (id,tenant_id,integration_id,platform,origin,repository,target,revision,
          authority_generation,execution_mode_generation,source_key,source_hash,status,
          seal_state,sealed_at,operation_count,operation_set_hash)
       VALUES ($1,$2,$3,'github',$4,$5,'9003','head',1,1,$6,$7,'succeeded',
         'sealed',clock_timestamp(),0,$8)`,
      [outcomeBatchId, outcome.tenantId, outcome.id, outcome.origin, outcome.repository,
        "maintenance-outcome", hash("maintenance-outcome-source"), outcomeSetHash],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.run_publication_batches
         (tenant_id,run_id,batch_id,lease_epoch,operation_set_hash)
       SELECT tenant_id,id,$3,1,$4 FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND integration_id=$2`,
      [outcome.tenantId, outcome.id, outcomeBatchId, outcomeSetHash],
    );
    const evaluationId = await createExpiredEvaluation(evaluation);

    const reserved = await scheduler.reserve({ queueClass: "maintenance", limit: 32 });
    assert.deepEqual(new Set(reserved.map((binding) => binding.id)),
      new Set([expired.id, deadline.id, outcome.id, evaluation.id]));
    const workBeforeCleanup = await pool.query<{ run_count: string; model_call_count: string }>(
      `SELECT
         (SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1) AS run_count,
         (SELECT count(*) FROM pr_agent_harness.model_calls WHERE tenant_id=$1) AS model_call_count`,
      [evaluation.tenantId],
    );
    const previousEvolution = process.env.FEATURE_EVOLUTION;
    process.env.FEATURE_EVOLUTION = "off";
    try {
      assert.equal(await new EvaluationCoordinator(new PgEvolutionEvaluationStore(db)).tick(evaluation), true);
    } finally {
      if (previousEvolution === undefined) delete process.env.FEATURE_EVOLUTION;
      else process.env.FEATURE_EVOLUTION = previousEvolution;
    }
    const evaluationState = await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status,error_code FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND id=$2`,
      [evaluation.tenantId, evaluationId],
    );
    assert.deepEqual(evaluationState.rows[0], {
      status: "failed", error_code: "evaluation_deadline_exceeded",
    });
    const workAfterCleanup = await pool.query<{ run_count: string; model_call_count: string }>(
      `SELECT
         (SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1) AS run_count,
         (SELECT count(*) FROM pr_agent_harness.model_calls WHERE tenant_id=$1) AS model_call_count`,
      [evaluation.tenantId],
    );
    assert.equal(workAfterCleanup.rows[0]?.run_count, workBeforeCleanup.rows[0]?.run_count,
      "disabled cleanup must not create evaluation child Runs");
    assert.equal(workAfterCleanup.rows[0]?.model_call_count, workBeforeCleanup.rows[0]?.model_call_count,
      "disabled cleanup must not call a model provider");
  });

  async function createBinding(
    key: string,
    tenantId = randomUUID(),
    integrationId = randomUUID(),
    evolutionEnabled = false,
  ) {
    const parsedOrdinal = Number(key.split("-").at(-1));
    const ordinal = Number.isSafeInteger(parsedOrdinal) ? parsedOrdinal : 99;
    await pool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,publication_state,publication_generation,
          provider_repository_id,provider_actor_id,credential_ref,quiescence_receipt,
          review_execution_mode,execution_mode_generation,evolution_enabled)
       VALUES ($1,$2,'github',$3,$4,'active',1,$5,$6,'test-credential',$7::jsonb,
               'harness_async',1,$8)`,
      [integrationId, tenantId, `https://${key}.example.test`, `acme/${key}`,
        String(10_000 + ordinal),
        String(20_000 + ordinal),
        JSON.stringify({ verifiedBy: "test", at: new Date().toISOString() }), evolutionEnabled],
    );
    return authority.get(tenantId, integrationId);
  }

  async function createRunnableBinding(
    key: string,
    tenantId = randomUUID(),
    integrationId = randomUUID(),
  ) {
    await createBinding(key, tenantId, integrationId);
    await new RunStore(db).createRun({
      tenantId, integrationId, actorType: "service", actorId: "scheduler-test",
      createScope: "test:scheduler:v1", createKey: key, requestHash: hash(`request:${key}`),
      runType: "review", baseSha: "base", headSha: "head",
      workflowVersionHash: hash("workflow"), promptVersionHash: hash("prompt"),
      modelVersionHash: hash("model"), toolVersionHash: hash("tool"),
      policyVersionHash: hash("policy"), runtimeVersionHash: runtimeHash,
      input: { key }, authorityGeneration: 1, executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3 },
      limits: { maxStepAttempts: 3 },
    });
    return authority.get(tenantId, integrationId);
  }

  async function createExpiredEvaluation(binding: Awaited<ReturnType<typeof authority.get>>): Promise<string> {
    const datasetId = randomUUID();
    const proposalRun = await new RunStore(db).createRun({
      tenantId: binding.tenantId, integrationId: binding.id,
      actorType: "service", actorId: "scheduler-test",
      createScope: "test:scheduler:evolution:v1", createKey: "expired-evaluation-proposal",
      requestHash: hash("expired-evaluation-proposal"), runType: "review",
      baseSha: "base", headSha: "head", workflowVersionHash: hash("workflow"),
      promptVersionHash: hash("prompt"), modelVersionHash: hash("model"),
      toolVersionHash: hash("tool"), policyVersionHash: hash("policy"),
      runtimeVersionHash: runtimeHash, input: { purpose: "expired-evaluation" },
      authorityGeneration: 1, executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3 }, limits: { maxStepAttempts: 3 },
    });
    const manifestHash = hash("expired-evaluation-manifest");
    const sourceHash = hash("expired-evaluation-source");
    await pool.query(
      `INSERT INTO pr_agent_harness.eval_datasets
         (id,tenant_id,name,status,curator_actor_type,curator_actor_id,split_policy_json,
          split_policy_hash,manifest_hash,frozen_at)
       VALUES ($1,$2,'expired-evaluation','frozen','service','scheduler-test','{}',$3,$4,
         clock_timestamp())`,
      [datasetId, binding.tenantId, hash("split-policy"), manifestHash],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.evolution_proposal_sources
         (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,
          baseline_prompt_hash,baseline_tool_hash,source_hash,source_json,
          created_by_actor_type,created_by_actor_id)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7,'{}','service','scheduler-test')`,
      [binding.tenantId, proposalRun.id, datasetId, manifestHash, hash("baseline-prompt"),
        hash("baseline-tool"), sourceHash],
    );
    const candidateId = randomUUID();
    await pool.query(
      `INSERT INTO pr_agent_harness.evolution_candidates
         (id,tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,
          candidate_json,candidate_hash,baseline_prompt_hash,baseline_tool_hash,
          model_config_hash,source_hash,provenance_json,created_by_actor_type,created_by_actor_id)
       VALUES ($1,$2,$3,$4,1,$5,'{}',$6,$7,$8,$9,$10,'{}','service','scheduler-test')`,
      [candidateId, binding.tenantId, proposalRun.id, datasetId, manifestHash,
        hash("candidate"), hash("baseline-prompt"), hash("baseline-tool"),
        hash("model-config"), sourceHash],
    );
    const evaluationId = randomUUID();
    const policy = { schemaVersion: 1, maxConcurrentChildrenPerIntegration: 1 };
    await pool.query(
      `INSERT INTO pr_agent_harness.eval_runs
         (id,tenant_id,dataset_id,candidate_id,curator_actor_type,curator_actor_id,split,
          command_key,request_hash,manifest_hash,baseline_component_hash,candidate_component_hash,
          model_version_hash,runtime_version_hash,scheduling_policy_json,scheduling_policy_hash,
          total_result_count,planned_result_count,deadline_at)
       VALUES ($1,$2,$3,$4,'service','scheduler-test','development','expired-evaluation',$5,$6,
         $7,$8,$9,$10,$11::jsonb,$12,0,0,clock_timestamp()-interval '1 second')`,
      [evaluationId, binding.tenantId, datasetId, candidateId, hash("evaluation-request"),
        manifestHash, hash("baseline-component"), hash("candidate-component"), hash("model"),
        runtimeHash, JSON.stringify(policy), hash(policy)],
    );
    return evaluationId;
  }
}

function orderedUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
