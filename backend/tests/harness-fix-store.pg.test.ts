import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { migrateHarness } from "../src/harness/postgres/migrations.js";
import { fingerprint } from "../src/harness/versions.js";
import { HarnessDatabase } from "../src/harness/postgres/database.js";
import { createRunInTransaction } from "../src/harness/postgres/run-store.js";
import { approveFixApprovalInTransaction, consumeFixApprovalInTransaction,
  createApprovalInTransaction, PgFixStore } from "../src/fix/fix-store.js";
import type { FixApprovalIntent, VerificationResult } from "../src/fix/contracts.js";
import { PublicationBatchStore } from "../src/harness/publication-batches.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Fix store PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("fix tests require a disposable database");
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  let appPool: Pool; let appDb: HarnessDatabase;
  const tenantId = randomUUID(); const integrationId = randomUUID();
  const sourceRunId = randomUUID(); const fixRunId = randomUUID(); const stepId = randomUUID();
  const findingId = fingerprint("finding"); const gateId = fingerprint("gate");
  const proposalId = fingerprint("proposal-id"); const proposalHash = fingerprint("proposal");
  const version = fingerprint("version"); const imageDigest = `sha256:${"a".repeat(64)}`;
  const verificationResult: VerificationResult = { outcome: "suggestion_only", reasonCodes: ["relevance_not_verified"],
    baselineTarget: "fail", patchedTarget: "pass", baselineRegression: [],
    patchedRegression: [], relevance: "unknown", logRefs: {}, logHashes: {
      baselineTarget: fingerprint("log-baseline-target"), patchedTarget: fingerprint("log-patched-target"),
      baselineRegression: fingerprint("log-baseline-regression"), patchedRegression: fingerprint("log-patched-regression"),
    },
    imageDigest, policyHash: fingerprint("policy"), proposalHash };

  before(async () => {
    await migrateHarness(pool);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
        CREATE ROLE pr_agent_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$;
    ALTER ROLE pr_agent_app PASSWORD 'app-test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier') THEN
        ALTER ROLE pr_agent_verifier PASSWORD 'verifier-test-password-123' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$`);
    const configured = spawnSync(process.execPath, ["--import", "tsx", "src/harness/cli.ts", "migrate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HARNESS_DATABASE_URL: databaseUrl,
        HARNESS_VERIFIER_PASSWORD: "verifier-test-password-123" },
    });
    if (configured.status !== 0) throw new Error(`runtime grant CLI failed: ${configured.stderr}`);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = "app-test";
    appPool = new Pool({ connectionString: appUrl.toString(), max: 2 }); appDb = new HarnessDatabase(appPool);
    await pool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
          publication_state,publication_generation,authority_version,review_execution_mode,execution_mode_generation,
          review_execution_state,quiescence_receipt)
       VALUES ($1,$2,'github','https://github.example.test','acme/fix',88,1,'env:GITHUB_TOKEN',
         'active',1,1,'harness_async',1,'active','{}'::jsonb)`, [integrationId, tenantId]);
    await insertRun(sourceRunId, "review.deep.v1", "succeeded");
    await insertRun(fixRunId, "fix.propose.v1", "running");
    await pool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'deep.role.security.candidates','coordination',$4,'succeeded',$4,'{"value":{}}'::jsonb,1,1,clock_timestamp())`,
      [stepId, tenantId, sourceRunId, version]);
    const candidate = { id: findingId, sourceRole: "security", severity: "high", title: "unsafe", body: "unsafe value",
      location: { path: "src/a.ts", side: "new", startLine: 1, endLine: 1 }, evidenceIds: [], crossFileEvidenceIds: [] };
    await pool.query(
      `INSERT INTO pr_agent_harness.finding_candidates
         (id,tenant_id,integration_id,run_id,step_id,source_role,head_sha,content_hash,record_json)
       VALUES ($1,$2,$3,$4,$5,'security',$6,$7,$8::jsonb)`,
      [findingId, tenantId, integrationId, sourceRunId, stepId, "2".repeat(40), fingerprint(candidate), JSON.stringify(candidate)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.finding_decisions
         (id,tenant_id,integration_id,run_id,step_id,candidate_id,stage,head_sha,content_hash,record_json)
       VALUES ($1,$2,$3,$4,$5,$6,'gate',$7,$8,'{"accepted":true}'::jsonb)`,
      [gateId, tenantId, integrationId, sourceRunId, stepId, findingId, "2".repeat(40), fingerprint({ accepted: true })]);
    await pool.query(
      `INSERT INTO pr_agent_harness.review_artifacts
         (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
       VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,'{}'::jsonb)`,
      [fingerprint("artifact"), tenantId, integrationId, sourceRunId, "2".repeat(40), fingerprint({})]);
    const source = { tenantId, integrationId, runId: fixRunId, sourceReviewRunId: sourceRunId, findingId,
      platform: "github", repository: "acme/fix", baseSha: "1".repeat(40), headSha: "2".repeat(40),
      sourceBundleRef: "bundle/ref", sourceBundleHash: fingerprint("bundle"), allowedPaths: ["src/a.ts"],
      finding: { title: "unsafe", body: "unsafe value", path: "src/a.ts", startLine: 1, endLine: 1 } };
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_run_sources
         (tenant_id,integration_id,run_id,source_review_run_id,finding_id,repository,base_sha,head_sha,
          source_bundle_ref,source_bundle_hash,allowed_paths_json,source_json,content_hash)
       VALUES ($1,$2,$3,$4,$5,'acme/fix',$6,$7,'bundle/ref',$8,'["src/a.ts"]'::jsonb,$9::jsonb,$10)`,
      [tenantId, integrationId, fixRunId, sourceRunId, findingId, "1".repeat(40), "2".repeat(40),
        source.sourceBundleHash, JSON.stringify(source), fingerprint(source)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_run_findings
         (tenant_id,run_id,source_review_run_id,finding_id,gate_decision_id,finding_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, fixRunId, sourceRunId, findingId, gateId, fingerprint(source.finding)]);
    const proposal = { id: proposalId, tenantId, integrationId, runId: fixRunId, sourceReviewRunId: sourceRunId,
      findingId, revision: 1, repository: "acme/fix", baseSha: "1".repeat(40), headSha: "2".repeat(40),
      sourceBundleRef: "bundle/ref", sourceBundleHash: source.sourceBundleHash, codePatch: "code", testPatch: "test",
      codePatchHash: fingerprint("code"), testPatchHash: fingerprint("test"), proposalHash,
      policyId: "node", policyHash: fingerprint("policy"), trustedCommandHash: fingerprint(["node", "--test"]),
      dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"), sandboxPolicyHash: fingerprint("sandbox"),
      imageDigest, publisherPolicyHash: fingerprint("publisher"), qualificationStatus: "not_verified" };
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_proposals
         (id,tenant_id,integration_id,run_id,source_review_run_id,finding_id,revision,repository,base_sha,head_sha,
          source_bundle_ref,source_bundle_hash,code_patch,test_patch,code_patch_hash,test_patch_hash,proposal_hash,
          policy_id,policy_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
          publisher_policy_hash,qualification_status,proposal_json,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,1,'acme/fix',$7,$8,'bundle/ref',$9,'code','test',$10,$11,$12,
         'node',$13,$14,'package-lock.json',$15,$16,$17,$18,'not_verified',$19::jsonb,$20)`,
      [proposalId, tenantId, integrationId, fixRunId, sourceRunId, findingId, "1".repeat(40), "2".repeat(40),
        source.sourceBundleHash, proposal.codePatchHash, proposal.testPatchHash, proposalHash, proposal.policyHash,
        proposal.trustedCommandHash, proposal.dependencyLockHash, proposal.sandboxPolicyHash, imageDigest,
        proposal.publisherPolicyHash, JSON.stringify(proposal), fingerprint(proposal)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.verification_jobs
         (tenant_id,integration_id,run_id,proposal_id,proposal_hash,source_bundle_ref,source_bundle_hash,policy_hash,
          verification_input_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
          claimed_run_epoch,deadline_at)
       VALUES ($1,$2,$3,$4,$5,'bundle/ref',$6,$7,$8,$9,'package-lock.json',$10,$11,$12,1,clock_timestamp()+interval '5 minutes')`,
      [tenantId, integrationId, fixRunId, proposalId, proposalHash, source.sourceBundleHash, proposal.policyHash,
        fingerprint("verify-input"), proposal.trustedCommandHash, proposal.dependencyLockHash, proposal.sandboxPolicyHash, imageDigest]);
  });
  after(async () => { await appPool?.end(); await pool.end(); });

  test("CLI grants verifier only four SECURITY DEFINER functions and no harness tables", async () => {
    const verifierUrl = new URL(databaseUrl); verifierUrl.username = "pr_agent_verifier";
    verifierUrl.password = "verifier-test-password-123";
    const verifier = new Pool({ connectionString: verifierUrl.toString(), max: 1 });
    try {
      const role = await verifier.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
      const privileges = await verifier.query<{ claim: boolean; heartbeat: boolean; complete: boolean; fail: boolean;
        jobs_select: boolean; runs_select: boolean; verifications_insert: boolean }>(
        `SELECT has_function_privilege(current_user,'pr_agent_harness.claim_verification_job(text,integer)','EXECUTE') AS claim,
          has_function_privilege(current_user,'pr_agent_harness.heartbeat_verification_job(uuid,uuid,text,bigint,integer)','EXECUTE') AS heartbeat,
          has_function_privilege(current_user,'pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text)','EXECUTE') AS complete,
          has_function_privilege(current_user,'pr_agent_harness.fail_verification_job(uuid,uuid,text,bigint,text,integer)','EXECUTE') AS fail,
          has_table_privilege(current_user,'pr_agent_harness.verification_jobs','SELECT') AS jobs_select,
          has_table_privilege(current_user,'pr_agent_harness.agent_runs','SELECT') AS runs_select,
          has_table_privilege(current_user,'pr_agent_harness.fix_verifications','INSERT') AS verifications_insert`);
      assert.deepEqual(privileges.rows[0], { claim: true, heartbeat: true, complete: true, fail: true,
        jobs_select: false, runs_select: false, verifications_insert: false });
    } finally { await verifier.end(); }
  });

  test("verifier SECURITY DEFINER lease fences completion and returns immutable proposal payload", async () => {
    const claim = await pool.query<{ id: string; lease_epoch: string; proposal_json: { proposalHash: string } }>(
      "SELECT * FROM pr_agent_harness.claim_verification_job($1,$2)", ["verifier-a", 60]);
    assert.equal(claim.rowCount, 1); assert.equal(claim.rows[0]!.proposal_json.proposalHash, proposalHash);
    const jobId = claim.rows[0]!.id; const staleEpoch = Number(claim.rows[0]!.lease_epoch);
    await pool.query("UPDATE pr_agent_harness.verification_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [jobId]);
    const reclaimed = await pool.query<{ id: string; lease_epoch: string; attempt_count: number }>(
      "SELECT * FROM pr_agent_harness.claim_verification_job($1,$2)", ["verifier-c", 60]);
    assert.equal(reclaimed.rows[0]!.id, jobId); assert.equal(reclaimed.rows[0]!.attempt_count, 2);
    const epoch = Number(reclaimed.rows[0]!.lease_epoch); assert.ok(epoch > staleEpoch);
    const wrong = await pool.query<{ heartbeat_verification_job: boolean }>(
      "SELECT pr_agent_harness.heartbeat_verification_job($1,$2,$3,$4,$5)", [tenantId, jobId, "verifier-a", staleEpoch, 60]);
    assert.equal(wrong.rows[0]!.heartbeat_verification_job, false);
    const staleComplete = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6)",
      [tenantId, jobId, "verifier-a", staleEpoch, JSON.stringify(verificationResult), fingerprint(verificationResult)]);
    assert.equal(staleComplete.rows[0]!.complete_verification_job, false);
    const completed = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6)",
      [tenantId, jobId, "verifier-c", epoch, JSON.stringify(verificationResult), fingerprint(verificationResult)]);
    assert.equal(completed.rows[0]!.complete_verification_job, true);
    const late = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6)",
      [tenantId, jobId, "verifier-c", epoch, JSON.stringify(verificationResult), fingerprint(verificationResult)]);
    assert.equal(late.rows[0]!.complete_verification_job, false);
  });

  test("exhausted and deadline-expired verifier jobs become failed and are never reclaimed", async () => {
    const secondId = fingerprint("proposal-2"); const secondHash = fingerprint("proposal-hash-2");
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_proposals
       SELECT $3,tenant_id,integration_id,run_id,source_review_run_id,finding_id,2,repository,base_sha,head_sha,
         source_bundle_ref,source_bundle_hash,code_patch,test_patch,code_patch_hash,test_patch_hash,$4,
         policy_id,policy_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
         publisher_policy_hash,qualification_status,
         jsonb_set(jsonb_set(jsonb_set(proposal_json,'{id}',to_jsonb($3::text)),'{proposalHash}',to_jsonb($4::text)),'{revision}','2'::jsonb),
         $5,NULL,clock_timestamp()
       FROM pr_agent_harness.fix_proposals WHERE tenant_id=$1 AND id=$2`,
      [tenantId, proposalId, secondId, secondHash, fingerprint("proposal-content-2")]);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.verification_jobs
         (tenant_id,integration_id,run_id,proposal_id,proposal_hash,source_bundle_ref,source_bundle_hash,policy_hash,
          verification_input_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
          claimed_run_epoch,max_attempts,deadline_at)
       SELECT tenant_id,integration_id,run_id,id,proposal_hash,source_bundle_ref,source_bundle_hash,policy_hash,$3,
         trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,1,1,
         clock_timestamp()+interval '5 minutes'
       FROM pr_agent_harness.fix_proposals WHERE tenant_id=$1 AND id=$2 RETURNING id`,
      [tenantId, secondId, fingerprint("verify-input-2")]);
    const jobId = inserted.rows[0]!.id;
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2)", ["max-owner", 60])).rowCount, 1);
    await pool.query("UPDATE pr_agent_harness.verification_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [jobId]);
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2)", ["must-not-claim", 60])).rowCount, 0);
    let state = await pool.query<{ status: string; error_code: string }>(
      "SELECT status,error_code FROM pr_agent_harness.verification_jobs WHERE id=$1", [jobId]);
    assert.deepEqual(state.rows[0], { status: "failed", error_code: "verification_attempts_exhausted" });
    await pool.query(
      `UPDATE pr_agent_harness.verification_jobs SET status='queued',attempt_count=0,max_attempts=2,
         deadline_at=clock_timestamp()-interval '1 second',completed_at=NULL,error_code=NULL,available_at=clock_timestamp()
       WHERE id=$1`, [jobId]);
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2)", ["deadline-owner", 60])).rowCount, 0);
    state = await pool.query("SELECT status,error_code FROM pr_agent_harness.verification_jobs WHERE id=$1", [jobId]);
    assert.deepEqual(state.rows[0], { status: "failed", error_code: "verification_deadline_expired" });
  });

  test("unknown automated relevance plus an exact human receipt can approve one publish child", async () => {
    const job = await pool.query<{ id: string }>(
      "SELECT id FROM pr_agent_harness.verification_jobs WHERE tenant_id=$1 AND run_id=$2", [tenantId, fixRunId]);
    await pool.query("UPDATE pr_agent_harness.fix_proposals SET qualification_status='verified' WHERE tenant_id=$1 AND id=$2",
      [tenantId, proposalId]);
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_verifications
         (id,tenant_id,integration_id,run_id,proposal_id,verification_job_id,verdict,proposal_hash,policy_hash,result_hash,result_json)
       VALUES ($1,$2,$3,$4,$5,$6,'suggestion_only',$7,$8,$9,$10::jsonb)`,
      [fingerprint("verification"), tenantId, integrationId, fixRunId, proposalId, job.rows[0]!.id,
        proposalHash, verificationResult.policyHash, fingerprint(verificationResult), JSON.stringify(verificationResult)]);
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,
         finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId, fixRunId]);
    const db = appDb; const store = new PgFixStore(db);
    await assert.rejects(store.attestRelevance({ tenantId, integrationId, proposalRunId: fixRunId,
      proposalId, proposalHash: fingerprint("wrong"), testPatchHash: fingerprint("test"), findingId,
      verificationResultHash: fingerprint(verificationResult), rubricVersion: "fix-relevance.v1",
      reason: "The added test directly exercises the reviewed unsafe behavior.", commandKey: "attest-1",
      actor: { type: "user", id: "checker" } }));
    const relevance = await store.attestRelevance({ tenantId, integrationId, proposalRunId: fixRunId,
      proposalId, proposalHash, testPatchHash: fingerprint("test"), findingId,
      verificationResultHash: fingerprint(verificationResult), rubricVersion: "fix-relevance.v1",
      reason: "The added test directly exercises the reviewed unsafe behavior.", commandKey: "attest-1",
      actor: { type: "user", id: "checker" } });
    const intent: FixApprovalIntent = { proposalId, proposalHash, sourceReviewRunId: sourceRunId, findingId,
      headSha: "2".repeat(40), sourceBundleHash: fingerprint("bundle"), codePatchHash: fingerprint("code"),
      testPatchHash: fingerprint("test"), policyHash: verificationResult.policyHash,
      trustedCommandHash: fingerprint(["node", "--test"]), dependencyLockHash: fingerprint("lock"),
      sandboxPolicyHash: fingerprint("sandbox"), verificationResultHash: fingerprint(verificationResult),
      relevanceAttestationHash: fingerprint({ kind: "human", testPatchHash: relevance.testPatchHash,
        attestationHash: relevance.attestationHash }), publisherPolicyHash: fingerprint("publisher"),
      branchNameHash: fingerprint("branch"), publishBaseSha: "2".repeat(40),
      orderedOperationPlanHash: fingerprint("operations") };
    let receipt = await db.transaction(tenantId, (client) => createApprovalInTransaction(client, {
      tenantId, integrationId, proposalRunId: fixRunId, proposalId, intent,
      commandKey: "preview-1",
      maker: { type: "user", id: "maker" }, ttlSeconds: 3_600 }));
    const expiredApprovalId = receipt.approvalId;
    await pool.query("UPDATE pr_agent_harness.fix_approval_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expiredApprovalId]);
    receipt = await db.transaction(tenantId, (client) => createApprovalInTransaction(client, {
      tenantId, integrationId, proposalRunId: fixRunId, proposalId, intent,
      commandKey: "preview-2", maker: { type: "user", id: "maker" }, ttlSeconds: 3_600 }));
    assert.notEqual(receipt.approvalId, expiredApprovalId);
    const generations = await pool.query<{ id: string; status: string; generation: number }>(
      `SELECT id,status,generation FROM pr_agent_harness.fix_approval_requests
       WHERE tenant_id=$1 AND proposal_run_id=$2 ORDER BY generation`, [tenantId, fixRunId]);
    assert.deepEqual(generations.rows, [
      { id: expiredApprovalId, status: "expired", generation: 1 },
      { id: receipt.approvalId, status: "open", generation: 2 },
    ]);
    const approved = await db.transaction(tenantId, (client) => approveFixApprovalInTransaction(client, {
      tenantId, integrationId, approvalId: receipt.approvalId, commandKey: "approve-1",
      requestHash: fingerprint("approve-1"), expectedVersion: receipt.version,
      actor: { type: "user", id: "checker" },
    }, async (transaction, exact) => (await createRunInTransaction(transaction, {
      tenantId, integrationId, actorType: "user", actorId: "checker", parentRunId: exact.proposalRunId,
      createScope: `fix.publish.v1:${integrationId}`, createKey: `approval:${exact.approvalId}`,
      requestHash: exact.intentHash, runType: "fix.publish.v1", baseSha: "1".repeat(40), headSha: "2".repeat(40),
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: { workflow: "fix.publish.v1", approvalId: exact.approvalId }, authorityGeneration: 1,
      executionModeGeneration: 1, runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 2, maxStepAttempts: 2 },
      limits: { maxRunMs: 60_000, maxJobAttempts: 2, maxStepAttempts: 2 },
    })).id));
    assert.equal(approved.status, "approved");
    const child = await pool.query<{ parent_run_id: string }>(
      "SELECT parent_run_id FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, approved.publishRunId]);
    assert.equal(child.rows[0]!.parent_run_id, fixRunId);
    await pool.query(
      "UPDATE pr_agent_harness.integration_bindings SET review_execution_mode='legacy_sync' WHERE tenant_id=$1 AND id=$2",
      [tenantId, integrationId]);
    const batch = await new PublicationBatchStore(db).freeze({ scope: { tenantId, integrationId, platform: "github",
      origin: "https://github.example.test", repository: "acme/fix", target: "pull:1", revision: "2".repeat(40),
      authorityGeneration: 1 }, sourceKey: "fix-consume-before-link", sourceHash: fingerprint("fix-consume-before-link"),
      executionModeGeneration: 1, operations: [{ slot: "preview", payload: { body: "frozen" } }] });
    const operationSetHash = await pool.query<{ operation_set_hash: string }>(
      "SELECT operation_set_hash FROM pr_agent_harness.publication_batches WHERE tenant_id=$1 AND id=$2",
      [tenantId, batch.id]).then(({ rows }) => rows[0]!.operation_set_hash);
    assert.equal((await pool.query(
      "SELECT 1 FROM pr_agent_harness.run_publication_batches WHERE tenant_id=$1 AND batch_id=$2",
      [tenantId, batch.id])).rowCount, 0);
    await db.transaction(tenantId, (client) => consumeFixApprovalInTransaction(client, {
      tenantId, approvalId: receipt.approvalId, publishRunId: approved.publishRunId,
      batchId: batch.id, operationSetHash, intentHash: receipt.intentHash }));
    const consumed = await pool.query<{ status: string; batch_id: string }>(
      `SELECT a.status,c.batch_id FROM pr_agent_harness.fix_approval_requests a
       JOIN pr_agent_harness.fix_approval_consumptions c ON c.tenant_id=a.tenant_id AND c.approval_id=a.id
       WHERE a.tenant_id=$1 AND a.id=$2`, [tenantId, receipt.approvalId]);
    assert.deepEqual(consumed.rows[0], { status: "consumed", batch_id: batch.id });
  });

  async function insertRun(id: string, runType: string, status: "running" | "succeeded"): Promise<void> {
    await pool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
          run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
          policy_version_hash,runtime_version_hash,input_json,status,lease_owner,lease_expires_at,lease_epoch,
          authority_generation,execution_mode_generation,deadline_at,finished_at)
       VALUES ($1,$2,$3,'user','maker',$4,$4,$5,$6,$7,$8,$5,$5,$5,$5,$5,$5,'{}'::jsonb,$9,$10,$11,1,1,1,
         clock_timestamp()+interval '15 minutes',$12)`,
      [id, tenantId, integrationId, runType, version, runType, "1".repeat(40), "2".repeat(40), status,
        status === "running" ? "worker" : null, status === "running" ? new Date(Date.now() + 600_000) : null,
        status === "succeeded" ? new Date() : null]);
  }
}
