import "reflect-metadata";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { NestFactory, type INestApplication } from "@nestjs/core";
import { Pool } from "pg";

import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import type { RunPermission } from "../../src/agent-runtime/runs/control-contracts.js";
import { closeApplicationRuntimeServices } from "../../src/agent-runtime/runtime/services.js";
import { RunApiAuthenticator, readPrincipalConfiguration } from "../../src/http/common/run-auth.js";
import { QualityModule } from "../../src/http/quality/quality.module.js";
import { resolveQualityConfiguration } from "../../src/quality/config.js";
import type { LangfuseQualityPort } from "../../src/quality/langfuse/contracts.js";
import { MANAGED_PROMPT_CATALOG } from "../../src/quality/prompts/catalog.js";
import type { PromptBundleV1 } from "../../src/quality/prompts/contracts.js";
import { createQualitySyncLoop } from "../../src/quality/sync/loop.js";
import { prepareHarnessRuntimeRoles } from "../support/harness-runtime-roles.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Quality HTTP runtime tests require the dedicated Docker database", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");

  const admin = new Pool({ connectionString: databaseUrl, max: 3 });
  const appPassword = randomUUID(); const verifierPassword = randomUUID();
  const tenantId = randomUUID(); const integrationId = randomUUID();
  const fullToken = "quality-http-full"; const limitedToken = "quality-http-limited";
  const revocableToken = "quality-http-revocable";
  const fullPermissions: RunPermission[] = ["quality:prompts:read", "quality:prompts:approve",
    "quality:sync:read", "quality:sync:execute", "quality:annotations:review",
    "quality:evaluators:run", "runs:read"];
  let appPool: Pool; let db: RuntimeDatabase; let app: INestApplication; let origin: string;
  let originalEnv: Record<string, string | undefined>;

  before(async () => {
    originalEnv = Object.fromEntries(["HARNESS_DATABASE_URL", "HARNESS_API_PRINCIPALS_JSON",
      "LANGFUSE_QUALITY_ENABLED", "LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
      "LANGFUSE_ENABLED", "FEATURE_EVOLUTION"].map((name) => [name, process.env[name]]));
    await prepareHarnessRuntimeRoles(admin, { app: appPassword, verifier: verifierPassword });
    await admin.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await migrateRuntime(admin);
    await admin.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,publication_state,publication_generation,
          provider_repository_id,provider_actor_id,credential_ref,quiescence_receipt,
          review_execution_mode,execution_mode_generation,evolution_enabled)
       VALUES ($1,$2,'github','https://api.github.com','condevtools/quality-http','active',1,
         '91001','92001','env:GITHUB_TOKEN',$3::jsonb,'harness_async',1,true)`,
      [integrationId, tenantId, JSON.stringify({ verifiedBy: "quality-http-test", at: new Date().toISOString() })]);

    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 6 }); db = new RuntimeDatabase(appPool);
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.LANGFUSE_QUALITY_ENABLED = "on";
    process.env.LANGFUSE_ENABLED = "on";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.fixture.test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-quality-http";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-quality-worker";
    process.env.FEATURE_EVOLUTION = "on";
    process.env.HARNESS_API_PRINCIPALS_JSON = principals(true);

    app = await NestFactory.create(QualityModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Quality API fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close(); await closeApplicationRuntimeServices(); await appPool?.end();
    await admin.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE"); await admin.end();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("guarded HTTP seed, Worker sync, activation, and Run freeze form one durable path", async () => {
    const deniedAnnotation = await request("/quality/annotations/queue", limitedToken, {
      method: "POST", key: "denied-annotation", body: { sourceRunId: randomUUID() } });
    assert.equal(deniedAnnotation.status, 403);
    assert.equal(errorCode(deniedAnnotation.value), "FORBIDDEN");
    const deniedJudge = await request("/quality/evaluators/judge", limitedToken, {
      method: "POST", key: "denied-judge", body: { sourceRunId: randomUUID(),
        expectedArtifactHash: hash("missing") } });
    assert.equal(deniedJudge.status, 403);
    assert.equal(errorCode(deniedJudge.value), "FORBIDDEN");

    const definition = MANAGED_PROMPT_CATALOG["issues.triage.system"];
    const admitted = await request("/quality/prompts/pull", fullToken, { method: "POST", key: "seed-triage-v1",
      body: { promptKey: definition.key, remoteName: definition.name, version: 1, seed: true } });
    assert.equal(admitted.status, 202);
    const jobId = String(admitted.value.id);
    const configuration = resolveQualityConfiguration();
    const loop = createQualitySyncLoop({ db, configuration, client: mockLangfuse(), automatic: false,
      assertPrincipalCurrent: (principal) => new RunApiAuthenticator(readPrincipalConfiguration())
        .assertDelegated(principal) });
    const tick = await loop.tick();
    assert.deepEqual({ claimed: tick.claimed, succeeded: tick.succeeded, failed: tick.failed },
      { claimed: 1, succeeded: 1, failed: 0 });
    const completed = await request(`/quality/jobs/${jobId}`, fullToken);
    assert.equal(completed.status, 200); assert.equal(completed.value.status, "succeeded");
    const result = completed.value.result as Record<string, unknown>;

    const activated = await request(`/quality/prompts/${String(result.promptVersionId)}/activate`, fullToken, {
      method: "POST", key: "activate-triage-v1", body: { promptKey: definition.key,
        expectedContentHash: result.contentHash, expectedSourceFingerprint: result.sourceFingerprint } });
    assert.equal(activated.status, 201);
    assert.equal(activated.value.status, "active");

    const version = hash("quality-http-run-version");
    const run = await new RunStore(db).createRun({ tenantId, integrationId, actorType: "service",
      actorId: "quality-http-test", createScope: "quality-http", createKey: "run-after-activation",
      requestHash: hash("run-after-activation"), runType: "review.single.v1", baseSha: "base", headSha: "head",
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: { workflow: "review.single.v1" }, authorityGeneration: 1, executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 3 }, limits: { maxStepAttempts: 3 } });
    const saved = await db.transaction(tenantId, (client) => client.query<{ runtime_config_json: Record<string, unknown> }>(
      "SELECT runtime_config_json FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, run.id]));
    const bundle = saved.rows[0]!.runtime_config_json.promptBundle as PromptBundleV1;
    assert.equal(bundle.prompts[definition.key]?.version, 1);
    assert.equal(bundle.prompts[definition.key]?.template, definition.template);
  });

  test("Worker revalidates a queued principal and fails work after its grant is revoked", async () => {
    const definition = MANAGED_PROMPT_CATALOG["review.single.system.en"];
    const admitted = await request("/quality/prompts/pull", revocableToken, { method: "POST", key: "revoked-v1",
      body: { promptKey: definition.key, remoteName: definition.name, version: 1, seed: true } });
    assert.equal(admitted.status, 202);
    process.env.HARNESS_API_PRINCIPALS_JSON = principals(false);
    const configuration = resolveQualityConfiguration();
    const loop = createQualitySyncLoop({ db, configuration, client: mockLangfuse(), automatic: false,
      assertPrincipalCurrent: (principal) => new RunApiAuthenticator(readPrincipalConfiguration())
        .assertDelegated(principal) });
    const tick = await loop.tick();
    assert.equal(tick.claimed, 1); assert.equal(tick.succeeded, 0); assert.equal(tick.failed, 1);
    const saved = await db.transaction(tenantId, (client) => client.query<{ status: string; error_code: string }>(
      "SELECT status,error_code FROM pr_agent_harness.quality_sync_jobs WHERE tenant_id=$1 AND id=$2",
      [tenantId, admitted.value.id]));
    assert.equal(saved.rows[0]?.status, "retry_wait");
    assert.equal(saved.rows[0]?.error_code, "UNAUTHORIZED");
  });

  function principals(includeRevocable: boolean): string {
    const records = [principal("quality-admin", fullToken, fullPermissions),
      principal("quality-reader", limitedToken, ["quality:prompts:read"]),
      ...(includeRevocable ? [principal("quality-revocable", revocableToken,
        ["quality:sync:execute", "quality:sync:read"])] : [])];
    return JSON.stringify(records);
  }

  function principal(subjectId: string, token: string, permissions: RunPermission[]) {
    return { subjectId, actorType: "user", tokenSha256: hash(token), tenantId, integrationId, permissions };
  }

  function mockLangfuse(): LangfuseQualityPort {
    const unused = async (): Promise<never> => { throw new Error("Unexpected mock Langfuse operation"); };
    return {
      getTextPrompt: async (name, version) => {
        const definition = Object.values(MANAGED_PROMPT_CATALOG).find((item) => item.name === name);
        if (!definition) throw new Error("Unknown managed prompt");
        return { name, version, text: definition.template, labels: ["production"] };
      },
      createTextPrompt: unused, getOrCreateDataset: unused, upsertDatasetItem: unused,
      linkDatasetRunItem: unused, getOrCreateScoreConfig: unused, upsertScore: unused,
      getOrCreateAnnotationQueue: unused, addAnnotationQueueItem: unused, listHumanAnnotationScores: unused,
    };
  }

  async function request(path: string, token: string, options: { method?: string; key?: string;
    body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${origin}${path}`, { method: options.method ?? "GET", headers: {
      authorization: `Bearer ${token}`, ...(options.key ? { "idempotency-key": options.key } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, value: await response.json() as Record<string, unknown> };
  }
}

function errorCode(value: Record<string, unknown>): unknown {
  return (value.error as Record<string, unknown> | undefined)?.code;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
