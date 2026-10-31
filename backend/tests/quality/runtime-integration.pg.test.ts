import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool, type PoolClient } from "pg";

import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { PgRunScheduler } from "../../src/agent-runtime/execution/scheduler.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore, type CreateRunInput } from "../../src/agent-runtime/postgres/run-store.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { resolveQualityConfiguration } from "../../src/quality/config.js";
import { promptTemplateHash, promptTemplateVariables,
  type PromptBundleV1 } from "../../src/quality/prompts/contracts.js";
import { renderManagedPrompt, withFrozenPromptBundle } from "../../src/quality/prompts/runtime.js";
import { PgQualityPromptStore } from "../../src/quality/storage/prompt-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Quality runtime integration tests require the dedicated Docker database", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) {
    throw new Error("HARNESS_TEST_DATABASE_URL must target a disposable harness_test_* database");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const db = new RuntimeDatabase(pool);
  const runStore = new RunStore(db);
  const promptStore = new PgQualityPromptStore(db);
  const authority = new PublicationAuthorityStore(db);
  const originalQualityEnv = {
    mode: process.env.LANGFUSE_QUALITY_ENABLED,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    allowHttp: process.env.LANGFUSE_ALLOW_INSECURE_HTTP,
    evolution: process.env.FEATURE_EVOLUTION,
    tracing: process.env.LANGFUSE_ENABLED,
  };

  before(async () => {
    process.env.LANGFUSE_QUALITY_ENABLED = "on";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.quality.test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-runtime-integration";
    process.env.LANGFUSE_ENABLED = "on";
    process.env.FEATURE_EVOLUTION = "on";
    delete process.env.LANGFUSE_ALLOW_INSECURE_HTTP;
    await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(pool);
  });

  after(async () => {
    restoreEnv("LANGFUSE_QUALITY_ENABLED", originalQualityEnv.mode);
    restoreEnv("LANGFUSE_BASE_URL", originalQualityEnv.baseUrl);
    restoreEnv("LANGFUSE_PUBLIC_KEY", originalQualityEnv.publicKey);
    restoreEnv("LANGFUSE_ALLOW_INSECURE_HTTP", originalQualityEnv.allowHttp);
    restoreEnv("FEATURE_EVOLUTION", originalQualityEnv.evolution);
    restoreEnv("LANGFUSE_ENABLED", originalQualityEnv.tracing);
    await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await pool.end();
  });

  test("Run creation freezes the prompt activated by prepareNewRun and duplicate intake retains it", async () => {
    const fixture = await createBinding("prompt-freeze");
    const targetFingerprint = resolveQualityConfiguration().targetFingerprint;
    const first = await importPrompt(fixture, 1, "First prompt version.", targetFingerprint);
    const second = await importPrompt(fixture, 2, "Second prompt version.", targetFingerprint);
    await promptStore.activate(fixture, activation(first, "activate-v1", targetFingerprint));

    const basePromptHash = hash("base-prompt");
    const modelHash = hash("model-policy");
    let prepareCalls = 0;
    const input = runInput(fixture, "prepared-freeze", "review.single.v1", {
      promptVersionHash: basePromptHash,
      modelVersionHash: modelHash,
      prepareNewRun: async (client) => {
        prepareCalls += 1;
        await activateCandidate(client, fixture, first.id, second.id, "activate-v2");
        return { promptVersionHash: basePromptHash, toolVersionHash: hash("prepared-tool"),
          runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3,
            modelBudget: { currency: "USD", maxCostMicros: 123_000 } } };
      },
    });
    const created = await runStore.createRun(input);
    assert.equal(prepareCalls, 1);

    const stored = await readRun(fixture.tenantId, created.id);
    const bundle = stored.runtime_config_json.promptBundle as PromptBundleV1;
    assert.equal(bundle.prompts["issues.triage.system"]?.version, 2);
    assert.equal(bundle.prompts["issues.triage.system"]?.template, "Second prompt version.");
    assert.equal(stored.prompt_version_hash,
      fingerprint({ base: basePromptHash, promptBundleHash: bundle.hash }));
    assert.equal(stored.model_version_hash, modelHash);
    assert.deepEqual(stored.runtime_config_json.modelBudget,
      { currency: "USD", maxCostMicros: 123_000 });

    const rendered = withFrozenPromptBundle(bundle,
      () => renderManagedPrompt("issues.triage.system"));
    assert.equal(rendered.text, "Second prompt version.");
    assert.deepEqual(rendered.reference, { name: "pr-agent.issues.triage.system", version: 2,
      contentHash: promptTemplateHash("Second prompt version.") });

    const third = await importPrompt(fixture, 3, "Third prompt version.", targetFingerprint);
    await promptStore.activate(fixture, activation(third, "activate-v3", targetFingerprint));
    const duplicate = await runStore.createRun(input);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, created.id);
    assert.equal(prepareCalls, 1, "duplicate intake must not prepare or refreeze against today's catalog");
    const unchanged = await readRun(fixture.tenantId, created.id);
    assert.equal((unchanged.runtime_config_json.promptBundle as PromptBundleV1)
      .prompts["issues.triage.system"]?.version, 2);
  });

  test("replay Runs keep their explicit prompt identity instead of adopting the active catalog", async () => {
    const fixture = await createBinding("replay-prompt");
    const explicitPromptHash = hash("replay-baseline-prompt");
    const created = await runStore.createRun(runInput(fixture, "replay", "eval.replay.v1", {
      promptVersionHash: explicitPromptHash,
      runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3,
        replayBaselinePromptHash: explicitPromptHash },
    }));
    const stored = await readRun(fixture.tenantId, created.id);
    assert.equal(stored.prompt_version_hash, explicitPromptHash);
    assert.equal("promptBundle" in stored.runtime_config_json, false);
    assert.equal(stored.runtime_config_json.replayBaselinePromptHash, explicitPromptHash);
  });

  test("scheduler claims eval.judge.v1 only while Evolution is enabled", async () => {
    const fixture = await createBinding("judge-scheduler");
    const runtimeHash = hash("judge-runtime");
    await runStore.createRun(runInput(fixture, "judge", "eval.judge.v1", {
      runtimeVersionHash: runtimeHash,
    }));
    const scheduler = new PgRunScheduler(pool, authority, 2);
    await pool.query(`UPDATE pr_agent_harness.integration_bindings SET evolution_enabled=false
      WHERE tenant_id=$1 AND id=$2`, [fixture.tenantId, fixture.integrationId]);
    assert.deepEqual(await scheduler.reserve({ queueClass: "normal", limit: 1,
      runtimeVersionHash: runtimeHash, supportedWorkflows: ["eval.judge.v1"] }), []);

    await pool.query(`UPDATE pr_agent_harness.integration_bindings SET evolution_enabled=true
      WHERE tenant_id=$1 AND id=$2`, [fixture.tenantId, fixture.integrationId]);
    const reserved = await scheduler.reserve({ queueClass: "normal", limit: 1,
      runtimeVersionHash: runtimeHash, supportedWorkflows: ["eval.judge.v1"] });
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0]?.id, fixture.integrationId);
  });

  async function createBinding(key: string) {
    const tenantId = randomUUID(); const integrationId = randomUUID();
    await pool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,publication_state,publication_generation,
          provider_repository_id,provider_actor_id,credential_ref,quiescence_receipt,
          review_execution_mode,execution_mode_generation,evolution_enabled)
       VALUES ($1,$2,'github',$3,$4,'active',1,$5,$6,'test-credential',$7::jsonb,
               'harness_async',1,true)`,
      [integrationId, tenantId, `https://${key}.example.test`, `acme/${key}`,
        String(Math.floor(Math.random() * 1_000_000) + 1),
        String(Math.floor(Math.random() * 1_000_000) + 1),
        JSON.stringify({ verifiedBy: "quality-runtime-test", at: new Date().toISOString() })],
    );
    return { tenantId, integrationId };
  }

  async function importPrompt(scope: { tenantId: string; integrationId: string }, version: number,
    template: string, targetFingerprint: string) {
    return promptStore.importCandidate(scope, { promptKey: "issues.triage.system",
      remotePromptName: "pr-agent.issues.triage.system", remotePromptVersion: version,
      template, contentHash: promptTemplateHash(template), variables: promptTemplateVariables(template),
      sourceFingerprint: hash(`source:${version}:${template}`), targetFingerprint,
      actor: { actorType: "service", actorId: "langfuse-sync" } });
  }

  function activation(prompt: Awaited<ReturnType<typeof importPrompt>>, commandKey: string,
    targetFingerprint: string) {
    return { promptVersionId: prompt.id, promptKey: "issues.triage.system" as const,
      expectedContentHash: prompt.contentHash, expectedSourceFingerprint: prompt.sourceFingerprint,
      targetFingerprint, commandKey, actor: { actorType: "user" as const, actorId: "quality-reviewer" } };
  }

  async function activateCandidate(client: PoolClient, scope: { tenantId: string; integrationId: string },
    oldId: string, candidateId: string, commandKey: string): Promise<void> {
    const retired = await client.query(`UPDATE pr_agent_harness.quality_prompt_versions
      SET status='retired',retired_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
      WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='active' RETURNING id`,
    [scope.tenantId, scope.integrationId, oldId]);
    assert.equal(retired.rowCount, 1);
    const activated = await client.query(`UPDATE pr_agent_harness.quality_prompt_versions
      SET status='active',activation_command_key=$4,approved_by_actor_type='user',
        approved_by_actor_id='quality-reviewer',approved_at=clock_timestamp(),retired_at=NULL,
        updated_at=clock_timestamp(),version=version+1
      WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='candidate' RETURNING id`,
    [scope.tenantId, scope.integrationId, candidateId, commandKey]);
    assert.equal(activated.rowCount, 1);
  }

  async function readRun(tenantId: string, runId: string): Promise<{ prompt_version_hash: string;
    model_version_hash: string; runtime_config_json: Record<string, unknown> }> {
    return db.transaction(tenantId, async (client) => {
      const result = await client.query<{ prompt_version_hash: string; model_version_hash: string;
        runtime_config_json: Record<string, unknown> }>(
        `SELECT prompt_version_hash,model_version_hash,runtime_config_json
         FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2`, [tenantId, runId]);
      assert.ok(result.rows[0]); return result.rows[0];
    });
  }
}

function runInput(scope: { tenantId: string; integrationId: string }, key: string, runType: string,
  overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  const component = hash("quality-runtime-component");
  return { tenantId: scope.tenantId, integrationId: scope.integrationId,
    actorType: "service", actorId: "quality-runtime-test", createScope: `quality:${runType}`,
    createKey: key, requestHash: hash(`request:${key}`), runType, baseSha: "base", headSha: "head",
    workflowVersionHash: component, promptVersionHash: component, modelVersionHash: component,
    toolVersionHash: component, policyVersionHash: component, runtimeVersionHash: component,
    input: { workflow: runType }, authorityGeneration: 1, executionModeGeneration: 1,
    runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3 }, limits: { maxStepAttempts: 3 },
    ...overrides };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
