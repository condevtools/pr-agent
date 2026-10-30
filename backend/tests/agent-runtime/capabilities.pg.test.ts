import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore, type CreateRunInput } from "../../src/agent-runtime/postgres/run-store.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";
import { ProcessHeartbeatStore } from "../../src/agent-runtime/runtime/heartbeat.js";
import { checkRuntimeReadiness } from "../../src/agent-runtime/runtime/readiness.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import { RunControlError, type RunCommand } from "../../src/agent-runtime/runs/control-contracts.js";
import { RunControlStore } from "../../src/agent-runtime/runs/control-store.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("Capability PostgreSQL tests require HARNESS_TEST_DATABASE_URL from Docker", () => {});
} else {
  test("binding capabilities and role-fenced durable readiness heartbeats", async () => {
    const previousFix = process.env.FEATURE_FIX;
    const previousEvolution = process.env.FEATURE_EVOLUTION;
    const previousFixPolicy = process.env.FIX_DEFAULT_POLICY_ID;
    process.env.FEATURE_FIX = "on";
    process.env.FEATURE_EVOLUTION = "on";
    process.env.FIX_DEFAULT_POLICY_ID = "capability-test";
    const admin = new Pool({ connectionString: databaseUrl, max: 2 });
    const appPassword = randomUUID();
    const verifierPassword = randomUUID();
    let app: Pool | undefined;
    let verifier: Pool | undefined;
    try {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
          CREATE ROLE pr_agent_app LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier') THEN
          CREATE ROLE pr_agent_verifier LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`);
      await admin.query(`ALTER ROLE pr_agent_app PASSWORD '${appPassword}'`);
      await admin.query(`ALTER ROLE pr_agent_verifier PASSWORD '${verifierPassword}'`);
      const unmigrated = await checkRuntimeReadiness({ pool: admin, role: "web", env: {} });
      assert.equal(unmigrated.checks.postgres, true);
      assert.equal(unmigrated.checks.schema, false);
      assert.equal(unmigrated.ok, false);
      await migrateRuntime(admin);

      const appUrl = new URL(databaseUrl);
      appUrl.username = "pr_agent_app"; appUrl.password = appPassword;
      app = new Pool({ connectionString: appUrl.toString(), max: 2 });
      const verifierUrl = new URL(databaseUrl);
      verifierUrl.username = "pr_agent_verifier"; verifierUrl.password = verifierPassword;
      verifier = new Pool({ connectionString: verifierUrl.toString(), max: 1 });

      await admin.query("CREATE ROLE capability_schema_owner NOLOGIN");
      await admin.query("ALTER SCHEMA pr_agent_harness OWNER TO capability_schema_owner");
      await admin.query("GRANT capability_schema_owner TO pr_agent_app");
      const ownerMember = await checkRuntimeReadiness({ pool: app, role: "web", env: {} });
      assert.equal(ownerMember.checks.postgres, true);
      assert.equal(ownerMember.checks.runtimeRole, false);
      assert.equal(ownerMember.ok, false);
      await admin.query("REVOKE capability_schema_owner FROM pr_agent_app");
      await admin.query("ALTER SCHEMA pr_agent_harness OWNER TO postgres");
      await admin.query("DROP ROLE capability_schema_owner");

      const appHeartbeats = new ProcessHeartbeatStore(app);
      const compatibility = { runtimeVersionHash: "c".repeat(64),
        supportedWorkflowIds: ["review.single.v1", "review.deep.v1"] };
      await appHeartbeats.beat("worker", randomUUID(), { schemaVersion: 2,
        capabilities: { reviewSingle: true, reviewDeep: true, fix: false, evolution: false },
        runtimeVersionHash: compatibility.runtimeVersionHash,
        supportedWorkflowIds: compatibility.supportedWorkflowIds });
      await appHeartbeats.beat("recovery", randomUUID(), { schemaVersion: 1 });
      await assert.rejects(
        appHeartbeats.beat("verifier", randomUUID(), { verifierCapabilityHash: "forged" }),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "42501"),
      );
      await new ProcessHeartbeatStore(verifier).beat("verifier", randomUUID(), {
        schemaVersion: 1, verifierCapabilityHash: "dedicated-role-only",
      });

      const ready = await checkRuntimeReadiness({ pool: app, role: "web", env: {},
        workerCompatibility: compatibility });
      assert.equal(ready.ok, true);
      assert.deepEqual(ready.checks.heartbeats, { worker: true, recovery: true });
      await admin.query("UPDATE pr_agent_harness.runtime_process_heartbeats SET heartbeat_at=now()-interval '1 hour' WHERE process_role='recovery'");
      assert.equal((await checkRuntimeReadiness({ pool: app, role: "web", env: {},
        workerCompatibility: compatibility })).ok, false);

      const tenantId = randomUUID();
      const integrationId = randomUUID();
      const db = new RuntimeDatabase(admin);
      await new RunStore(db).registerIntegration({ tenantId, id: integrationId, platform: "github",
        origin: "https://api.github.com", repository: "acme/capabilities" });
      const authority = new PublicationAuthorityStore(db);
      await authority.configure({ tenantId, integrationId, providerRepositoryId: 10,
        providerActorId: 20, credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
      const defaults = await authority.get(tenantId, integrationId);
      assert.deepEqual(defaults.capabilities, { reviewSingle: true, reviewDeep: true,
        fix: false, evolution: false, defaultReviewWorkflow: "review.single.v1" });
      const active = await authority.transition({ tenantId, integrationId, expectedVersion: defaults.version,
        action: "activate", actor: "capability-test", actorType: "service", quiescenceEvidence: "isolated test" });
      const versionHash = "a".repeat(64);
      const disabledFixInput = { tenantId, integrationId,
        actorType: "service", actorId: "capability-test", createScope: "fix.propose.v1:test",
        createKey: "disabled-fix", requestHash: "b".repeat(64), runType: "fix.propose.v1",
        baseSha: "base", headSha: "head", workflowVersionHash: versionHash,
        promptVersionHash: versionHash, modelVersionHash: versionHash, toolVersionHash: versionHash,
        policyVersionHash: versionHash, runtimeVersionHash: versionHash,
        authorityGeneration: active.generation, executionModeGeneration: active.executionModeGeneration,
        bindingAuthorityVersion: active.version,
        input: { schemaVersion: 1, workflow: "fix.propose.v1" } } as const;
      await assert.rejects(new RunStore(db).createRun(disabledFixInput),
        (error: unknown) => error instanceof RunControlError && error.code === "CAPABILITY_DISABLED");

      const configured = await authority.configureCapabilities({ tenantId, integrationId,
        expectedVersion: active.version, reviewDeep: true, fix: true, evolution: true,
        defaultReviewWorkflow: "review.deep.v1", actor: "capability-test", actorType: "service" });
      assert.deepEqual(configured.capabilities, { reviewSingle: true, reviewDeep: true,
        fix: true, evolution: true, defaultReviewWorkflow: "review.deep.v1" });
      const enabledFix = await new RunStore(db).createRun({ ...disabledFixInput, createKey: "enabled-fix",
        requestHash: "d".repeat(64), bindingAuthorityVersion: configured.version });
      const disabled = await authority.configureCapabilities({ tenantId, integrationId,
        expectedVersion: configured.version, reviewDeep: true, fix: false, evolution: false,
        defaultReviewWorkflow: "review.single.v1", actor: "capability-test", actorType: "service" });
      const execution = new RunExecutionStore(db, { supportedWorkflows: ["fix.propose.v1"] });
      assert.equal(await execution.claim({ tenantId, integrationId, authorityGeneration: active.generation,
        executionModeGeneration: active.executionModeGeneration ?? 0 }, "single-only-worker", versionHash), undefined);
      assert.equal((await execution.load(tenantId, enabledFix.id))?.status, "queued");
      await assert.rejects(authority.configureCapabilities({ tenantId, integrationId,
        expectedVersion: active.version, reviewDeep: true, fix: false, evolution: false,
        defaultReviewWorkflow: "review.single.v1", actor: "stale", actorType: "service" }), /version conflict/u);

      const reenabledForClaim = await authority.configureCapabilities({ tenantId, integrationId,
        expectedVersion: disabled.version, reviewDeep: true, fix: true, evolution: true,
        defaultReviewWorkflow: "review.single.v1", actor: "capability-test", actorType: "service" });
      await admin.query(
        "UPDATE pr_agent_harness.agent_runs SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1",
        [enabledFix.id],
      );
      await admin.query(
        "UPDATE pr_agent_harness.job_queue SET status='cancelled',completed_at=clock_timestamp() WHERE run_id=$1",
        [enabledFix.id],
      );
      const claimBarrierRun = await new RunStore(db).createRun({ ...disabledFixInput,
        createKey: "claim-barrier-fix", requestHash: "f".repeat(64),
        bindingAuthorityVersion: reenabledForClaim.version });
      const updater = await admin.connect();
      const barrierPool = new Pool({ connectionString: databaseUrl, max: 1,
        application_name: "capability-lock-barrier" });
      try {
        await updater.query("BEGIN");
        await updater.query(`UPDATE pr_agent_harness.integration_bindings
          SET fix_enabled=false,evolution_enabled=false,authority_version=authority_version+1
          WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId]);
        const staleClaim = new RunExecutionStore(new RuntimeDatabase(barrierPool), {
          supportedWorkflows: ["fix.propose.v1"],
        }).claim({ tenantId, integrationId, authorityGeneration: active.generation,
          executionModeGeneration: active.executionModeGeneration ?? 0 },
        "stale-capability-worker", versionHash);
        await waitForCapabilityLock(admin);
        await updater.query("COMMIT");
        assert.equal(await staleClaim, undefined);
        const untouched = await admin.query<{ status: string; execution_attempt_count: number;
          job_status: string; attempt_count: number }>(
          `SELECT r.status,r.execution_attempt_count,j.status AS job_status,j.attempt_count
           FROM pr_agent_harness.agent_runs r JOIN pr_agent_harness.job_queue j ON j.run_id=r.id
           WHERE r.id=$1`, [claimBarrierRun.id]);
        assert.deepEqual(untouched.rows[0], { status: "queued", execution_attempt_count: 0,
          job_status: "ready", attempt_count: 0 });

        const claimDisabled = await authority.get(tenantId, integrationId);
        const reenabled = await authority.configureCapabilities({ tenantId, integrationId,
          expectedVersion: claimDisabled.version, reviewDeep: true, fix: true, evolution: true,
          defaultReviewWorkflow: "review.single.v1", actor: "capability-test", actorType: "service" });
        await updater.query("BEGIN");
        await updater.query(`UPDATE pr_agent_harness.integration_bindings
          SET fix_enabled=false,evolution_enabled=false,authority_version=authority_version+1
          WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId]);
        const staleCreate = new RunStore(new RuntimeDatabase(barrierPool)).createRun({
          ...disabledFixInput, createKey: "barrier-fix", requestHash: "e".repeat(64),
          bindingAuthorityVersion: reenabled.version,
        });
        await waitForCapabilityLock(admin);
        await updater.query("COMMIT");
        await assert.rejects(staleCreate, (error: unknown) => error instanceof RunControlError
          && (error.code === "CAPABILITY_DISABLED" || error.code === "BINDING_CAPABILITY_CHANGED"));
        const admitted = await admin.query<{ runs: number; budgets: number }>(
          `SELECT count(*)::int AS runs,
             (SELECT count(*)::int FROM pr_agent_harness.run_budget_envelopes b
              JOIN pr_agent_harness.agent_runs r ON r.tenant_id=b.tenant_id AND r.id=b.run_id
              WHERE r.tenant_id=$1 AND r.create_key='barrier-fix') AS budgets
           FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND create_key='barrier-fix'`, [tenantId]);
        assert.deepEqual(admitted.rows[0], { runs: 0, budgets: 0 });

        const currentDisabled = await authority.get(tenantId, integrationId);
        const enabledSingle = await new RunStore(db).createRun({ ...disabledFixInput,
          createScope: "review.single.v1:test", createKey: "mixed-enabled-single",
          requestHash: "1".repeat(64), runType: "review.single.v1",
          bindingAuthorityVersion: currentDisabled.version,
          input: { schemaVersion: 1, workflow: "review.single.v1" } });
        await admin.query("UPDATE pr_agent_harness.job_queue SET priority=100 WHERE run_id=$1",
          [claimBarrierRun.id]);
        const mixedExecution = new RunExecutionStore(db, {
          supportedWorkflows: ["fix.propose.v1", "review.single.v1"],
        });
        const mixedLease = await mixedExecution.claim({ tenantId, integrationId,
          authorityGeneration: active.generation,
          executionModeGeneration: active.executionModeGeneration ?? 0 },
        "mixed-capability-worker", versionHash);
        assert.equal(mixedLease?.runId, enabledSingle.id);
        const disabledHead = await admin.query<{ run_status: string; job_status: string; attempt_count: number }>(
          `SELECT r.status AS run_status,j.status AS job_status,j.attempt_count
           FROM pr_agent_harness.agent_runs r JOIN pr_agent_harness.job_queue j ON j.run_id=r.id
           WHERE r.id=$1`, [claimBarrierRun.id]);
        assert.deepEqual(disabledHead.rows[0], { run_status: "queued", job_status: "ready", attempt_count: 0 });
        assert.ok(mixedLease);
        await mixedExecution.relinquishSettledLease(mixedLease, "mixed_queue_test");

        await admin.query(
          `UPDATE pr_agent_harness.agent_runs SET status='cancelled',finished_at=clock_timestamp()
           WHERE id=ANY($1::uuid[])`, [[claimBarrierRun.id, enabledSingle.id]],
        );
        await admin.query(
          `UPDATE pr_agent_harness.job_queue SET status='cancelled',completed_at=clock_timestamp()
           WHERE run_id=ANY($1::uuid[])`, [[claimBarrierRun.id, enabledSingle.id]],
        );
        const beforeManual = await authority.get(tenantId, integrationId);
        const manualEnabled = await authority.configureCapabilities({ tenantId, integrationId,
          expectedVersion: beforeManual.version, reviewDeep: true, fix: true, evolution: false,
          defaultReviewWorkflow: "review.single.v1", actor: "capability-test", actorType: "service" });
        const publicationBatches = new PublicationBatchStore(db);
        const controls = new RunControlStore(db);
        const prepareManual = async (
          input: CreateRunInput,
          decision: "authorize_retry" | "confirm_occurred",
          priority: number,
        ): Promise<string> => {
          const created = await new RunStore(db).createRun(input);
          const lease = await mixedExecution.claim({ tenantId, integrationId,
            authorityGeneration: active.generation,
            executionModeGeneration: active.executionModeGeneration ?? 0 },
          `prepare-${decision}`, versionHash);
          assert.equal(lease?.runId, created.id);
          assert.ok(lease);
          const batch = await publicationBatches.freeze({ runLease: lease,
            scope: { tenantId, integrationId, platform: "github", origin: "https://api.github.com",
              repository: "acme/capabilities", target: `pull:${decision}`, revision: "head",
              authorityGeneration: active.generation },
            sourceKey: `manual:${decision}`, sourceHash: input.requestHash,
            operations: [{ slot: "summary", payload: { decision } }] });
          const frozen = await admin.query<{ operation_set_hash: string; operation_version: string }>(
            `SELECT b.operation_set_hash,ro.version AS operation_version
             FROM pr_agent_harness.publication_batches b
             JOIN pr_agent_harness.publication_batch_operations pbo ON pbo.batch_id=b.id
             JOIN pr_agent_harness.repository_operations ro
               ON ro.tenant_id=pbo.tenant_id AND ro.business_operation_id=pbo.business_operation_id
             WHERE b.id=$1`, [batch.id]);
          const identity = frozen.rows[0]!;
          await admin.query(
            `UPDATE pr_agent_harness.agent_runs
             SET status='waiting_for_reconciliation',lease_owner=NULL,lease_expires_at=NULL,
                 waiting_batch_id=$2,waiting_operation_set_hash=$3,version=version+1 WHERE id=$1`,
            [created.id, batch.id, identity.operation_set_hash],
          );
          await admin.query(
            "UPDATE pr_agent_harness.job_queue SET status='completed',completed_at=clock_timestamp() WHERE run_id=$1",
            [created.id],
          );
          const intentHash = decision === "authorize_retry" ? "2".repeat(64) : "3".repeat(64);
          const wait = await admin.query<{ id: string }>(
            `INSERT INTO pr_agent_harness.run_waits
               (tenant_id,run_id,batch_id,operation_set_hash,business_operation_id,
                operation_version,intent_hash,allowed_decisions)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
            [tenantId, created.id, batch.id, identity.operation_set_hash,
              batch.operations[0]!.businessOperationId, Number(identity.operation_version), intentHash,
              JSON.stringify([decision])],
          );
          const expectedVersion = await admin.query<{ version: string }>(
            "SELECT version FROM pr_agent_harness.agent_runs WHERE id=$1", [created.id]);
          const command: RunCommand = decision === "authorize_retry"
            ? { kind: "resume", commandKey: `manual:${decision}`,
              expectedVersion: Number(expectedVersion.rows[0]!.version),
              decision: { waitId: wait.rows[0]!.id, waitVersion: 1, intentHash,
                operationVersion: Number(identity.operation_version), decision,
                evidence: { kind: "provider_confirmation", reference: "capability-test" } } }
            : { kind: "resume", commandKey: `manual:${decision}`,
              expectedVersion: Number(expectedVersion.rows[0]!.version),
              decision: { waitId: wait.rows[0]!.id, waitVersion: 1, intentHash,
                operationVersion: Number(identity.operation_version), decision,
                evidence: { kind: "provider_confirmation", reference: "capability-test",
                  actualRevision: "head" }, remoteId: "remote-safe" } };
          await controls.apply({ tenantId, integrationId, actorType: "user", subjectId: "capability-test",
            permissions: ["runs:resume"] }, created.id, command);
          await admin.query(
            "UPDATE pr_agent_harness.agent_runs SET status='waiting_for_user' WHERE id=$1",
            [created.id],
          );
          await admin.query(
            "UPDATE pr_agent_harness.job_queue SET priority=$2 WHERE run_id=$1 AND job_kind='manual_resume'",
            [created.id, priority],
          );
          return created.id;
        };
        const authorizeRun = await prepareManual({ ...disabledFixInput,
          createKey: "mixed-authorize-retry", requestHash: "4".repeat(64),
          bindingAuthorityVersion: manualEnabled.version }, "authorize_retry", 100);
        const safeRun = await prepareManual({ ...disabledFixInput,
          createScope: "review.single.v1:test", createKey: "mixed-safe-confirm",
          requestHash: "5".repeat(64), runType: "review.single.v1",
          bindingAuthorityVersion: manualEnabled.version,
          input: { schemaVersion: 1, workflow: "review.single.v1" } }, "confirm_occurred", 0);
        await authority.configureCapabilities({ tenantId, integrationId,
          expectedVersion: manualEnabled.version, reviewDeep: true, fix: false, evolution: false,
          defaultReviewWorkflow: "review.single.v1", actor: "capability-test", actorType: "service" });
        const manualLease = await mixedExecution.claimManualResume({ tenantId, integrationId,
          authorityGeneration: active.generation,
          executionModeGeneration: active.executionModeGeneration ?? 0 },
        "mixed-manual-worker", versionHash);
        assert.equal(manualLease?.runId, safeRun);
        const blockedManual = await admin.query<{ status: string; attempt_count: number }>(
          `SELECT status,attempt_count FROM pr_agent_harness.job_queue
           WHERE run_id=$1 AND job_kind='manual_resume'`, [authorizeRun]);
        assert.deepEqual(blockedManual.rows[0], { status: "ready", attempt_count: 0 });
      } finally {
        await updater.query("ROLLBACK").catch(() => undefined);
        updater.release();
        await barrierPool.end();
      }
    } finally {
      await verifier?.end();
      await app?.end();
      await admin.end();
      if (previousFix === undefined) delete process.env.FEATURE_FIX;
      else process.env.FEATURE_FIX = previousFix;
      if (previousEvolution === undefined) delete process.env.FEATURE_EVOLUTION;
      else process.env.FEATURE_EVOLUTION = previousEvolution;
      if (previousFixPolicy === undefined) delete process.env.FIX_DEFAULT_POLICY_ID;
      else process.env.FIX_DEFAULT_POLICY_ID = previousFixPolicy;
    }
  });
}

async function waitForCapabilityLock(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND application_name='capability-lock-barrier'
         AND state='active' AND wait_event_type='Lock') AS blocked`,
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run creation did not reach the binding capability lock barrier");
}
