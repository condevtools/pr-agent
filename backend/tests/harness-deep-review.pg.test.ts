import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import type { EvidenceRecord } from "../src/agents/contracts.js";
import { DeepReviewEvidenceError, DeepReviewStore } from "../src/harness/deep-review-store.js";
import { HarnessMaintenanceStore } from "../src/harness/maintenance.js";
import { HarnessDatabase } from "../src/harness/postgres/database.js";
import { migrateHarness } from "../src/harness/postgres/migrations.js";
import type { RunLease } from "../src/harness/run-contracts.js";
import { fingerprint } from "../src/harness/versions.js";
import { RepositoryReadToolRegistry } from "../src/integrations/shared/repository-read-tools.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Deep review PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("deep review tests require a disposable database");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const db = new HarnessDatabase(pool);
  const store = new DeepReviewStore(db);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const integrationId = randomUUID();
  const sameTenantOtherIntegrationId = randomUUID();
  const otherIntegrationId = randomUUID();
  const version = fingerprint("deep-version");
  let lease: RunLease;

  before(async () => {
    await migrateHarness(pool);
    lease = await fixture(tenantId, integrationId, "acme/deep");
    await fixture(tenantId, sameTenantOtherIntegrationId, "acme/other-deep");
    await fixture(otherTenantId, otherIntegrationId, "other/deep");
  });
  after(async () => pool.end());

  test("evidence registration requires exact successful tool output, request, scope and live lease", async () => {
    const identity = { tenantId, integrationId, runId: lease.runId, platform: "github" as const,
      repository: "acme/deep", baseSha: lease.baseSha, headSha: lease.headSha };
    const tools = new RepositoryReadToolRegistry({ identity, changedPaths: ["src/a.ts"], adapter: {
      readFile: async (path) => ({ path, bytes: new TextEncoder().encode("export const value = 1;") }),
      readCiStatus: async () => [],
    } });
    const record = await tools.invoke("security", "read_file_range", { path: "src/a.ts", startLine: 1, endLine: 1 });
    const stepKey = "deep.role.security.tool.read_file_range.1";
    await insertSucceededStep(lease, stepKey, "tool", record,
      (record as EvidenceRecord & { requestHash: string }).requestHash, "read_file_range");
    await store.registerEvidence(lease, stepKey, record);
    await store.registerEvidence(lease, stepKey, record);
    assert.equal((await store.loadUsableEvidence(lease, [record.id])).get(record.id)?.contentHash, record.contentHash);

    const forged = { ...record, summary: "invented" };
    await assert.rejects(store.registerEvidence(lease, stepKey, forged),
      (error: unknown) => error instanceof DeepReviewEvidenceError && error.code === "ledger_output_mismatch");
    const wrongRevision = { ...lease, headSha: "c".repeat(40) };
    await assert.rejects(store.loadUsableEvidence(wrongRevision, [record.id]),
      (error: unknown) => error instanceof DeepReviewEvidenceError && error.code === "run_scope_mismatch");
    const crossTenant = { ...lease, tenantId: otherTenantId, integrationId: otherIntegrationId };
    await assert.rejects(store.loadUsableEvidence(crossTenant, [record.id]));
  });

  test("canonical candidate IDs may repeat across Runs without aliasing immutable records", async () => {
    const candidateBase = { sourceRole: "security" as const, severity: "high" as const,
      title: "unsafe path", body: "path is not checked",
      location: { path: "src/a.ts", side: "new" as const, startLine: 1, endLine: 1 },
      evidenceIds: [] as string[], crossFileEvidenceIds: [] as string[] };
    const candidate = { id: fingerprint(candidateBase), ...candidateBase };
    const otherRun = await runFixture(tenantId, integrationId);
    const stepKey = "deep.role.security.candidates";
    await insertSucceededStep(lease, stepKey, "coordination", [candidate]);
    await insertSucceededStep(otherRun, stepKey, "coordination", [candidate]);
    await store.registerCandidates(lease, stepKey, [candidate]);
    await store.registerCandidates(otherRun, stepKey, [candidate]);
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) FROM pr_agent_harness.finding_candidates WHERE tenant_id=$1 AND id=$2`,
      [tenantId, candidate.id]);
    assert.equal(Number(rows.rows[0]!.count), 2);
  });

  test("deep ledger rejects a same-tenant integration mismatch and artifact reads stay binding-scoped", async () => {
    const step = await pool.query<{ id: string }>(
      `SELECT id FROM pr_agent_harness.agent_steps
       WHERE tenant_id=$1 AND run_id=$2 AND step_key='deep.role.security.candidates'`,
      [tenantId, lease.runId]);
    await assert.rejects(pool.query(
      `INSERT INTO pr_agent_harness.finding_candidates
         (id,tenant_id,integration_id,run_id,step_id,source_role,head_sha,content_hash,record_json)
       VALUES ($1,$2,$3,$4,$5,'security',$6,$7,'{}'::jsonb)`,
      [fingerprint("mismatched-candidate"), tenantId, sameTenantOtherIntegrationId, lease.runId,
        step.rows[0]!.id, lease.headSha, fingerprint({})]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "23503");
    await pool.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,'{}'::jsonb)`,
      [fingerprint("scoped-artifact"), tenantId, integrationId, lease.runId, lease.headSha, fingerprint({})]);
    await assert.rejects(store.readArtifact({ subjectId: "other-binding", actorType: "user", tenantId,
      integrationId: sameTenantOtherIntegrationId, permissions: ["runs:read"] }, lease.runId), /not found/i);
  });

  test("deep review raw content is scrubbed by the same terminal retention protocol", async () => {
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,
           finished_at=clock_timestamp()-interval '31 days',updated_at=clock_timestamp()-interval '31 days'
       WHERE tenant_id=$1 AND id=$2`, [tenantId, lease.runId]);
    await pool.query(
      `UPDATE pr_agent_harness.job_queue SET status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND run_id=$2`, [tenantId, lease.runId]);
    const applied = await new HarnessMaintenanceStore(pool).apply({ tenantId, olderThanDays: 30 });
    assert.equal(applied.applied, 1);
    const rows = await pool.query<{ result_json: Record<string, unknown>; content_purged_at: Date | null }>(
      "SELECT result_json,content_purged_at FROM pr_agent_harness.evidence_records WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, lease.runId],
    );
    assert.equal(rows.rowCount, 1);
    assert.deepEqual(rows.rows[0]!.result_json, {});
    assert.ok(rows.rows[0]!.content_purged_at);
  });

  async function fixture(tenant: string, integration: string, repository: string): Promise<RunLease> {
    await pool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
          credential_ref,publication_state,publication_generation,authority_version,
          review_execution_mode,execution_mode_generation,review_execution_state,quiescence_receipt)
       VALUES ($1,$2,'github','https://github.example.test',$3,$4,1,'env:GITHUB_TOKEN',
         'active',1,1,'harness_async',1,'active','{}'::jsonb)`,
      [integration, tenant, repository, repository === "acme/deep" ? 1 : repository === "other/deep" ? 2 : 3],
    );
    return runFixture(tenant, integration);
  }

  async function runFixture(tenant: string, integration: string): Promise<RunLease> {
    const runId = randomUUID();
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
          request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,
          tool_version_hash,policy_version_hash,runtime_version_hash,input_json,status,lease_owner,
          lease_expires_at,lease_epoch,authority_generation,execution_mode_generation,deadline_at)
       VALUES ($1,$2,$3,'system','test','deep-test',$4,$5,'review',$6,$7,$8,$8,$8,$8,$8,$8,
         '{}'::jsonb,'running','deep-worker',clock_timestamp()+interval '10 minutes',1,1,1,
         clock_timestamp()+interval '15 minutes')`,
      [runId, tenant, integration, randomUUID(), fingerprint(runId), "0".repeat(40), "a".repeat(40), version],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.job_queue
         (id,tenant_id,run_id,job_kind,status,attempt_count,claimed_run_epoch)
       VALUES ($1,$2,$3,'start','running',1,1)`, [jobId, tenant, runId]);
    return { tenantId: tenant, runId, integrationId: integration, jobId, owner: "deep-worker", epoch: 1,
      jobAttempt: 1, authorityGeneration: 1, executionModeGeneration: 1,
      deadlineAt: new Date(Date.now() + 900_000).toISOString(), baseSha: "0".repeat(40), headSha: "a".repeat(40),
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: {}, limits: {}, runtimeConfig: {}, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() };
  }

  async function insertSucceededStep(
    current: RunLease,
    stepKey: string,
    kind: "tool" | "coordination" | "verification",
    value: unknown,
    requestHash?: string,
    toolName?: string,
  ): Promise<void> {
    const output = { value };
    const outputHash = fingerprint(output);
    const stepId = randomUUID();
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,
          last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'succeeded',$7,$8::jsonb,1,1,clock_timestamp())`,
      [stepId, current.tenantId, current.runId, stepKey, kind, requestHash ?? fingerprint(value),
        outputHash, JSON.stringify(output)],
    );
    await pool.query(
      `INSERT INTO pr_agent_harness.step_attempts
         (id,tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
       VALUES ($1,$2,$3,$4,1,$5,1,'succeeded',clock_timestamp())`,
      [attemptId, current.tenantId, current.runId, stepId, current.owner],
    );
    if (kind === "tool") await pool.query(
      `INSERT INTO pr_agent_harness.tool_calls
         (tenant_id,run_id,step_id,step_attempt_id,tool_kind,tool_name,request_hash,status,result_hash,completed_at)
       VALUES ($1,$2,$3,$4,'repository_read',$5,$6,'succeeded',$7,clock_timestamp())`,
      [current.tenantId, current.runId, stepId, attemptId, toolName, requestHash, outputHash],
    );
  }
}
