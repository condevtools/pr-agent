import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { promoteQualityAnnotation } from "../../src/http/quality/quality.service.js";
import { promptTemplateHash, parsePromptBundle } from "../../src/quality/prompts/contracts.js";
import { PgQualityAnnotationStore, PgQualityPromptStore, PgQualitySyncJobStore,
  PgQualityTraceStore, QualityLeaseLostError, QualityStorageConflictError,
  freezePromptBundleInTransaction } from "../../src/quality/storage/index.js";
import { createMaintenanceTestPool, prepareHarnessRuntimeRoles } from "../support/harness-runtime-roles.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Quality storage PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("quality storage tests require a disposable database");

  const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
  const tenantId = randomUUID(); const otherTenantId = randomUUID(); const integrationId = randomUUID();
  const runId = randomUUID(); const appPassword = randomUUID();
  const scope = { tenantId, integrationId };
  const actor = { actorType: "service" as const, actorId: "langfuse-sync" };
  const targetFingerprint = fingerprint("quality-target-v1");
  const sourceFingerprint = fingerprint("issues-triage-source-v1");
  const sourceArtifact = { workflowId: "review.deep.v1", identity: { tenantId, integrationId, runId },
    sourceCoverage: { status: "complete" } };
  const sourceArtifactHash = fingerprint(sourceArtifact);
  let appPool: Pool; let maintenancePool: Pool;
  let prompts: PgQualityPromptStore; let sync: PgQualitySyncJobStore;
  let traces: PgQualityTraceStore; let annotations: PgQualityAnnotationStore;

  before(async () => {
    process.env.FEATURE_EVOLUTION = "on";
    await prepareHarnessRuntimeRoles(adminPool, { app: appPassword, verifier: randomUUID() });
    await migrateRuntime(adminPool);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 8 });
    maintenancePool = createMaintenanceTestPool(databaseUrl);
    const db = new RuntimeDatabase(appPool);
    prompts = new PgQualityPromptStore(db); sync = new PgQualitySyncJobStore(db);
    traces = new PgQualityTraceStore(db); annotations = new PgQualityAnnotationStore(db);
    await seedBindingAndRun();
  });

  after(async () => { await maintenancePool?.end(); await appPool?.end(); await adminPool.end(); });

  test("prompt imports are immutable, activation is exact-hash CAS, and Run bundles remain frozen", async () => {
    const empty = await new RuntimeDatabase(appPool).transaction(tenantId, (client) =>
      freezePromptBundleInTransaction(client, tenantId, integrationId, targetFingerprint));
    assert.deepEqual(parsePromptBundle(empty).prompts, {});
    assert.equal(empty.targetFingerprint, targetFingerprint);
    const templateV1 = "Classify issue conservatively.";
    const imported = await prompts.importCandidate(scope, { promptKey: "issues.triage.system",
      remotePromptName: "pr-agent.issues.triage.system", remotePromptVersion: 1, template: templateV1,
      contentHash: promptTemplateHash(templateV1), variables: [], sourceFingerprint,
      targetFingerprint, actor });
    assert.equal((await prompts.importCandidate(scope, { promptKey: "issues.triage.system",
      remotePromptName: "pr-agent.issues.triage.system", remotePromptVersion: 1, template: templateV1,
      contentHash: promptTemplateHash(templateV1), variables: [], sourceFingerprint,
      targetFingerprint, actor })).id, imported.id);
    await assert.rejects(prompts.importCandidate(scope, { promptKey: "issues.triage.system",
      remotePromptName: "pr-agent.issues.triage.system", remotePromptVersion: 1, template: `${templateV1} changed`,
      contentHash: promptTemplateHash(`${templateV1} changed`), variables: [], sourceFingerprint,
      targetFingerprint, actor }), QualityStorageConflictError);
    await assert.rejects(prompts.activate(scope, { promptVersionId: imported.id, promptKey: "issues.triage.system",
      expectedContentHash: imported.contentHash, expectedSourceFingerprint: fingerprint("wrong"), targetFingerprint,
      commandKey: "activate-v1", actor: { actorType: "user", actorId: "approver" } }), QualityStorageConflictError);
    await prompts.activate(scope, { promptVersionId: imported.id, promptKey: "issues.triage.system",
      expectedContentHash: imported.contentHash, expectedSourceFingerprint: sourceFingerprint, targetFingerprint,
      commandKey: "activate-v1", actor: { actorType: "user", actorId: "approver" } });
    const frozenV1 = await new RuntimeDatabase(appPool).transaction(tenantId, (client) =>
      freezePromptBundleInTransaction(client, tenantId, integrationId, targetFingerprint));
    assert.equal(parsePromptBundle(frozenV1).prompts["issues.triage.system"]?.template, templateV1);

    const templateV2 = "Classify issue and return explicit risks.";
    const candidateV2 = await prompts.importCandidate(scope, { promptKey: "issues.triage.system",
      remotePromptName: "pr-agent.issues.triage.system", remotePromptVersion: 2, template: templateV2,
      contentHash: promptTemplateHash(templateV2), variables: [], sourceFingerprint,
      targetFingerprint, actor });
    await prompts.activate(scope, { promptVersionId: candidateV2.id, promptKey: "issues.triage.system",
      expectedContentHash: candidateV2.contentHash, expectedSourceFingerprint: sourceFingerprint, targetFingerprint,
      commandKey: "activate-v2", actor: { actorType: "user", actorId: "approver" } });
    const frozenV2 = await new RuntimeDatabase(appPool).transaction(tenantId, (client) =>
      freezePromptBundleInTransaction(client, tenantId, integrationId, targetFingerprint));
    assert.equal(frozenV1.prompts["issues.triage.system"]?.template, templateV1);
    assert.equal(frozenV2.prompts["issues.triage.system"]?.template, templateV2);
    assert.equal((await prompts.list(scope, { status: "active" })).length, 1);
    assert.equal((await prompts.list({ tenantId: otherTenantId, integrationId })).length, 0);
    const incompatible = "Classify {{issue_body}}.";
    await assert.rejects(prompts.importCandidate(scope, { promptKey: "issues.triage.system",
      remotePromptName: "pr-agent.issues.triage.system", remotePromptVersion: 3, template: incompatible,
      contentHash: promptTemplateHash(incompatible), variables: ["issue_body"], sourceFingerprint,
      targetFingerprint, actor }), QualityStorageConflictError);
  });

  test("sync jobs reject idempotency drift and use fenced bounded claims with retry backoff", async () => {
    const requestHash = fingerprint({ dataset: "review-quality-v1" });
    const input = { kind: "dataset_export" as const, externalId: "dataset:review-quality-v1",
      idempotencyKey: "export:review-quality-v1", requestHash, targetFingerprint,
      payload: { dataset: "review-quality-v1" }, principal: { actorType: "system", actorId: "quality-worker" },
      maxAttempts: 2, maxAgeSeconds: 60 };
    const job = await sync.enqueue(scope, input);
    assert.equal((await sync.enqueue(scope, input)).id, job.id);
    await assert.rejects(sync.enqueue(scope, { ...input, requestHash: fingerprint("changed") }), QualityStorageConflictError);
    const [left, right] = await Promise.all([
      sync.claim(scope, { owner: "worker-a", limit: 1, leaseMs: 60_000 }),
      sync.claim(scope, { owner: "worker-b", limit: 1, leaseMs: 60_000 }),
    ]);
    assert.equal(left.length + right.length, 1);
    const first = (left[0] ?? right[0])!;
    const renewed = await sync.heartbeat(scope,
      { jobId: first.id, owner: first.leaseOwner, epoch: first.leaseEpoch }, 60_000);
    assert.equal(renewed.leaseEpoch, first.leaseEpoch);
    assert.ok(new Date(renewed.leaseExpiresAt!).getTime() > Date.now());
    await adminPool.query("UPDATE pr_agent_harness.quality_sync_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    const [second] = await sync.claim(scope, { owner: "worker-c", limit: 1, leaseMs: 60_000 });
    assert.ok(second); assert.equal(second.leaseEpoch, first.leaseEpoch + 1);
    await assert.rejects(sync.complete(scope, { jobId: first.id, owner: first.leaseOwner, epoch: first.leaseEpoch },
      { exported: 1 }), QualityLeaseLostError);
    const failed = await sync.fail(scope, { jobId: second.id, owner: second.leaseOwner, epoch: second.leaseEpoch },
      { errorCode: "provider_unavailable" });
    assert.equal(failed.status, "dead_letter");
    await adminPool.query("UPDATE pr_agent_harness.quality_sync_jobs SET retry_started_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [job.id]);
    const retried = await sync.retry(scope, { jobId: failed.id, expectedVersion: failed.version, commandKey: "retry-1" });
    assert.equal(retried.status, "queued");
    assert.equal((await sync.retry(scope, { jobId: failed.id, expectedVersion: failed.version,
      commandKey: "retry-1" })).id, failed.id);
    const [afterRetry] = await sync.claim(scope, { owner: "worker-d", limit: 1, leaseMs: 60_000 });
    assert.ok(afterRetry, "manual retry must establish a fresh max-age window");
    await sync.complete(scope, { jobId: afterRetry.id, owner: afterRetry.leaseOwner, epoch: afterRetry.leaseEpoch },
      { exported: 1 });
  });

  test("trace links are immutable and imported scores remain untrusted until explicit review", async () => {
    const trace = await traces.record(scope, { runId, runAttempt: 1,
      traceId: "0123456789abcdef0123456789abcdef", externalId: `run:${runId}:attempt:1`, targetFingerprint });
    assert.equal((await traces.record(scope, { runId, runAttempt: 1,
      traceId: trace.traceId, externalId: trace.externalId, targetFingerprint })).id, trace.id);
    await assert.rejects(traces.record(scope, { runId, runAttempt: 1,
      traceId: "1123456789abcdef0123456789abcdef", externalId: trace.externalId, targetFingerprint }),
    QualityStorageConflictError);
    const score = { name: "human_correctness", value: 0, comment: "A required risk was missed." };
    const contentHash = fingerprint(score);
    const imported = await annotations.importScore(scope, { sourceRunId: runId, traceLinkId: trace.id,
      remoteScoreId: "score-langfuse-1", contentHash, score, actor });
    assert.equal(imported.state, "pending_review");
    assert.equal((await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2",
      [tenantId, runId])).rows[0]!.count, "0");
    const reviewed = await annotations.review(scope, { annotationId: imported.id, expectedContentHash: contentHash,
      decision: "promoted", reviewer: { actorType: "user", actorId: "domain-reviewer" }, commandKey: "review-score-1" });
    assert.equal(reviewed.state, "promoted");
    assert.equal((await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.trusted_review_label_sets WHERE tenant_id=$1 AND source_run_id=$2",
      [tenantId, runId])).rows[0]!.count, "0");
    assert.equal((await annotations.list({ tenantId: otherTenantId, integrationId })).length, 0);
  });

  test("human promotion is atomic with inbox review, replayable, and rejects service actors", async () => {
    const db = new RuntimeDatabase(appPool);
    const trace = await traces.record(scope, { runId, runAttempt: 2,
      traceId: "2123456789abcdef0123456789abcdef", externalId: `run:${runId}:attempt:2`, targetFingerprint });
    const raceScore = { name: "human_correctness", value: 1, comment: "Race fixture" };
    const raceHash = fingerprint(raceScore);
    const raceImport = await annotations.importScore(scope, { sourceRunId: runId, traceLinkId: trace.id,
      remoteScoreId: "score-promotion-race", contentHash: raceHash, score: raceScore, actor });
    const reviewer = principal("race-reviewer", "user");
    const promotion = promotionInput(raceHash);
    const [promoted, rejected] = await Promise.allSettled([
      promoteQualityAnnotation(db, reviewer, raceImport.id, promotion),
      annotations.review(scope, { annotationId: raceImport.id, expectedContentHash: raceHash,
        decision: "rejected", reviewer: { actorType: "user", actorId: "reject-reviewer" },
        commandKey: `quality-annotation:${raceImport.id}:${raceHash}:rejected` }),
    ]);
    assert.equal([promoted, rejected].filter(({ status }) => status === "fulfilled").length, 1);
    const raceState = await annotations.read(scope, raceImport.id);
    const raceAnnotations = await adminPool.query<{ count: string }>(
      `SELECT count(*) FROM pr_agent_harness.review_annotations
       WHERE tenant_id=$1 AND source_run_id=$2 AND command_key=$3`,
      [tenantId, runId, `quality-annotation:${raceImport.id}:${raceHash}:promoted`]);
    assert.equal(raceAnnotations.rows[0]!.count, raceState.state === "promoted" ? "1" : "0",
      "a rejected inbox item must never leave a committed trusted annotation");

    const replayScore = { name: "human_correctness", value: 1, comment: "Replay fixture" };
    const replayHash = fingerprint(replayScore);
    const replayImport = await annotations.importScore(scope, { sourceRunId: runId, traceLinkId: trace.id,
      remoteScoreId: "score-promotion-replay", contentHash: replayHash, score: replayScore, actor });
    const replayReviewer = principal("replay-reviewer", "user");
    const first = await promoteQualityAnnotation(db, replayReviewer, replayImport.id, promotionInput(replayHash));
    const replay = await promoteQualityAnnotation(db, replayReviewer, replayImport.id, promotionInput(replayHash));
    assert.equal(replay.trustedAnnotation.id, first.trustedAnnotation.id);
    assert.equal(replay.imported.state, "promoted");
    const replayCount = await adminPool.query<{ count: string }>(
      `SELECT count(*) FROM pr_agent_harness.review_annotations
       WHERE tenant_id=$1 AND source_run_id=$2 AND command_key=$3`,
      [tenantId, runId, `quality-annotation:${replayImport.id}:${replayHash}:promoted`]);
    assert.equal(replayCount.rows[0]!.count, "1");

    await assert.rejects(promoteQualityAnnotation(db, principal("automation", "service"), replayImport.id,
      promotionInput(replayHash)), /authenticated human reviewer/u);
  });

  test("application and maintenance roles are non-bypass and maintenance deletion remains tenant-scoped", async () => {
    const roles = await adminPool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('pr_agent_app','pr_agent_maintenance') ORDER BY rolname");
    assert.deepEqual(roles.rows, [
      { rolname: "pr_agent_app", rolsuper: false, rolbypassrls: false },
      { rolname: "pr_agent_maintenance", rolsuper: false, rolbypassrls: false },
    ]);
    const maintenance = new PgQualityPromptStore(new RuntimeDatabase(maintenancePool));
    assert.equal(await maintenance.purgeInactive(scope, { before: new Date(Date.now() + 60_000), limit: 1 }), 1);
    assert.equal((await prompts.list(scope, { status: "active" })).length, 1);
    assert.equal(await maintenance.purgeInactive({ tenantId: otherTenantId, integrationId },
      { before: new Date(Date.now() + 60_000), limit: 10 }), 0);
  });

  async function seedBindingAndRun(): Promise<void> {
    await adminPool.query(
      `INSERT INTO pr_agent_harness.integration_bindings (id,tenant_id,platform,origin,repository)
       VALUES ($1,$2,'github','https://api.github.com','condevtools/quality-storage')`, [integrationId, tenantId]);
    await adminPool.query(`UPDATE pr_agent_harness.integration_bindings SET evolution_enabled=true
      WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId]);
    const version = fingerprint("component-version");
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
          request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,
          tool_version_hash,policy_version_hash,runtime_version_hash,input_json,status,finished_at)
       VALUES ($1,$2,$3,'system','quality-test','quality-test','quality-run',$4,'review.deep.v1',
         'base','head',$5,$5,$5,$5,$5,$5,'{}'::jsonb,'succeeded',clock_timestamp())`,
      [runId, tenantId, integrationId, fingerprint("run"), version]);
    const collected = { files: [{ newPath: "src/a.ts",
      patch: "@@ -1,2 +1,3 @@\n old\n+changed\n end" }] };
    await adminPool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,
          last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'github.collect_context.v1','tool',$4,'succeeded',$5,$6::jsonb,1,1,clock_timestamp())`,
      [randomUUID(), tenantId, runId, fingerprint("quality-collector-input"), fingerprint({ value: collected }),
        JSON.stringify({ value: collected })]);
    await adminPool.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow','head',$5,$6::jsonb)`,
      [fingerprint("quality-review-artifact"), tenantId, integrationId, runId, sourceArtifactHash,
        JSON.stringify(sourceArtifact)]);
  }

  function principal(subjectId: string, actorType: "user" | "service"): RunPrincipal {
    return { subjectId, actorType, tenantId, integrationId, permissions: ["quality:annotations:review"] };
  }
  function promotionInput(expectedContentHash: string) {
    return { expectedContentHash, artifactHash: sourceArtifactHash,
      labelSet: { schemaVersion: 1 as const, rubricVersion: "review-quality.v1" as const,
        completeness: "complete" as const, expectedFindings: [] },
      notes: "Reviewed the complete diff." };
  }
}
