import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { enqueueVerificationJob, PgFixVerifierJobStore, verificationResultIdentityHash } from "../../src/fix/verification/jobs.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { createRunInTransaction } from "../../src/agent-runtime/postgres/run-store.js";
import { approveFixApprovalInTransaction, createApprovalInTransaction } from "../../src/fix/approval/store.js";
import { PgFixApprovalStore } from "../../src/fix/approval/store.js";
import type { FixApprovalIntent } from "../../src/fix/approval/contracts.js";
import type { VerificationResult } from "../../src/fix/contracts.js";
import { PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";
import { prepareHarnessRuntimeRoles } from "../support/harness-runtime-roles.js";
import { RunControlError } from "../../src/agent-runtime/runs/control-contracts.js";
import { FixesService } from "../../src/http/fixes/fixes.service.js";
import { RunApiContextService } from "../../src/http/common/run-api-context.service.js";
import { closeAgentRuntime } from "../../src/agent-runtime/runtime.js";
import { PgRunArtifactStore } from "../../src/agent-runtime/artifacts/index.js";
import { prepareSnapshotBundle } from "../../src/fix/persistence/snapshot-bundle.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Fix store PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("fix tests require a disposable database");
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  let appPool: Pool; let appDb: RuntimeDatabase;
  const tenantId = randomUUID(); const integrationId = randomUUID();
  const sourceRunId = randomUUID(); const fixRunId = randomUUID(); const stepId = randomUUID();
  const findingId = fingerprint("finding"); const gateId = fingerprint("gate");
  const proposalId = fingerprint("proposal-id"); const proposalHash = fingerprint("proposal");
  const verifierCapability = fingerprint("verifier-capability-a");
  const otherVerifierCapability = fingerprint("verifier-capability-b");
  let sourceBundleHash = ""; let sourceBundleRef = ""; let verificationInputHash = "";
  const version = fingerprint("version"); const imageDigest = `sha256:${"a".repeat(64)}`;
  const verificationResult: VerificationResult = { outcome: "suggestion_only", reasonCodes: ["relevance_not_verified"],
    baselineTarget: "fail", patchedTarget: "pass", baselineRegression: [],
    patchedRegression: [], relevance: "unknown", logRefs: {}, logHashes: {
      baselineTarget: fingerprint("log-baseline-target"), patchedTarget: fingerprint("log-patched-target"),
      baselineRegression: fingerprint("log-baseline-regression"), patchedRegression: fingerprint("log-patched-regression"),
    },
    imageDigest, policyHash: fingerprint("policy"), proposalHash };

  before(async () => {
    process.env.FEATURE_FIX = "on";
    process.env.FIX_DEFAULT_POLICY_ID = "fix-store-fixture";
    await prepareHarnessRuntimeRoles(pool, { app: "app-test", verifier: "verifier-test-password-123" });
    await migrateRuntime(pool);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = "app-test";
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    appPool = new Pool({ connectionString: appUrl.toString(), max: 2 }); appDb = new RuntimeDatabase(appPool);
    await pool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
          publication_state,publication_generation,authority_version,review_execution_mode,execution_mode_generation,
          review_execution_state,quiescence_receipt,fix_enabled)
       VALUES ($1,$2,'github','https://github.example.test','acme/fix',88,1,'env:GITHUB_TOKEN',
         'active',1,1,'harness_async',1,'active','{}'::jsonb,true)`, [integrationId, tenantId]);
    await insertRun(sourceRunId, "review.deep.v1", "succeeded");
    await insertRun(fixRunId, "fix.propose.v1", "running");
    const snapshot = await prepareSnapshotBundle({ headSha: "2".repeat(40),
      dependencyLockHash: fingerprint("lock"), files: [
        { path: "package-lock.json", content: Buffer.from("{}\n") },
        { path: "src/a.ts", content: Buffer.from("export const value = 1;\n") },
      ] });
    sourceBundleHash = snapshot.sourceBundleHash; sourceBundleRef = snapshot.sourceBundleRef;
    verificationInputHash = fingerprint({ proposalHash, sourceBundleHash,
      policyHash: fingerprint("policy"), trustedCommandHash: fingerprint(["node", "--test"]),
      dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
      sandboxPolicyHash: fingerprint("sandbox"), verifierCapabilityHash: verifierCapability });
    const artifacts = new PgRunArtifactStore(appDb);
    await appDb.transaction(tenantId, async (client) => {
      await artifacts.putPreparedInTransaction(client, { tenantId, integrationId, runId: fixRunId }, snapshot.artifact);
      await artifacts.holdInTransaction(client, { tenantId, integrationId, runId: fixRunId },
        sourceBundleHash, `fix-source:${fixRunId}`, "fix");
    });
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
      sourceBundleRef, sourceBundleHash, allowedPaths: ["src/a.ts"],
      finding: { title: "unsafe", body: "unsafe value", path: "src/a.ts", startLine: 1, endLine: 1 } };
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_run_sources
         (tenant_id,integration_id,run_id,source_review_run_id,finding_id,repository,base_sha,head_sha,
          source_bundle_ref,source_bundle_hash,allowed_paths_json,source_json,content_hash)
       VALUES ($1,$2,$3,$4,$5,'acme/fix',$6,$7,$8,$9,'["src/a.ts"]'::jsonb,$10::jsonb,$11)`,
      [tenantId, integrationId, fixRunId, sourceRunId, findingId, "1".repeat(40), "2".repeat(40),
        sourceBundleRef, source.sourceBundleHash, JSON.stringify(source), fingerprint(source)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_run_findings
         (tenant_id,run_id,source_review_run_id,finding_id,gate_decision_id,finding_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, fixRunId, sourceRunId, findingId, gateId, fingerprint(source.finding)]);
    const proposal = { id: proposalId, tenantId, integrationId, runId: fixRunId, sourceReviewRunId: sourceRunId,
      findingId, revision: 1, repository: "acme/fix", baseSha: "1".repeat(40), headSha: "2".repeat(40),
      sourceBundleRef, sourceBundleHash: source.sourceBundleHash, codePatch: "code", testPatch: "test",
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
       VALUES ($1,$2,$3,$4,$5,$6,1,'acme/fix',$7,$8,$9,$10,'code','test',$11,$12,$13,
         'node',$14,$15,'package-lock.json',$16,$17,$18,$19,'not_verified',$20::jsonb,$21)`,
      [proposalId, tenantId, integrationId, fixRunId, sourceRunId, findingId, "1".repeat(40), "2".repeat(40),
        sourceBundleRef, source.sourceBundleHash, proposal.codePatchHash, proposal.testPatchHash, proposalHash, proposal.policyHash,
        proposal.trustedCommandHash, proposal.dependencyLockHash, proposal.sandboxPolicyHash, imageDigest,
        proposal.publisherPolicyHash, JSON.stringify(proposal), fingerprint(proposal)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.verification_jobs
         (tenant_id,integration_id,run_id,proposal_id,proposal_hash,source_bundle_ref,source_bundle_hash,policy_hash,
          verifier_capability_hash,verification_input_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
          claimed_run_epoch,deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'package-lock.json',$12,$13,$14,1,clock_timestamp()+interval '5 minutes')`,
      [tenantId, integrationId, fixRunId, proposalId, proposalHash, sourceBundleRef, source.sourceBundleHash, proposal.policyHash,
        verifierCapability, verificationInputHash, proposal.trustedCommandHash, proposal.dependencyLockHash,
        proposal.sandboxPolicyHash, imageDigest]);
  });
  after(async () => { await closeAgentRuntime(); await appPool?.end(); await pool.end(); });

  test("versioned migration grants verifier only bounded SECURITY DEFINER functions and no harness tables", async () => {
    const verifierUrl = new URL(databaseUrl); verifierUrl.username = "pr_agent_verifier";
    verifierUrl.password = "verifier-test-password-123";
    const verifier = new Pool({ connectionString: verifierUrl.toString(), max: 1 });
    try {
      const role = await verifier.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
      const privileges = await verifier.query<{ claim: boolean; heartbeat: boolean; complete: boolean; relinquish: boolean; fail: boolean;
        snapshot: boolean; jobs_select: boolean; runs_select: boolean; artifacts_select: boolean; verifications_insert: boolean }>(
        `SELECT has_function_privilege(current_user,'pr_agent_harness.claim_verification_job(text,integer,text)','EXECUTE') AS claim,
          has_function_privilege(current_user,'pr_agent_harness.heartbeat_verification_job(uuid,uuid,text,bigint,integer)','EXECUTE') AS heartbeat,
          has_function_privilege(current_user,'pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text,text,text,text)','EXECUTE') AS complete,
          has_function_privilege(current_user,'pr_agent_harness.relinquish_verification_job(uuid,uuid,text,bigint)','EXECUTE') AS relinquish,
          has_function_privilege(current_user,'pr_agent_harness.fail_verification_job(uuid,uuid,text,bigint,text,integer)','EXECUTE') AS fail,
          has_function_privilege(current_user,'pr_agent_harness.read_leased_verification_snapshot(uuid,uuid,text,bigint,text)','EXECUTE') AS snapshot,
          has_table_privilege(current_user,'pr_agent_harness.verification_jobs','SELECT') AS jobs_select,
          has_table_privilege(current_user,'pr_agent_harness.agent_runs','SELECT') AS runs_select,
          has_table_privilege(current_user,'pr_agent_harness.run_artifacts','SELECT') AS artifacts_select,
          has_table_privilege(current_user,'pr_agent_harness.fix_verifications','INSERT') AS verifications_insert`);
      assert.deepEqual(privileges.rows[0], { claim: true, heartbeat: true, complete: true, relinquish: true, fail: true,
        snapshot: true, jobs_select: false, runs_select: false, artifacts_select: false, verifications_insert: false });
    } finally { await verifier.end(); }
  });

  test("verifier SECURITY DEFINER lease fences completion and returns immutable proposal payload", async () => {
    await pool.query("UPDATE pr_agent_harness.verification_jobs SET verifier_capability_hash=NULL WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixRunId]);
    const legacyBefore = await pool.query("SELECT status,attempt_count,lease_epoch FROM pr_agent_harness.verification_jobs WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixRunId]);
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)",
      ["legacy-must-wait", 60, verifierCapability])).rowCount, 0);
    assert.deepEqual((await pool.query("SELECT status,attempt_count,lease_epoch FROM pr_agent_harness.verification_jobs WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixRunId])).rows, legacyBefore.rows, "legacy NULL capability jobs wait for an explicit migration");
    await pool.query("UPDATE pr_agent_harness.verification_jobs SET verifier_capability_hash=$3 WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixRunId, verifierCapability]);
    const beforeMismatch = await pool.query("SELECT status,attempt_count,lease_epoch FROM pr_agent_harness.verification_jobs WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixRunId]);
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)",
      ["wrong-verifier", 60, otherVerifierCapability])).rowCount, 0);
    const afterMismatch = await pool.query("SELECT status,attempt_count,lease_epoch FROM pr_agent_harness.verification_jobs WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, fixRunId]);
    assert.deepEqual(afterMismatch.rows, beforeMismatch.rows, "an incompatible verifier must perform zero job writes");
    const verifierUrl = new URL(databaseUrl); verifierUrl.username = "pr_agent_verifier";
    verifierUrl.password = "verifier-test-password-123";
    const verifier = new Pool({ connectionString: verifierUrl.toString(), max: 1 });
    try {
      const verifierStore = new PgFixVerifierJobStore(verifier);
      const claimed = await verifierStore.claim("verifier-a", verifierCapability);
      assert.ok(claimed); assert.equal(claimed.proposal.proposalHash, proposalHash);
      const jobId = claimed.id; const staleEpoch = claimed.epoch;
      const snapshotContent = await verifierStore.readSnapshot(claimed);
      assert.equal(fingerprint(JSON.parse(snapshotContent.toString("utf8"))), sourceBundleHash);
      const exact = await verifier.query<{ artifact_hash: string; content_compressed: Buffer }>(
        "SELECT * FROM pr_agent_harness.read_leased_verification_snapshot($1,$2,$3,$4,$5)",
        [tenantId, jobId, "verifier-a", staleEpoch, sourceBundleHash]);
      assert.equal(exact.rows[0]?.artifact_hash, sourceBundleHash);
      assert.ok(exact.rows[0]!.content_compressed.byteLength > 0);
      assert.equal((await verifier.query(
        "SELECT * FROM pr_agent_harness.read_leased_verification_snapshot($1,$2,$3,$4,$5)",
        [tenantId, jobId, "wrong-owner", staleEpoch, sourceBundleHash])).rowCount, 0);
      assert.equal((await verifier.query(
        "SELECT * FROM pr_agent_harness.read_leased_verification_snapshot($1,$2,$3,$4,$5)",
        [tenantId, jobId, "verifier-a", staleEpoch + 1, sourceBundleHash])).rowCount, 0);
      await assert.rejects(verifier.query("SELECT * FROM pr_agent_harness.run_artifacts"), /permission denied/);
      await pool.query("UPDATE pr_agent_harness.verification_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [jobId]);
      const reclaimed = await verifierStore.claim("verifier-c", verifierCapability);
      assert.ok(reclaimed); assert.equal(reclaimed.id, jobId); assert.equal(reclaimed.attempt, 2);
      const epoch = reclaimed.epoch; assert.ok(epoch > staleEpoch);
    const wrong = await pool.query<{ heartbeat_verification_job: boolean }>(
      "SELECT pr_agent_harness.heartbeat_verification_job($1,$2,$3,$4,$5)", [tenantId, jobId, "verifier-a", staleEpoch, 60]);
    assert.equal(wrong.rows[0]!.heartbeat_verification_job, false);
    const resumedInputHash = fingerprint({ proposalHash, sourceBundleHash,
        policyHash: fingerprint("policy"), trustedCommandHash: fingerprint(["node", "--test"]),
        dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
        sandboxPolicyHash: fingerprint("sandbox"), verifierCapabilityHash: otherVerifierCapability });
    assert.equal(await appDb.transaction(tenantId, (client) => enqueueVerificationJob(client, {
        tenantId, integrationId, runId: fixRunId,
        proposalId, proposalHash, sourceBundleRef, sourceBundleHash,
        policyHash: fingerprint("policy"), verifierCapabilityHash: otherVerifierCapability,
        verificationInputHash: resumedInputHash, trustedCommandHash: fingerprint(["node", "--test"]),
        dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
        sandboxPolicyHash: fingerprint("sandbox"), imageDigest, claimedRunEpoch: 99 })), jobId,
      "a resumed Run must keep waiting on the already leased old-capability verifier job");
    const staleComplete = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
      [tenantId, jobId, "verifier-a", staleEpoch, JSON.stringify(verificationResult), fingerprint(verificationResult),
        verificationInputHash, verifierCapability,
        verificationResultIdentityHash(fingerprint(verificationResult), verificationInputHash, verifierCapability)]);
    assert.equal(staleComplete.rows[0]!.complete_verification_job, false);
    const wrongScope = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
      [tenantId, jobId, "verifier-c", epoch, JSON.stringify(verificationResult), fingerprint(verificationResult),
        verificationInputHash, otherVerifierCapability,
        verificationResultIdentityHash(fingerprint(verificationResult), verificationInputHash, otherVerifierCapability)]);
    assert.equal(wrongScope.rows[0]!.complete_verification_job, false);
    const completed = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
      [tenantId, jobId, "verifier-c", epoch, JSON.stringify(verificationResult), fingerprint(verificationResult),
        verificationInputHash, verifierCapability,
        verificationResultIdentityHash(fingerprint(verificationResult), verificationInputHash, verifierCapability)]);
    assert.equal(completed.rows[0]!.complete_verification_job, true);
    const late = await pool.query<{ complete_verification_job: boolean }>(
      "SELECT pr_agent_harness.complete_verification_job($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
      [tenantId, jobId, "verifier-c", epoch, JSON.stringify(verificationResult), fingerprint(verificationResult),
        verificationInputHash, verifierCapability,
        verificationResultIdentityHash(fingerprint(verificationResult), verificationInputHash, verifierCapability)]);
    assert.equal(late.rows[0]!.complete_verification_job, false);
    } finally { await verifier.end(); }
  });

  test("a resumed FixRun reuses the old verifier capability and completed job after a verifier-only rollout", async () => {
      const newInputHash = fingerprint({ proposalHash, sourceBundleHash,
        policyHash: fingerprint("policy"), trustedCommandHash: fingerprint(["node", "--test"]),
        dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
        sandboxPolicyHash: fingerprint("sandbox"), verifierCapabilityHash: otherVerifierCapability });
      const reused = await appDb.transaction(tenantId, (client) => enqueueVerificationJob(client, {
        tenantId, integrationId, runId: fixRunId,
        proposalId, proposalHash, sourceBundleRef, sourceBundleHash,
        policyHash: fingerprint("policy"), verifierCapabilityHash: otherVerifierCapability,
        verificationInputHash: newInputHash, trustedCommandHash: fingerprint(["node", "--test"]),
        dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
        sandboxPolicyHash: fingerprint("sandbox"), imageDigest, claimedRunEpoch: 99 }));
      const frozen = await pool.query<{ id: string; verifier_capability_hash: string;
        verification_input_hash: string; status: string; result_hash: string }>(
        "SELECT id,verifier_capability_hash,verification_input_hash,status,result_hash FROM pr_agent_harness.verification_jobs WHERE id=$1",
        [reused]);
      assert.deepEqual(frozen.rows[0], { id: reused, verifier_capability_hash: verifierCapability,
        verification_input_hash: verificationInputHash, status: "succeeded", result_hash: fingerprint(verificationResult) });
      await assert.rejects(appDb.transaction(tenantId, (client) => enqueueVerificationJob(client, {
        tenantId, integrationId, runId: fixRunId,
        proposalId, proposalHash: fingerprint("different"), sourceBundleRef, sourceBundleHash,
        policyHash: fingerprint("policy"), verifierCapabilityHash: otherVerifierCapability,
        verificationInputHash: newInputHash, trustedCommandHash: fingerprint(["node", "--test"]),
        dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
        sandboxPolicyHash: fingerprint("sandbox"), imageDigest, claimedRunEpoch: 99 })), /input hash mismatch|identity conflict/);
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
          verifier_capability_hash,verification_input_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
          claimed_run_epoch,max_attempts,deadline_at)
       SELECT tenant_id,integration_id,run_id,id,proposal_hash,source_bundle_ref,source_bundle_hash,policy_hash,$3,$4,
         trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,1,1,
         clock_timestamp()+interval '5 minutes'
       FROM pr_agent_harness.fix_proposals WHERE tenant_id=$1 AND id=$2 RETURNING id`,
      [tenantId, secondId, verifierCapability, fingerprint("verify-input-2")]);
    const jobId = inserted.rows[0]!.id;
    for (let rolling = 0; rolling < 3; rolling += 1) {
      const rollingClaim = await pool.query<{ lease_epoch: string }>(
        "SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)",
        [`rolling-${rolling}`, 60, verifierCapability]);
      assert.equal(rollingClaim.rowCount, 1);
      const relinquished = await pool.query<{ relinquish_verification_job: boolean }>(
        "SELECT pr_agent_harness.relinquish_verification_job($1,$2,$3,$4)",
        [tenantId, jobId, `rolling-${rolling}`, Number(rollingClaim.rows[0]!.lease_epoch)]);
      assert.equal(relinquished.rows[0]!.relinquish_verification_job, true);
      const state = await pool.query("SELECT status,attempt_count FROM pr_agent_harness.verification_jobs WHERE id=$1", [jobId]);
      assert.deepEqual(state.rows[0], { status: "queued", attempt_count: 0 });
    }
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)", ["max-owner", 60, verifierCapability])).rowCount, 1);
    await pool.query("UPDATE pr_agent_harness.verification_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [jobId]);
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)", ["must-not-claim", 60, verifierCapability])).rowCount, 0);
    let state = await pool.query<{ status: string; error_code: string }>(
      "SELECT status,error_code FROM pr_agent_harness.verification_jobs WHERE id=$1", [jobId]);
    assert.deepEqual(state.rows[0], { status: "failed", error_code: "verification_attempts_exhausted" });
    await pool.query(
      `UPDATE pr_agent_harness.verification_jobs SET status='queued',attempt_count=0,max_attempts=2,
         deadline_at=clock_timestamp()-interval '1 second',completed_at=NULL,error_code=NULL,available_at=clock_timestamp()
       WHERE id=$1`, [jobId]);
    assert.equal((await pool.query("SELECT * FROM pr_agent_harness.claim_verification_job($1,$2,$3)", ["deadline-owner", 60, verifierCapability])).rowCount, 0);
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
    const db = appDb; const store = new PgFixApprovalStore(db);
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
    await setFixCapability(false);
    assert.equal((await store.attestRelevance({ tenantId, integrationId, proposalRunId: fixRunId,
      proposalId, proposalHash, testPatchHash: fingerprint("test"), findingId,
      verificationResultHash: fingerprint(verificationResult), rubricVersion: "fix-relevance.v1",
      reason: "The added test directly exercises the reviewed unsafe behavior.", commandKey: "attest-1",
      actor: { type: "user", id: "checker" } })).id, relevance.id);
    await assert.rejects(store.attestRelevance({ tenantId, integrationId, proposalRunId: fixRunId,
      proposalId, proposalHash, testPatchHash: fingerprint("test"), findingId,
      verificationResultHash: fingerprint(verificationResult), rubricVersion: "fix-relevance.v1",
      reason: "The added test directly exercises the reviewed unsafe behavior.", commandKey: "attest-disabled",
      actor: { type: "user", id: "checker" } }),
    (error: unknown) => error instanceof RunControlError && error.code === "CAPABILITY_DISABLED");
    await setFixCapability(true);
    const intent: FixApprovalIntent = { proposalId, proposalHash, sourceReviewRunId: sourceRunId, findingId,
      headSha: "2".repeat(40), sourceBundleHash, codePatchHash: fingerprint("code"),
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
    await setFixCapability(false);
    assert.equal((await db.transaction(tenantId, (client) => createApprovalInTransaction(client, {
      tenantId, integrationId, proposalRunId: fixRunId, proposalId, intent,
      commandKey: "preview-2", maker: { type: "user", id: "maker" }, ttlSeconds: 3_600 }))).approvalId,
    receipt.approvalId);
    await assert.rejects(db.transaction(tenantId, (client) => createApprovalInTransaction(client, {
      tenantId, integrationId, proposalRunId: fixRunId, proposalId, intent,
      commandKey: "preview-disabled", maker: { type: "user", id: "maker" }, ttlSeconds: 3_600 })),
    (error: unknown) => error instanceof RunControlError && error.code === "CAPABILITY_DISABLED");
    await setFixCapability(true);
    const generations = await pool.query<{ id: string; status: string; generation: number }>(
      `SELECT id,status,generation FROM pr_agent_harness.fix_approval_requests
       WHERE tenant_id=$1 AND proposal_run_id=$2 ORDER BY generation`, [tenantId, fixRunId]);
    assert.deepEqual(generations.rows, [
      { id: expiredApprovalId, status: "expired", generation: 1 },
      { id: receipt.approvalId, status: "open", generation: 2 },
    ]);
    await pool.query(
      `UPDATE pr_agent_harness.agent_runs
       SET finished_at=clock_timestamp()-interval '31 days',updated_at=clock_timestamp()-interval '31 days'
       WHERE tenant_id=$1 AND id=$2`, [tenantId, fixRunId],
    );
    const retentionEligible = await pool.query<{ eligible: boolean }>(
      "SELECT pr_agent_harness.fix_hold_releasable($1,$2,30) eligible",
      [tenantId, fixRunId],
    );
    assert.equal(retentionEligible.rows[0]!.eligible, false,
      "an unexpired human approval blocks release after the content window");
    const createPublishRun = async (transaction: Parameters<typeof createRunInTransaction>[0], exact: {
      proposalRunId: string; approvalId: string; intentHash: string;
    }) => (await createRunInTransaction(transaction, {
      tenantId, integrationId, actorType: "user", actorId: "checker", parentRunId: exact.proposalRunId,
      createScope: `fix.publish.v1:${integrationId}`, createKey: `approval:${exact.approvalId}`,
      requestHash: exact.intentHash, runType: "fix.publish.v1", baseSha: "1".repeat(40), headSha: "2".repeat(40),
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: { workflow: "fix.publish.v1", approvalId: exact.approvalId }, authorityGeneration: 1,
      executionModeGeneration: 1, runtimeConfig: { maxRunMs: 60_000, maxJobAttempts: 2, maxStepAttempts: 2 },
      limits: { maxRunMs: 60_000, maxJobAttempts: 2, maxStepAttempts: 2 },
    })).id;
    await setFixCapability(false);
    await assert.rejects(db.transaction(tenantId, (client) => approveFixApprovalInTransaction(client, {
      tenantId, integrationId, approvalId: receipt.approvalId, commandKey: "approve-disabled",
      requestHash: fingerprint("approve-disabled"), expectedVersion: receipt.version,
      actor: { type: "user", id: "checker" },
    }, createPublishRun)),
    (error: unknown) => error instanceof RunControlError && error.code === "CAPABILITY_DISABLED");
    assert.equal((await pool.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND parent_run_id=$2",
      [tenantId, fixRunId])).rows[0]!.count, "0");
    await setFixCapability(true);
    const approved = await db.transaction(tenantId, (client) => approveFixApprovalInTransaction(client, {
      tenantId, integrationId, approvalId: receipt.approvalId, commandKey: "approve-1",
      requestHash: fingerprint("approve-1"), expectedVersion: receipt.version,
      actor: { type: "user", id: "checker" },
    }, createPublishRun));
    assert.equal(approved.status, "approved");
    const child = await pool.query<{ parent_run_id: string }>(
      "SELECT parent_run_id FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, approved.publishRunId]);
    assert.equal(child.rows[0]!.parent_run_id, fixRunId);
    await setFixCapability(false); process.env.FEATURE_FIX = "off";
    try {
      const revoked = await new FixesService({} as RunApiContextService).revokeFix({
        tenantId, integrationId, subjectId: "maker", actorType: "user", permissions: ["fixes:revoke"],
      }, fixRunId, receipt.approvalId, { commandKey: "revoke-disabled", intentHash: fingerprint(intent),
        expectedVersion: approved.version });
      assert.equal(revoked.status, "revoked");
    } finally {
      process.env.FEATURE_FIX = "on"; await setFixCapability(true);
    }
    await assert.rejects(
      new PublicationBatchStore(db).freeze({ scope: { tenantId, integrationId, platform: "github",
        origin: "https://github.example.test", repository: "acme/fix", target: "pull:1", revision: "2".repeat(40),
        authorityGeneration: 1 }, sourceKey: "fix-consume-before-link", sourceHash: fingerprint("fix-consume-before-link"),
        operations: [{ slot: "preview", payload: { body: "frozen" } }] } as never),
      /active Run lease/,
    );
    const retention = await pool.connect();
    let approvalSettled = false;
    try {
      await retention.query("BEGIN");
      await retention.query(
        "SELECT 1 FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, fixRunId],
      );
      await retention.query(
        `INSERT INTO pr_agent_harness.run_artifact_hold_releases
           (tenant_id,integration_id,run_id,artifact_hash,hold_key)
         SELECT tenant_id,integration_id,run_id,artifact_hash,hold_key
         FROM pr_agent_harness.run_artifact_holds
         WHERE tenant_id=$1 AND run_id=$2 AND artifact_hash=$3 AND hold_key=$4`,
        [tenantId, fixRunId, sourceBundleHash, `fix-source:${fixRunId}`],
      );
      const lateApproval = db.transaction(tenantId, (client) => createApprovalInTransaction(client, {
        tenantId, integrationId, proposalRunId: fixRunId, proposalId, intent,
        commandKey: "preview-after-retention-closed",
        maker: { type: "user", id: "maker" }, ttlSeconds: 3_600,
      })).finally(() => { approvalSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(approvalSettled, false, "approval creation waits for the proposal Run retention lock");
      await retention.query("COMMIT");
      await assert.rejects(lateApproval, /approval_retention_closed/);
    } catch (error) {
      await retention.query("ROLLBACK");
      throw error;
    } finally { retention.release(); }
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

  async function setFixCapability(enabled: boolean): Promise<void> {
    await pool.query(`UPDATE pr_agent_harness.integration_bindings
      SET fix_enabled=$3,authority_version=authority_version+1 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, integrationId, enabled]);
  }
}
