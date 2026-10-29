import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { consumeFixApprovalInTransaction, revokeApprovalInTransaction } from "../../src/fix/approval/store.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { PublicationBatchCoordinator, PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";
import { PgPublicationStore, PublicationService, type PublicationAdapter } from "../../src/agent-runtime/publication/publication.js";
import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import type { ModelBudgetStore } from "../../src/agent-runtime/budget/model-budget-store.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";
import type { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { RunWorker } from "../../src/agent-runtime/execution/run-worker.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Fix publish PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("fix publish tests require a disposable database");

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const appPassword = randomUUID();
  let appPool: Pool;
  let appDb: RuntimeDatabase;
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const sourceRunId = randomUUID();
  const proposalRunId = randomUUID();
  const publishRunId = randomUUID();
  const approvalId = randomUUID();
  const proposalId = fingerprint("publish-proposal");
  const findingId = fingerprint("publish-finding");
  const version = fingerprint("publish-version");
  const intent = {
    proposalId,
    proposalHash: fingerprint("proposal-hash"),
    operations: [
      { operationType: "fix_branch" as const, slot: "fix.branch", payload: { branch: "pr-agent/fix-a" } },
      { operationType: "fix_commit" as const, slot: "fix.commit", payload: { commit: "approved" } },
      { operationType: "fix_draft_pr" as const, slot: "fix.draft_pr", payload: { draft: true } },
    ],
  };
  const intentHash = fingerprint(intent);
  let lease: RunLease;

  before(async () => {
    await migrateRuntime(pool);
    const appRole = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app'");
    const roleDdl = await pool.query<{ sql: string }>(appRole.rowCount
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) AS sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pr_agent_app',$1::text) AS sql",
    [appPassword]);
    await pool.query(roleDdl.rows[0]!.sql);
    const configured = spawnSync(process.execPath, ["--import", "tsx", "src/agent-runtime/cli.ts", "migrate"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HARNESS_DATABASE_URL: databaseUrl },
    });
    if (configured.status !== 0) throw new Error(`runtime grant CLI failed: ${configured.stderr}`);
    const appUrl = new URL(databaseUrl); appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
    appPool = new Pool({ connectionString: appUrl.toString(), max: 4 });
    appDb = new RuntimeDatabase(appPool);
    await pool.query(
      `INSERT INTO pr_agent_harness.integration_bindings
         (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
          publication_state,publication_generation,authority_version,review_execution_mode,execution_mode_generation,
          review_execution_state,quiescence_receipt)
       VALUES ($1,$2,'github','https://github.example.test','acme/fix',88,1,'env:GITHUB_TOKEN',
         'active',1,1,'harness_async',1,'active','{}'::jsonb)`,
      [integrationId, tenantId],
    );
    await insertRun(sourceRunId, "review.deep.v1", "succeeded", {});
    await insertRun(proposalRunId, "fix.propose.v1", "succeeded", {});
    await insertRun(publishRunId, "fix.publish.v1", "running", {
      workflow: "fix.publish.v1", approvalId, intentHash, proposalRunId,
    });
    lease = {
      tenantId, integrationId, runId: publishRunId, jobId: randomUUID(), owner: "fix.publish.v1-owner", epoch: 1,
      jobAttempt: 1, authorityGeneration: 1, executionModeGeneration: 1,
      deadlineAt: new Date(Date.now() + 600_000).toISOString(), baseSha: "1".repeat(40), headSha: "2".repeat(40),
      workflowVersionHash: version, promptVersionHash: version, modelVersionHash: version,
      toolVersionHash: version, policyVersionHash: version, runtimeVersionHash: version,
      input: { workflow: "fix.publish.v1", approvalId, intentHash, proposalRunId },
      limits: {}, runtimeConfig: {}, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    await seedProposal();
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_approval_requests
         (id,tenant_id,integration_id,proposal_run_id,proposal_id,command_key,generation,intent_hash,intent_json,
          maker_actor_type,maker_actor_id,status,version,expires_at,approved_publish_run_id,approved_at)
       VALUES ($1,$2,$3,$4,$5,'preview-publish',1,$6,$7::jsonb,'user','maker','approved',2,
         clock_timestamp()+interval '1 hour',$8,clock_timestamp())`,
      [approvalId, tenantId, integrationId, proposalRunId, proposalId, intentHash, JSON.stringify(intent), publishRunId],
    );
  });

  after(async () => { await appPool?.end(); await pool.end(); });

  test("consumes an exact approval in the sealing transaction before dispatching the batch once", async () => {
    const batchStore = new PublicationBatchStore(appDb);
    const batch = await batchStore.freeze({
      runLease: lease,
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/fix", target: "7", revision: "2".repeat(40), authorityGeneration: 1 },
      sourceKey: `fix.approval:${approvalId}`,
      sourceHash: intentHash,
      operations: intent.operations,
      authorize: async (client, frozen) => {
        const sealed = await client.query<{ operation_set_hash: string }>(
          `SELECT operation_set_hash FROM pr_agent_harness.publication_batches
           WHERE tenant_id=$1 AND id=$2 AND seal_state='sealed'`,
          [tenantId, frozen.id],
        );
        await consumeFixApprovalInTransaction(client, { tenantId, approvalId, publishRunId,
          batchId: frozen.id, operationSetHash: sealed.rows[0]!.operation_set_hash, intentHash });
      },
    });
    const consumption = await pool.query<{ status: string; batch_id: string }>(
      `SELECT a.status,c.batch_id FROM pr_agent_harness.fix_approval_requests a
       JOIN pr_agent_harness.fix_approval_consumptions c ON c.tenant_id=a.tenant_id AND c.approval_id=a.id
       WHERE a.tenant_id=$1 AND a.id=$2`, [tenantId, approvalId]);
    assert.deepEqual(consumption.rows[0], { status: "consumed", batch_id: batch.id });

    let dispatches = 0;
    const adapter: PublicationAdapter = {
      dispatch: async (_marker, _payload, operation) => ({ id: `${operation.operationType}-${++dispatches}` }),
      find: async () => null,
    };
    const coordinator = new PublicationBatchCoordinator(batchStore,
      new PublicationService(new PgPublicationStore(appDb)));
    const completed = await coordinator.execute(tenantId, batch.id, async () => adapter, lease);
    assert.equal(completed.status, "succeeded");
    assert.equal(dispatches, 3);

    const replayed = await coordinator.execute(tenantId, batch.id, async () => adapter, lease);
    assert.equal(replayed.status, "succeeded");
    assert.equal(dispatches, 3, "a completed approved batch must not dispatch again");
  });

  test("does not dispatch a fix batch whose approval callback did not consume an approval", async () => {
    const unapprovedRunId = randomUUID();
    await insertRun(unapprovedRunId, "fix.publish.v1", "running", { workflow: "fix.publish.v1" });
    const unapprovedLease = { ...lease, runId: unapprovedRunId, owner: "fix.publish.v1-owner" };
    const batchStore = new PublicationBatchStore(appDb);
    const sourceHash = fingerprint("unapproved-plan");
    const batch = await batchStore.freeze({
      runLease: unapprovedLease,
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/fix", target: "8", revision: "2".repeat(40), authorityGeneration: 1 },
      sourceKey: `fix.unapproved:${unapprovedRunId}`,
      sourceHash,
      operations: [{ operationType: "fix_commit", slot: "fix.commit", payload: { commit: "unapproved" } }],
      authorize: async () => undefined,
    });
    let dispatches = 0;
    const coordinator = new PublicationBatchCoordinator(batchStore,
      new PublicationService(new PgPublicationStore(appDb)));
    await assert.rejects(coordinator.execute(tenantId, batch.id, async () => ({
      dispatch: async () => { dispatches += 1; return { id: "must-not-dispatch" }; },
      find: async () => null,
    }), unapprovedLease), /no matching consumed approval/);
    assert.equal(dispatches, 0);
  });

  test("rejects replaying one consumed approval against a different batch", async () => {
    const consumed = await pool.query<{ batch_id: string; operation_set_hash: string }>(
      `SELECT batch_id,operation_set_hash FROM pr_agent_harness.fix_approval_consumptions
       WHERE tenant_id=$1 AND approval_id=$2`, [tenantId, approvalId]);
    assert.equal(consumed.rowCount, 1);
    await assert.rejects(appDb.transaction(tenantId, (client) => consumeFixApprovalInTransaction(client, {
      tenantId, approvalId, publishRunId, batchId: randomUUID(),
      operationSetHash: consumed.rows[0]!.operation_set_hash, intentHash,
    })), /approval_batch_scope_mismatch/);
  });

  test("rolls back the sealed batch when revocation wins before approval consumption", async () => {
    const revokedProposalId = fingerprint("revoked-proposal");
    const revokedRunId = randomUUID();
    const revokedApprovalId = randomUUID();
    await cloneProposal(revokedProposalId);
    await insertRun(revokedRunId, "fix.publish.v1", "running", { workflow: "fix.publish.v1" });
    const revokedIntentHash = fingerprint({ proposalId: revokedProposalId, plan: "revoked" });
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_approval_requests
         (id,tenant_id,integration_id,proposal_run_id,proposal_id,command_key,generation,intent_hash,intent_json,
          maker_actor_type,maker_actor_id,status,version,expires_at,approved_publish_run_id,approved_at)
       VALUES ($1,$2,$3,$4,$5,'preview-revoked',2,$6,$7::jsonb,'user','maker','approved',2,
         clock_timestamp()+interval '1 hour',$8,clock_timestamp())`,
      [revokedApprovalId, tenantId, integrationId, proposalRunId, revokedProposalId,
        revokedIntentHash, JSON.stringify({ proposalId: revokedProposalId, plan: "revoked" }), revokedRunId],
    );
    const revoked = await appDb.transaction(tenantId, (client) => revokeApprovalInTransaction(client, {
      tenantId, integrationId, approvalId: revokedApprovalId, commandKey: "revoke-wins",
      requestHash: fingerprint("revoke-wins"), expectedVersion: 2,
      actor: { type: "user", id: "checker" },
    }));
    assert.equal(revoked.status, "revoked");
    const before = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pr_agent_harness.repository_operations WHERE tenant_id=$1",
      [tenantId]);
    const revokedLease = { ...lease, runId: revokedRunId };
    const batchStore = new PublicationBatchStore(appDb);
    await assert.rejects(batchStore.freeze({
      runLease: revokedLease,
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/fix", target: "9", revision: "2".repeat(40), authorityGeneration: 1 },
      sourceKey: `fix.revoked:${revokedApprovalId}`,
      sourceHash: revokedIntentHash,
      operations: [{ operationType: "fix_commit", slot: "fix.commit", payload: { commit: "revoked" } }],
      authorize: async (client, frozen) => {
        const sealed = await client.query<{ operation_set_hash: string }>(
          "SELECT operation_set_hash FROM pr_agent_harness.publication_batches WHERE tenant_id=$1 AND id=$2",
          [tenantId, frozen.id]);
        await consumeFixApprovalInTransaction(client, { tenantId, approvalId: revokedApprovalId,
          publishRunId: revokedRunId, batchId: frozen.id,
          operationSetHash: sealed.rows[0]!.operation_set_hash, intentHash: revokedIntentHash });
      },
    }), /approval_not_consumable/);
    const after = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pr_agent_harness.repository_operations WHERE tenant_id=$1",
      [tenantId]);
    assert.equal(after.rows[0]!.count, before.rows[0]!.count, "denied freeze must roll back prepared operations");
    const batch = await pool.query(
      "SELECT 1 FROM pr_agent_harness.publication_batches WHERE tenant_id=$1 AND source_key=$2",
      [tenantId, `fix.revoked:${revokedApprovalId}`]);
    assert.equal(batch.rowCount, 0);
  });

  test("reconciles an unknown provider result without dispatching the approved mutation twice", async () => {
    const recoveryRunId = randomUUID();
    const recoveryApprovalId = randomUUID();
    const revokedProposalId = fingerprint("revoked-proposal");
    await insertRun(recoveryRunId, "fix.publish.v1", "running", { workflow: "fix.publish.v1" });
    const recoveryIntentHash = fingerprint({ proposalId: revokedProposalId, plan: "unknown-recovery" });
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_approval_requests
         (id,tenant_id,integration_id,proposal_run_id,proposal_id,command_key,generation,intent_hash,intent_json,
          maker_actor_type,maker_actor_id,status,version,expires_at,approved_publish_run_id,approved_at)
       VALUES ($1,$2,$3,$4,$5,'preview-recovery',3,$6,$7::jsonb,'user','maker','approved',2,
         clock_timestamp()+interval '1 hour',$8,clock_timestamp())`,
      [recoveryApprovalId, tenantId, integrationId, proposalRunId, revokedProposalId,
        recoveryIntentHash, JSON.stringify({ proposalId: revokedProposalId, plan: "unknown-recovery" }), recoveryRunId],
    );
    const recoveryLease = { ...lease, runId: recoveryRunId };
    const batchStore = new PublicationBatchStore(appDb);
    const batch = await batchStore.freeze({
      runLease: recoveryLease,
      scope: { tenantId, integrationId, platform: "github", origin: "https://github.example.test",
        repository: "acme/fix", target: "10", revision: "2".repeat(40), authorityGeneration: 1 },
      sourceKey: `fix.recovery:${recoveryApprovalId}`,
      sourceHash: recoveryIntentHash,
      operations: [{ operationType: "fix_commit", slot: "fix.commit", payload: { commit: "unknown-recovery" } }],
      authorize: async (client, frozen) => {
        const sealed = await client.query<{ operation_set_hash: string }>(
          "SELECT operation_set_hash FROM pr_agent_harness.publication_batches WHERE tenant_id=$1 AND id=$2",
          [tenantId, frozen.id]);
        await consumeFixApprovalInTransaction(client, { tenantId, approvalId: recoveryApprovalId,
          publishRunId: recoveryRunId, batchId: frozen.id,
          operationSetHash: sealed.rows[0]!.operation_set_hash, intentHash: recoveryIntentHash });
      },
    });
    let dispatches = 0;
    let lookups = 0;
    const adapter: PublicationAdapter = {
      dispatch: async () => { dispatches += 1; throw new Error("provider response lost after write"); },
      find: async () => { lookups += 1; return { id: "reconciled-commit" }; },
    };
    const coordinator = new PublicationBatchCoordinator(batchStore,
      new PublicationService(new PgPublicationStore(appDb)));
    const uncertain = await coordinator.execute(tenantId, batch.id, async () => adapter, recoveryLease);
    assert.equal(uncertain.status, "waiting_reconciliation");
    assert.equal(dispatches, 1);
    const recovered = await coordinator.execute(tenantId, batch.id, async () => adapter, recoveryLease);
    assert.equal(recovered.status, "succeeded");
    assert.equal(dispatches, 1);
    assert.equal(lookups, 1);
  });

  test("completes a fix publish Run without creating or closing a fake model budget", async () => {
    const workerLease = { ...lease, runId: randomUUID(), input: { workflow: "fix.publish.v1" } };
    let claimable = true;
    let transitioned: string | undefined;
    let budgetCalls = 0;
    const store = {
      claimPublicationOutcome: async () => undefined,
      claimManualResume: async () => undefined,
      claim: async () => {
        if (!claimable) return undefined;
        claimable = false;
        return workerLease;
      },
      latestCheckpoint: async () => undefined,
      withLease: async (_lease: RunLease, action: (client: { query(): Promise<{ rows: Array<{ allowed: boolean }> }> }) => Promise<unknown>) =>
        action({ query: async () => ({ rows: [{ allowed: true }] }) }),
      transition: async (_lease: RunLease, input: { to: string }) => { transitioned = input.to; },
    } as unknown as RunExecutionStore;
    const worker = new RunWorker({
      store,
      budget: { closeRunBudget: async () => { budgetCalls += 1; throw new Error("fake budget must not exist"); } } as unknown as ModelBudgetStore,
      bindings: async () => [{ tenantId, id: integrationId, generation: 1, executionModeGeneration: 1,
        reviewExecutionMode: "harness_async" } as PublicationBinding],
      runtimeHash: async () => workerLease.runtimeVersionHash,
      execute: async () => undefined,
      onError: (error) => { throw error; },
    }, 1);
    await worker.tick();
    await worker.drain();
    await worker.stop();
    assert.equal(transitioned, "succeeded");
    assert.equal(budgetCalls, 0);
  });

  async function insertRun(id: string, runType: string, status: "running" | "succeeded", input: Record<string, unknown>) {
    await pool.query(
      `INSERT INTO pr_agent_harness.agent_runs
         (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
          run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
          policy_version_hash,runtime_version_hash,input_json,status,lease_owner,lease_expires_at,lease_epoch,
          authority_generation,execution_mode_generation,deadline_at,finished_at)
       VALUES ($1,$2,$3,'user','maker',$4,$4,$5,$6,$7,$8,$5,$5,$5,$5,$5,$5,$9::jsonb,$10,$11,$12,1,1,1,
         clock_timestamp()+interval '15 minutes',$13)`,
      [id, tenantId, integrationId, `${runType}:${id}`, version, runType, "1".repeat(40), "2".repeat(40), JSON.stringify(input), status,
        status === "running" ? `${runType}-owner` : null,
        status === "running" ? new Date(Date.now() + 600_000) : null,
        status === "succeeded" ? new Date() : null],
    );
  }

  async function seedProposal(): Promise<void> {
    const stepId = randomUUID();
    const gateId = fingerprint("publish-gate");
    const candidate = { id: findingId, sourceRole: "security", severity: "high", title: "unsafe",
      body: "unsafe value", location: { path: "src/a.ts", side: "new", startLine: 1, endLine: 1 },
      evidenceIds: [], crossFileEvidenceIds: [] };
    await pool.query(
      `INSERT INTO pr_agent_harness.agent_steps
         (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
       VALUES ($1,$2,$3,'candidate','coordination',$4,'succeeded',$4,'{"value":{}}'::jsonb,1,1,clock_timestamp())`,
      [stepId, tenantId, sourceRunId, version]);
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
    const source = { tenantId, integrationId, runId: proposalRunId, sourceReviewRunId: sourceRunId, findingId,
      platform: "github", repository: "acme/fix", baseSha: "1".repeat(40), headSha: "2".repeat(40),
      sourceBundleRef: "snapshot:bundle", sourceBundleHash: fingerprint("bundle"), allowedPaths: ["src/a.ts"],
      finding: { title: "unsafe", body: "unsafe value", path: "src/a.ts", startLine: 1, endLine: 1 } };
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_run_sources
         (tenant_id,integration_id,run_id,source_review_run_id,finding_id,repository,base_sha,head_sha,
          source_bundle_ref,source_bundle_hash,allowed_paths_json,source_json,content_hash)
       VALUES ($1,$2,$3,$4,$5,'acme/fix',$6,$7,'snapshot:bundle',$8,'["src/a.ts"]'::jsonb,$9::jsonb,$10)`,
      [tenantId, integrationId, proposalRunId, sourceRunId, findingId, "1".repeat(40), "2".repeat(40),
        source.sourceBundleHash, JSON.stringify(source), fingerprint(source)]);
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_run_findings
         (tenant_id,run_id,source_review_run_id,finding_id,gate_decision_id,finding_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, proposalRunId, sourceRunId, findingId, gateId, fingerprint(source.finding)]);
    const proposal = { id: proposalId, tenantId, integrationId, runId: proposalRunId,
      sourceReviewRunId: sourceRunId, findingId, revision: 1, repository: "acme/fix",
      baseSha: "1".repeat(40), headSha: "2".repeat(40), sourceBundleRef: "snapshot:bundle",
      sourceBundleHash: source.sourceBundleHash, codePatch: "code", testPatch: "test",
      codePatchHash: fingerprint("code"), testPatchHash: fingerprint("test"), proposalHash: intent.proposalHash,
      policyId: "node", policyHash: fingerprint("policy"), trustedCommandHash: fingerprint(["node", "--test"]),
      dependencyLockPath: "package-lock.json", dependencyLockHash: fingerprint("lock"),
      sandboxPolicyHash: fingerprint("sandbox"), imageDigest: `sha256:${"a".repeat(64)}`,
      publisherPolicyHash: fingerprint("publisher"), qualificationStatus: "verified" };
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_proposals
         (id,tenant_id,integration_id,run_id,source_review_run_id,finding_id,revision,repository,base_sha,head_sha,
          source_bundle_ref,source_bundle_hash,code_patch,test_patch,code_patch_hash,test_patch_hash,proposal_hash,
          policy_id,policy_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
          publisher_policy_hash,qualification_status,proposal_json,content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,1,'acme/fix',$7,$8,'snapshot:bundle',$9,'code','test',$10,$11,$12,
         'node',$13,$14,'package-lock.json',$15,$16,$17,$18,'verified',$19::jsonb,$20)`,
      [proposalId, tenantId, integrationId, proposalRunId, sourceRunId, findingId, "1".repeat(40), "2".repeat(40),
        source.sourceBundleHash, proposal.codePatchHash, proposal.testPatchHash, proposal.proposalHash,
        proposal.policyHash, proposal.trustedCommandHash, proposal.dependencyLockHash, proposal.sandboxPolicyHash,
        proposal.imageDigest, proposal.publisherPolicyHash, JSON.stringify(proposal), fingerprint(proposal)]);
  }

  async function cloneProposal(id: string): Promise<void> {
    const proposalHash = fingerprint(id);
    await pool.query(
      `INSERT INTO pr_agent_harness.fix_proposals
       SELECT $3,tenant_id,integration_id,run_id,source_review_run_id,finding_id,2,repository,base_sha,head_sha,
         source_bundle_ref,source_bundle_hash,code_patch,test_patch,code_patch_hash,test_patch_hash,$4,
         policy_id,policy_hash,trusted_command_hash,dependency_lock_path,dependency_lock_hash,sandbox_policy_hash,image_digest,
         publisher_policy_hash,qualification_status,
         jsonb_set(jsonb_set(jsonb_set(proposal_json,'{id}',to_jsonb($3::text)),'{proposalHash}',to_jsonb($4::text)),'{revision}','2'::jsonb),
         $5,NULL,clock_timestamp()
       FROM pr_agent_harness.fix_proposals WHERE tenant_id=$1 AND id=$2`,
      [tenantId, proposalId, id, proposalHash, fingerprint({ id, proposalHash })],
    );
  }
}
