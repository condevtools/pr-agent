import type { PoolClient } from "pg";
import { fingerprint } from "../versions.js";

import { RuntimeDatabase } from "../postgres/database.js";
import { appendRunFact } from "../runs/events.js";
import type { RunStatus } from "../postgres/run-store.js";
import { lockCurrentBindingCapability } from "../authority/capability-guard.js";
import { workflowCapability, type ProductCapability } from "../runtime/capabilities.js";
import { RunControlError } from "../runs/control-contracts.js";
import { PgRunArtifactStore, type PreparedRunArtifact } from "../artifacts/index.js";
import { measureDatabaseOperation } from "../database-timing.js";
import {
  RunCheckpointCompatibilityError,
  RunLeaseLostError,
  RunStepAttemptLimitError,
  RunStepConflictError,
  type ClaimableBinding,
  type JsonObject,
  type LeaseTransaction,
  type LockedRun,
  type RunCheckpoint,
  type RunExecutionSnapshot,
  type RunLease,
  type RunLeaseIdentity,
  type RunJobKind,
  type RunStep,
  type RunStepKind,
  type SweepResult,
  type ToolCallKind,
} from "../runs/contracts.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RunExecutionStoreOptions {
  leaseTtlMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
  supportedWorkflows?: readonly string[];
  perBindingConcurrency?: number;
}

interface ClaimRow {
  job_id: string;
  job_attempt: number;
  job_kind: RunJobKind;
  job_payload_json: JsonObject;
  id: string;
  integration_id: string;
  run_type: string;
  lease_epoch: string;
  authority_generation: string;
  execution_mode_generation: string;
  deadline_at: Date;
  base_sha: string;
  head_sha: string;
  workflow_version_hash: string;
  prompt_version_hash: string;
  model_version_hash: string;
  tool_version_hash: string;
  policy_version_hash: string;
  runtime_version_hash: string;
  input_json: JsonObject;
  limits_json: JsonObject;
  runtime_config_json: JsonObject;
  lease_expires_at: Date;
}

interface StepRow {
  id: string;
  run_id: string;
  step_key: string;
  step_kind: RunStepKind;
  input_hash: string;
  status: RunStep["status"];
  output_hash: string | null;
  output_json: JsonObject | null;
  result_ref: string | null;
  last_lease_epoch: string;
  attempt_count: number;
}

interface CheckpointRow {
  id: string;
  run_id: string;
  sequence: string;
  step_id: string | null;
  step_attempt_id: string | null;
  schema_version: number;
  runtime_version_hash: string;
  state_hash: string;
  state_json: JsonObject;
  created_at: Date;
}

export interface RuntimeCompatibilityBacklog {
  queuedRuns: number;
  oldestQueuedAt?: string;
  runtimeVersionHashes: string[];
}

export class RunExecutionStore {
  private readonly leaseTtlMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly supportedWorkflows: readonly string[];
  private readonly perBindingConcurrency: number;
  private readonly artifacts: PgRunArtifactStore;

  constructor(
    private readonly db: RuntimeDatabase,
    options: RunExecutionStoreOptions = {},
  ) {
    this.artifacts = new PgRunArtifactStore(db);
    this.leaseTtlMs = positiveInteger(options.leaseTtlMs ?? 60_000, "lease TTL");
    this.initialRetryMs = positiveInteger(options.initialRetryMs ?? 1_000, "initial retry delay");
    this.maxRetryMs = positiveInteger(options.maxRetryMs ?? 60_000, "maximum retry delay");
    this.supportedWorkflows = options.supportedWorkflows ?? ["review", "review.single.v1", "review.deep.v1",
      "fix.propose.v1", "fix.publish.v1", "evolution.propose.v1", "eval.replay.v1"];
    this.perBindingConcurrency = positiveInteger(
      options.perBindingConcurrency ?? 2,
      "per-binding worker concurrency",
    );
    if (this.perBindingConcurrency > 16) throw new Error("per-binding worker concurrency must not exceed 16");
    if (!this.supportedWorkflows.length || this.supportedWorkflows.some((workflow) => !workflow.trim())) {
      throw new Error("supported workflows must be nonempty identifiers");
    }
  }

  async claim(
    binding: ClaimableBinding,
    owner: string,
    runtimeVersionHash: string,
    supportedWorkflows: readonly string[] = this.supportedWorkflows,
  ): Promise<RunLease | undefined> {
    requiredText(owner, "lease owner");
    requiredHash(runtimeVersionHash, "runtime version hash");
    return this.db.transaction(binding.tenantId, async (client) => {
      const authority = await client.query<{ allowed: boolean }>(
        `SELECT pr_agent_harness.lock_active_review_execution_authority(
           $1::uuid,$2::uuid,$3::bigint,$4::bigint
         ) AS allowed`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration],
      );
      if (!authority.rows[0]?.allowed) return undefined;
      if (!await lockBindingCapacity(client, binding, this.perBindingConcurrency)) return undefined;

      const candidate = await client.query<{
        job_id: string; run_id: string; run_type: string;
        job_kind: RunJobKind; job_payload_json: JsonObject;
      }>(
        `SELECT j.id AS job_id,r.id AS run_id,r.run_type,j.job_kind,j.job_payload_json
         FROM pr_agent_harness.job_queue j
         JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=j.tenant_id AND r.id=j.run_id
         JOIN pr_agent_harness.integration_bindings b
           ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
         WHERE j.tenant_id=$1 AND r.integration_id=$2
           AND r.authority_generation=$3 AND r.execution_mode_generation=$4
           AND r.runtime_version_hash=$5
           AND r.run_type=ANY($6::text[])
           AND (r.run_type IN ('review','review.single.v1')
             OR (r.run_type='review.deep.v1' AND b.review_deep_enabled)
             OR (r.run_type IN ('fix.propose.v1','fix.publish.v1') AND b.fix_enabled)
             OR (r.run_type IN ('evolution.propose.v1','eval.replay.v1') AND b.evolution_enabled))
           AND j.job_kind IN ('start','retry','recover')
           AND r.status IN ('queued','retry_wait')
           AND r.cancel_requested_at IS NULL AND r.deadline_at > now()
           AND j.status IN ('ready','retry_wait') AND j.available_at <= now()
         ORDER BY j.priority DESC,j.available_at,j.id
         FOR UPDATE OF j,r SKIP LOCKED LIMIT 1`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration, runtimeVersionHash, supportedWorkflows],
      );
      const selected = candidate.rows[0];
      if (!selected) return undefined;
      const capability = capabilityForWorkflow(selected.run_type);
      if (capability && !await capabilityEnabled(client, binding, capability)) return undefined;

      const run = await client.query<Omit<ClaimRow, "job_id" | "job_attempt" | "job_kind" | "job_payload_json">>(
        `UPDATE pr_agent_harness.agent_runs
         SET status='running',lease_owner=$3,
             lease_expires_at=now()+($4::double precision*interval '1 millisecond'),
             lease_epoch=lease_epoch+1,execution_attempt_count=execution_attempt_count+1,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,integration_id,run_type,lease_epoch,authority_generation,
           execution_mode_generation,deadline_at,
           base_sha,head_sha,workflow_version_hash,prompt_version_hash,
           model_version_hash,tool_version_hash,policy_version_hash,
           runtime_version_hash,input_json,limits_json,runtime_config_json,
           lease_expires_at`,
        [binding.tenantId, selected.run_id, owner, this.leaseTtlMs],
      );
      const job = await client.query<{ attempt_count: number }>(
        `UPDATE pr_agent_harness.job_queue
         SET status='running',attempt_count=attempt_count+1,
             claimed_run_epoch=$3,last_error_code=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING attempt_count`,
        [binding.tenantId, selected.job_id, Number(run.rows[0]!.lease_epoch)],
      );
      await appendRunEvent(client, binding.tenantId, selected.run_id, "run.claimed", owner, {
        epoch: Number(run.rows[0]!.lease_epoch),
        jobId: selected.job_id,
        jobAttempt: job.rows[0]!.attempt_count,
      });
      return mapLease({
        ...run.rows[0]!,
        job_id: selected.job_id,
        job_attempt: job.rows[0]!.attempt_count,
        job_kind: selected.job_kind,
        job_payload_json: selected.job_payload_json,
      }, binding.tenantId, owner);
    });
  }

  /** Read-only operational evidence for Runs waiting on another Worker capability. */
  async compatibilityBacklog(
    binding: ClaimableBinding,
    runtimeVersionHash: string,
  ): Promise<RuntimeCompatibilityBacklog> {
    requiredHash(runtimeVersionHash, "runtime version hash");
    return this.db.transaction(binding.tenantId, async (client) => {
      const result = await client.query<{
        queued_runs: number; oldest_queued_at: Date | null; runtime_hashes: string[] | null;
      }>(
        `SELECT count(DISTINCT r.id)::int AS queued_runs,
                min(j.available_at) AS oldest_queued_at,
                array_agg(DISTINCT r.runtime_version_hash) AS runtime_hashes
         FROM pr_agent_harness.agent_runs r
         JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
         WHERE r.tenant_id=$1 AND r.integration_id=$2
           AND r.authority_generation=$3 AND r.execution_mode_generation=$4
           AND r.runtime_version_hash<>$5
           AND r.status IN ('queued','retry_wait') AND j.status IN ('ready','retry_wait')
           AND r.cancel_requested_at IS NULL AND r.deadline_at>now() AND j.available_at<=now()`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration, runtimeVersionHash],
      );
      const row = result.rows[0]!;
      return { queuedRuns: row.queued_runs,
        oldestQueuedAt: row.oldest_queued_at?.toISOString(),
        runtimeVersionHashes: row.runtime_hashes ?? [] };
    });
  }

  async claimPublicationOutcome(
    binding: ClaimableBinding,
    owner: string,
    runtimeVersionHash: string,
    supportedWorkflows: readonly string[] = this.supportedWorkflows,
  ): Promise<RunLease | undefined> {
    return this.claimSpecialJob(binding, owner, runtimeVersionHash, "publication_outcome", supportedWorkflows);
  }

  async claimManualResume(
    binding: ClaimableBinding,
    owner: string,
    runtimeVersionHash: string,
    supportedWorkflows: readonly string[] = this.supportedWorkflows,
  ): Promise<RunLease | undefined> {
    return this.claimSpecialJob(binding, owner, runtimeVersionHash, "manual_resume", supportedWorkflows);
  }

  private async claimSpecialJob(
    binding: ClaimableBinding,
    owner: string,
    runtimeVersionHash: string,
    kind: "publication_outcome" | "manual_resume",
    supportedWorkflows: readonly string[],
  ): Promise<RunLease | undefined> {
    requiredText(owner, "lease owner");
    requiredHash(runtimeVersionHash, "runtime version hash");
    const expectedStatus = kind === "publication_outcome"
      ? "waiting_for_reconciliation"
      : "waiting_for_user";
    return this.db.transaction(binding.tenantId, async (client) => {
      const authority = await client.query<{ allowed: boolean }>(
        `SELECT pr_agent_harness.lock_resumable_review_execution_authority(
           $1::uuid,$2::uuid,$3::bigint,$4::bigint
         ) AS allowed`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration],
      );
      if (!authority.rows[0]?.allowed) return undefined;
      if (!await lockBindingCapacity(client, binding, this.perBindingConcurrency)) return undefined;

      await client.query(
        `UPDATE pr_agent_harness.job_queue j
         SET max_attempts=LEAST(j.max_attempts,
               COALESCE((r.runtime_config_json->>'maxJobAttempts')::integer,3)),
             updated_at=now()
         FROM pr_agent_harness.agent_runs r
         WHERE j.tenant_id=$1 AND j.job_kind=$2 AND j.status IN ('ready','retry_wait')
           AND r.tenant_id=j.tenant_id AND r.id=j.run_id`,
        [binding.tenantId, kind],
      );
      await terminalizeExhaustedSpecialJobs(client, binding, kind);

      await client.query(
        `UPDATE pr_agent_harness.job_queue j
         SET status='completed',last_error_code='stale_special_job',completed_at=now(),updated_at=now()
         FROM pr_agent_harness.agent_runs r
         WHERE j.tenant_id=$1 AND j.job_kind=$2 AND j.status IN ('ready','retry_wait')
           AND r.tenant_id=j.tenant_id AND r.id=j.run_id
           AND (r.status IN ('succeeded','failed','cancelled')
             OR j.expected_run_version<>r.version
             OR j.expected_batch_id IS DISTINCT FROM r.waiting_batch_id
             OR j.expected_operation_set_hash IS DISTINCT FROM r.waiting_operation_set_hash)`,
        [binding.tenantId, kind],
      );

      const predicate = kind === "publication_outcome"
        ? `j.outcome_generation=r.publication_outcome_generation
           AND j.expected_batch_id=r.waiting_batch_id
           AND j.expected_operation_set_hash=r.waiting_operation_set_hash
           AND EXISTS (
             SELECT 1 FROM pr_agent_harness.publication_batches b
             WHERE b.tenant_id=r.tenant_id AND b.id=j.expected_batch_id
               AND b.seal_state='sealed' AND b.operation_set_hash=j.expected_operation_set_hash
           )`
        : `j.command_receipt_id IS NOT NULL AND j.wait_id IS NOT NULL AND j.wait_version IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM pr_agent_harness.run_waits w
             JOIN pr_agent_harness.run_wait_decisions d
               ON d.tenant_id=w.tenant_id AND d.run_id=w.run_id AND d.wait_id=w.id
             JOIN pr_agent_harness.run_command_receipts c
               ON c.tenant_id=d.tenant_id AND c.run_id=d.run_id AND c.id=d.command_receipt_id
             WHERE w.tenant_id=j.tenant_id AND w.run_id=j.run_id AND w.id=j.wait_id
               AND w.status='consumed' AND w.version=j.wait_version+1
               AND d.command_receipt_id=j.command_receipt_id
               AND c.status='accepted' AND c.id=j.command_receipt_id
           )`;
      const candidate = await client.query<{
        job_id: string; run_id: string; run_type: string;
        job_kind: RunJobKind; job_payload_json: JsonObject;
      }>(
        `SELECT j.id AS job_id,r.id AS run_id,r.run_type,j.job_kind,
                j.job_payload_json || jsonb_strip_nulls(jsonb_build_object(
                  'batchId',j.expected_batch_id,'operationSetHash',j.expected_operation_set_hash,
                  'outcomeGeneration',j.outcome_generation,'waitId',j.wait_id,
                  'waitVersion',j.wait_version,'commandReceiptId',j.command_receipt_id
                )) AS job_payload_json
         FROM pr_agent_harness.job_queue j
         JOIN pr_agent_harness.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.run_id
         JOIN pr_agent_harness.integration_bindings b
           ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
         WHERE j.tenant_id=$1 AND r.integration_id=$2
           AND r.authority_generation=$3 AND r.execution_mode_generation=$4
           AND r.runtime_version_hash=$5 AND r.status=$6
           AND r.cancel_requested_at IS NULL AND r.deadline_at>now()
           AND j.job_kind=$7 AND j.status IN ('ready','retry_wait') AND j.available_at<=now()
           AND ($7='publication_outcome'
             OR COALESCE(j.job_payload_json->>'decision','')<>'authorize_retry'
             OR (r.run_type=ANY($8::text[])
               AND (r.run_type IN ('review','review.single.v1')
                 OR (r.run_type='review.deep.v1' AND b.review_deep_enabled)
                 OR (r.run_type IN ('fix.propose.v1','fix.publish.v1') AND b.fix_enabled)
                 OR (r.run_type IN ('evolution.propose.v1','eval.replay.v1') AND b.evolution_enabled))))
           AND j.attempt_count<j.max_attempts
           AND j.expected_run_version=r.version AND ${predicate}
         ORDER BY j.priority DESC,j.available_at,j.id
         FOR UPDATE OF j,r SKIP LOCKED LIMIT 1`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration, runtimeVersionHash, expectedStatus, kind, supportedWorkflows],
      );
      const selected = candidate.rows[0];
      if (!selected) return undefined;
      if (kind === "manual_resume" && selected.job_payload_json.decision === "authorize_retry") {
        const capability = capabilityForWorkflow(selected.run_type);
        if (capability && !await capabilityEnabled(client, binding, capability)) return undefined;
      }
      const run = await client.query<Omit<ClaimRow, "job_id" | "job_attempt" | "job_kind" | "job_payload_json">>(
        `UPDATE pr_agent_harness.agent_runs
         SET status='running',lease_owner=$3,
             lease_expires_at=now()+($4::double precision*interval '1 millisecond'),
             lease_epoch=lease_epoch+1,execution_attempt_count=execution_attempt_count+1,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status=$5
         RETURNING id,integration_id,run_type,lease_epoch,authority_generation,
           execution_mode_generation,deadline_at,base_sha,head_sha,
           workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
           policy_version_hash,runtime_version_hash,input_json,limits_json,runtime_config_json,
           lease_expires_at`,
        [binding.tenantId, selected.run_id, owner, this.leaseTtlMs, expectedStatus],
      );
      if (!run.rows[0]) return undefined;
      const job = await client.query<{ attempt_count: number }>(
        `UPDATE pr_agent_harness.job_queue
         SET status='running',attempt_count=attempt_count+1,
             claimed_run_epoch=$3,last_error_code=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status IN ('ready','retry_wait')
         RETURNING attempt_count`,
        [binding.tenantId, selected.job_id, Number(run.rows[0].lease_epoch)],
      );
      if (!job.rows[0]) throw new RunLeaseLostError(selected.run_id);
      await appendRunEvent(client, binding.tenantId, selected.run_id, "run.claimed", owner, {
        epoch: Number(run.rows[0].lease_epoch), jobId: selected.job_id,
        jobAttempt: job.rows[0].attempt_count, jobKind: kind,
      });
      return mapLease({
        ...run.rows[0], job_id: selected.job_id, job_attempt: job.rows[0].attempt_count,
        job_kind: selected.job_kind, job_payload_json: selected.job_payload_json,
      }, binding.tenantId, owner);
    });
  }

  async heartbeat(lease: RunLease): Promise<RunLease> {
    return measureDatabaseOperation("lease_heartbeat", () => this.db.transaction(
      lease.tenantId,
      async (client) => {
      const run = await client.query<{ lease_expires_at: Date }>(
        `UPDATE pr_agent_harness.agent_runs
         SET lease_expires_at=now()+($7::double precision*interval '1 millisecond'),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND integration_id=$3
           AND lease_owner=$4 AND lease_epoch=$5 AND runtime_version_hash=$6
           AND status='running' AND lease_expires_at>now()
           AND deadline_at>now() AND cancel_requested_at IS NULL
         RETURNING lease_expires_at`,
        [lease.tenantId, lease.runId, lease.integrationId, lease.owner, lease.epoch,
          lease.runtimeVersionHash, this.leaseTtlMs],
      );
      if (!run.rows[0]) throw new RunLeaseLostError(lease.runId);
      return { ...lease, leaseExpiresAt: run.rows[0].lease_expires_at.toISOString() };
      },
    ));
  }

  async withLease<T>(lease: RunLease, fn: LeaseTransaction<T>): Promise<T> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "update" });
      return fn(client);
    });
  }

  /** Return a settled abort-aware attempt without consuming failure budget. */
  async relinquishSettledLease(lease: RunLease, reason = "worker_shutdown"): Promise<void> {
    requiredText(reason, "lease release reason");
    await this.withLease(lease, async (client) => {
      await abandonActiveStepAttempts(client, lease.tenantId, lease.runId, reason);
      const targetStatus = lease.jobKind === "publication_outcome"
        ? "waiting_for_reconciliation"
        : lease.jobKind === "manual_resume" ? "waiting_for_user" : "queued";
      const run = await client.query<{ version: string }>(
        `UPDATE pr_agent_harness.agent_runs
         SET status=$5,lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,
             execution_attempt_count=GREATEST(0,execution_attempt_count-1),
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND lease_epoch=$4
           AND status='running'
         RETURNING version`,
        [lease.tenantId, lease.runId, lease.owner, lease.epoch, targetStatus],
      );
      if (!run.rows[0]) throw new RunLeaseLostError(lease.runId);
      const job = await client.query(
        `UPDATE pr_agent_harness.job_queue
         SET status='ready',available_at=now(),
             attempt_count=GREATEST(0,attempt_count-1),claimed_run_epoch=NULL,
             expected_run_version=$5,last_error_code=NULL,completed_at=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND claimed_run_epoch=$4
           AND status='running'`,
        [lease.tenantId, lease.jobId, lease.runId, lease.epoch, Number(run.rows[0].version)],
      );
      if (job.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      await appendRunEvent(client, lease.tenantId, lease.runId, "run.requeued", lease.owner, {
        reasonCode: reason, priorEpoch: lease.epoch, attemptConsumed: false,
      });
    });
  }

  async load(tenantId: string, runId: string): Promise<RunExecutionSnapshot | undefined> {
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<{
        id: string; tenant_id: string; integration_id: string; status: RunStatus;
        version: string; lease_owner: string | null; lease_epoch: string;
        lease_expires_at: Date | null; deadline_at: Date; cancel_requested_at: Date | null;
        outcome_code: string | null; error_code: string | null;
      }>(
        `SELECT id,tenant_id,integration_id,status,version,lease_owner,lease_epoch,
                lease_expires_at,deadline_at,cancel_requested_at,outcome_code,error_code
         FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2`,
        [tenantId, runId],
      );
      const row = result.rows[0];
      return row ? {
        id: row.id, tenantId: row.tenant_id, integrationId: row.integration_id,
        status: row.status, version: Number(row.version), leaseOwner: row.lease_owner ?? undefined,
        leaseEpoch: Number(row.lease_epoch), leaseExpiresAt: row.lease_expires_at?.toISOString(),
        deadlineAt: row.deadline_at.toISOString(), cancelRequestedAt: row.cancel_requested_at?.toISOString(),
        outcomeCode: row.outcome_code ?? undefined, errorCode: row.error_code ?? undefined,
      } : undefined;
    });
  }

  async beginStep(
    lease: RunLease,
    input: {
      stepKey: string;
      kind: RunStepKind;
      inputHash: string;
      tool?: { kind: ToolCallKind; name: string; requestHash: string };
    },
  ): Promise<RunStep> {
    requiredText(input.stepKey, "step key");
    requiredText(input.kind, "step kind");
    requiredHash(input.inputHash, "step input hash");
    if ((input.kind === "tool") !== Boolean(input.tool)) {
      throw new Error("tool step metadata is required only for tool steps");
    }
    if (input.tool) {
      requiredText(input.tool.name, "tool name");
      requiredHash(input.tool.requestHash, "tool request hash");
    }
    const maxStepAttempts = positiveLimit(lease.limits.maxStepAttempts, "limits.maxStepAttempts", 3);
    return measureDatabaseOperation("step_transaction", () => this.withLease(lease, async (client) => {
      const selected = await client.query<StepRow>(
        `SELECT * FROM pr_agent_harness.agent_steps
         WHERE tenant_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE`,
        [lease.tenantId, lease.runId, input.stepKey],
      );
      let step = selected.rows[0];
      if (step && (step.input_hash !== input.inputHash || step.step_kind !== input.kind)) {
        throw new RunStepConflictError(input.stepKey);
      }
      if (step?.status === "succeeded") {
        const attempt = await latestStepAttempt(client, lease, step.id);
        return mapStep(step, attempt.id, attempt.attempt_number, true);
      }
      if (step?.status === "running" && Number(step.last_lease_epoch) === lease.epoch) {
        const active = await activeStepAttempt(client, lease, step.id);
        if (active) return mapStep(step, active.id, active.attempt_number, false);
      }
      if (step) {
        const failedAttempts = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pr_agent_harness.step_attempts
           WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3
             AND status IN ('failed','abandoned')
             AND COALESCE(error_code,'') NOT IN ('worker_shutdown','heartbeat_lease_uncertain')`,
          [lease.tenantId, lease.runId, step.id],
        );
        if (failedAttempts.rows[0]!.count >= maxStepAttempts) {
          throw new RunStepAttemptLimitError(input.stepKey);
        }
        await client.query(
          `UPDATE pr_agent_harness.step_attempts
           SET status='abandoned',error_code='lease_replaced',completed_at=now()
           WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND status='running'`,
          [lease.tenantId, lease.runId, step.id],
        );
        const updated = await client.query<StepRow>(
          `UPDATE pr_agent_harness.agent_steps
           SET status='running',output_hash=NULL,output_json=NULL,completed_at=NULL,
               last_lease_epoch=$4,attempt_count=attempt_count+1,updated_at=now()
           WHERE tenant_id=$1 AND run_id=$2 AND id=$3 RETURNING *`,
          [lease.tenantId, lease.runId, step.id, lease.epoch],
        );
        step = updated.rows[0]!;
      } else {
        const inserted = await client.query<StepRow>(
          `INSERT INTO pr_agent_harness.agent_steps
             (tenant_id,run_id,step_key,step_kind,input_hash,last_lease_epoch,attempt_count)
           VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING *`,
          [lease.tenantId, lease.runId, input.stepKey, input.kind, input.inputHash, lease.epoch],
        );
        step = inserted.rows[0]!;
      }
      const attempt = await client.query<{ id: string; attempt_number: number }>(
        `INSERT INTO pr_agent_harness.step_attempts
           (tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,attempt_number`,
        [lease.tenantId, lease.runId, step.id, step.attempt_count, lease.owner, lease.epoch],
      );
      if (input.tool) {
        await client.query(
          `INSERT INTO pr_agent_harness.tool_calls
             (tenant_id,run_id,step_id,step_attempt_id,tool_kind,tool_name,request_hash,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'in_flight')`,
          [lease.tenantId, lease.runId, step.id, attempt.rows[0]!.id,
            input.tool.kind, input.tool.name, input.tool.requestHash],
        );
      }
      await appendRunEvent(client, lease.tenantId, lease.runId, "step.started", lease.owner, {
        stepId: step.id, stepKey: step.step_key, kind: step.step_kind,
        attemptId: attempt.rows[0]!.id, attemptNumber: attempt.rows[0]!.attempt_number,
      });
      return mapStep(step, attempt.rows[0]!.id, attempt.rows[0]!.attempt_number, false);
    }));
  }

  async getStep(lease: RunLease, stepKey: string): Promise<RunStep | undefined> {
    requiredText(stepKey, "step key");
    return this.withLease(lease, async (client) => {
      const selected = await client.query<StepRow>(
        `SELECT * FROM pr_agent_harness.agent_steps
         WHERE tenant_id=$1 AND run_id=$2 AND step_key=$3`,
        [lease.tenantId, lease.runId, stepKey],
      );
      const step = selected.rows[0];
      if (!step) return undefined;
      const attempt = await client.query<{ id: string; attempt_number: number }>(
        `SELECT id,attempt_number FROM pr_agent_harness.step_attempts
         WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3
         ORDER BY attempt_number DESC LIMIT 1`,
        [lease.tenantId, lease.runId, step.id],
      );
      if (!attempt.rows[0]) throw new Error("run step has no physical attempt");
      return mapStep(
        step,
        attempt.rows[0].id,
        attempt.rows[0].attempt_number,
        step.status === "succeeded",
      );
    });
  }

  async completeStep(
    lease: RunLease,
    input: {
      stepId: string;
      attemptId: string;
      outputHash: string;
      output: JsonObject;
      preparedArtifact?: PreparedRunArtifact;
      resultRef?: string;
      checkpoint: { schemaVersion: number; stateHash: string; state: JsonObject };
    },
  ): Promise<RunCheckpoint> {
    requiredHash(input.outputHash, "step output hash");
    requiredHash(input.checkpoint.stateHash, "checkpoint state hash");
    positiveInteger(input.checkpoint.schemaVersion, "checkpoint schema version");
    return measureDatabaseOperation("step_transaction", () => this.withLease(lease, async (client) => {
      const selected = await client.query<StepRow>(
        `SELECT * FROM pr_agent_harness.agent_steps
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE`,
        [lease.tenantId, lease.runId, input.stepId],
      );
      const step = selected.rows[0];
      if (!step) throw new Error("run step not found");
      if (step.status === "succeeded") {
        if (step.output_hash !== input.outputHash) throw new RunStepConflictError(step.step_key);
        if (input.preparedArtifact && step.result_ref !== input.preparedArtifact.artifactHash) {
          throw new RunStepConflictError(step.step_key);
        }
        const existing = await checkpointForStep(client, lease, step.id);
        if (!existing || existing.state_hash !== input.checkpoint.stateHash) {
          throw new RunCheckpointCompatibilityError(lease.runId);
        }
        return mapCheckpoint(existing);
      }
      const attempt = await client.query(
        `UPDATE pr_agent_harness.step_attempts
         SET status='succeeded',completed_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND step_id=$4
           AND lease_owner=$5 AND lease_epoch=$6 AND status='running'`,
        [lease.tenantId, lease.runId, input.attemptId, input.stepId, lease.owner, lease.epoch],
      );
      if (attempt.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      const artifact = input.preparedArtifact
        ? await this.artifacts.putPreparedInTransaction(client, {
          tenantId: lease.tenantId,
          integrationId: lease.integrationId,
          runId: lease.runId,
        }, input.preparedArtifact)
        : undefined;
      if (artifact && artifact.artifactHash !== input.preparedArtifact?.artifactHash) {
        throw new RunStepConflictError(step.step_key);
      }
      const resultRef = artifact?.artifactHash ?? input.resultRef;
      const toolCall = await client.query(
        `UPDATE pr_agent_harness.tool_calls
         SET status='succeeded',result_hash=$4,result_ref=$5,completed_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND step_attempt_id=$3 AND status='in_flight'`,
        [lease.tenantId, lease.runId, input.attemptId, input.outputHash, resultRef ?? null],
      );
      if (step.step_kind === "tool" && toolCall.rowCount !== 1) {
        throw new Error("tool step attempt has no in-flight tool call");
      }
      await client.query(
        `UPDATE pr_agent_harness.agent_steps
         SET status='succeeded',output_hash=$4,output_json=$5::jsonb,result_ref=$6,
             completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3`,
        [lease.tenantId, lease.runId, input.stepId, input.outputHash, JSON.stringify(input.output),
          resultRef ?? null],
      );
      const sequence = await nextCheckpointSequence(client, lease);
      const checkpoint = await client.query<CheckpointRow>(
        `INSERT INTO pr_agent_harness.checkpoints
           (tenant_id,run_id,sequence,step_id,step_attempt_id,schema_version,
            runtime_version_hash,state_hash,state_json,lease_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
        [lease.tenantId, lease.runId, sequence, input.stepId, input.attemptId,
          input.checkpoint.schemaVersion, lease.runtimeVersionHash,
          input.checkpoint.stateHash, JSON.stringify(input.checkpoint.state), lease.epoch],
      );
      await appendRunEvent(client, lease.tenantId, lease.runId, "step.completed", lease.owner, {
        stepId: input.stepId, attemptId: input.attemptId, checkpointSequence: sequence,
      });
      return mapCheckpoint(checkpoint.rows[0]!);
    }));
  }

  async loadStepOutput<T>(lease: RunLease, step: RunStep): Promise<T> {
    if (!step.outputHash) throw new RunCheckpointCompatibilityError(lease.runId);
    const outputHash = step.outputHash;
    return this.withLease(lease, (client) => this.artifacts.readStepOutputValueInTransaction<T>(
      client,
      { tenantId: lease.tenantId, integrationId: lease.integrationId, runId: lease.runId },
      { resultRef: step.resultRef, output: step.output, outputHash },
    ));
  }

  /** Settle a caught role/tool failure without leaving an in-flight attempt behind. */
  async failStep(lease: RunLease, input: { stepId: string; attemptId: string; errorCode: string }): Promise<void> {
    requiredText(input.errorCode, "step error code");
    await this.withLease(lease, async (client) => {
      const attempt = await client.query(
        `UPDATE pr_agent_harness.step_attempts SET status='failed',error_code=$7,completed_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND id=$4
           AND lease_owner=$5 AND lease_epoch=$6 AND status='running' RETURNING id`,
        [lease.tenantId, lease.runId, input.stepId, input.attemptId, lease.owner, lease.epoch, input.errorCode],
      );
      if (attempt.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      const output = { errorCode: input.errorCode };
      await client.query(
        `UPDATE pr_agent_harness.agent_steps
         SET status='failed',output_json=$4::jsonb,output_hash=$5,completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='running'`,
        [lease.tenantId, lease.runId, input.stepId, JSON.stringify(output), fingerprint(output)],
      );
      await client.query(
        `UPDATE pr_agent_harness.tool_calls SET status='failed_definite',error_code=$4,completed_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND step_attempt_id=$3 AND status='in_flight'`,
        [lease.tenantId, lease.runId, input.attemptId, input.errorCode],
      );
      await appendRunEvent(client, lease.tenantId, lease.runId, "step.failed", lease.owner,
        { stepId: input.stepId, attemptId: input.attemptId, reasonCode: input.errorCode });
    });
  }

  async latestCheckpoint(
    lease: RunLease,
    expected: { schemaVersion: number; runtimeVersionHash: string },
  ): Promise<RunCheckpoint | undefined> {
    return this.withLease(lease, async (client) => {
      const result = await client.query<CheckpointRow>(
        `SELECT * FROM pr_agent_harness.checkpoints
         WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence DESC LIMIT 1`,
        [lease.tenantId, lease.runId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      if (row.schema_version !== expected.schemaVersion
          || row.runtime_version_hash !== expected.runtimeVersionHash) {
        throw new RunCheckpointCompatibilityError(lease.runId);
      }
      return mapCheckpoint(row);
    });
  }

  async transition(
    lease: RunLease,
    input: {
      to: "succeeded" | "failed" | "cancelled" | "retry_wait" |
        "waiting_for_user" | "waiting_for_reconciliation";
      reasonCode?: string;
      outcomeCode?: string;
      retryDelayMs?: number;
      retryAt?: string;
    },
    beforeTransition?: (client: PoolClient) => Promise<unknown>,
  ): Promise<RunExecutionSnapshot> {
    return this.withLease(lease, async (client) => {
      const terminal = input.to === "succeeded" || input.to === "failed" || input.to === "cancelled";
      if (input.to === "retry_wait" && input.retryDelayMs === undefined && !input.retryAt) {
        throw new Error("retryDelayMs is required for retry_wait");
      }
      if (input.retryDelayMs !== undefined) {
        positiveInteger(input.retryDelayMs, "retry delay");
      }
      if (beforeTransition && !terminal) {
        throw new Error("transition transaction hook is allowed only for terminal Run states");
      }
      let waitingBatch: { batch_id: string; operation_set_hash: string } | undefined;
      if (input.to === "waiting_for_reconciliation") {
        const linked = await client.query<{ batch_id: string; operation_set_hash: string }>(
          `SELECT l.batch_id,l.operation_set_hash
           FROM pr_agent_harness.run_publication_batches l
           JOIN pr_agent_harness.publication_batches b
             ON b.tenant_id=l.tenant_id AND b.id=l.batch_id
           WHERE l.tenant_id=$1 AND l.run_id=$2 AND b.seal_state='sealed'
             AND b.operation_set_hash=l.operation_set_hash
           ORDER BY l.batch_id LIMIT 2`,
          [lease.tenantId, lease.runId],
        );
        if (linked.rowCount !== 1) {
          throw new Error("waiting-for-reconciliation Run requires exactly one frozen publication batch");
        }
        waitingBatch = linked.rows[0];
      }
      await abandonActiveStepAttempts(
        client,
        lease.tenantId,
        lease.runId,
        input.reasonCode ?? `run_${input.to}`,
      );
      await beforeTransition?.(client);
      const result = await client.query<{
        id: string; tenant_id: string; integration_id: string; status: RunStatus;
        version: string; lease_owner: string | null; lease_epoch: string;
        lease_expires_at: Date | null; deadline_at: Date; cancel_requested_at: Date | null;
        outcome_code: string | null; error_code: string | null;
      }>(
        `UPDATE pr_agent_harness.agent_runs
         SET status=$3,lease_owner=NULL,lease_expires_at=NULL,
             outcome_code=$4,error_code=$5,
             waiting_batch_id=CASE WHEN $7::uuid IS NOT NULL THEN $7 ELSE waiting_batch_id END,
             waiting_operation_set_hash=CASE WHEN $8::text IS NOT NULL THEN $8 ELSE waiting_operation_set_hash END,
             finished_at=CASE WHEN $6 THEN now() ELSE NULL END,
             next_outcome_scan_at=CASE
               WHEN $7::uuid IS NOT NULL THEN COALESCE(next_outcome_scan_at,clock_timestamp())
               WHEN $6 AND NOT EXISTS (
                 SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
                 WHERE rpb.tenant_id=$1 AND rpb.run_id=$2
               ) THEN NULL
               WHEN $6 THEN COALESCE(next_outcome_scan_at,clock_timestamp())
               ELSE next_outcome_scan_at END,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,tenant_id,integration_id,status,version,lease_owner,lease_epoch,
           lease_expires_at,deadline_at,cancel_requested_at,outcome_code,error_code`,
        [lease.tenantId, lease.runId, input.to, input.outcomeCode ?? null,
          input.reasonCode ?? null, terminal, waitingBatch?.batch_id ?? null,
          waitingBatch?.operation_set_hash ?? null],
      );
      const jobStatus = input.to === "retry_wait" ? "retry_wait"
        : terminal && input.to === "failed" ? "dead_letter"
          : terminal && input.to === "cancelled" ? "cancelled" : "completed";
      const job = await client.query(
        `UPDATE pr_agent_harness.job_queue
         SET status=$5,available_at=CASE WHEN $5='retry_wait' THEN
               CASE WHEN $6::double precision IS NOT NULL
                 THEN now()+($6::double precision*interval '1 millisecond')
                 ELSE $7::timestamptz
               END
             ELSE available_at END,
             last_error_code=$8,
             completed_at=CASE WHEN $5 IN ('completed','cancelled','dead_letter') THEN now() ELSE NULL END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND claimed_run_epoch=$4`,
        [lease.tenantId, lease.jobId, lease.runId, lease.epoch,
          jobStatus, input.retryDelayMs ?? null, input.retryAt ?? null,
          input.reasonCode ?? null],
      );
      if (job.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      if (lease.jobKind === "manual_resume") {
        const receiptId = typeof lease.jobPayload?.commandReceiptId === "string"
          ? lease.jobPayload.commandReceiptId
          : undefined;
        if (!receiptId) throw new Error("manual-resume job is missing its command receipt");
        const receipt = await client.query(
          `UPDATE pr_agent_harness.run_command_receipts
           SET status='completed',result_json=$4::jsonb,resulting_version=$5,updated_at=now()
           WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status IN ('accepted','completed')`,
          [lease.tenantId, lease.runId, receiptId,
            JSON.stringify({ status: input.to, outcomeCode: input.outcomeCode ?? null,
              reasonCode: input.reasonCode ?? null }), Number(result.rows[0]!.version)],
        );
        if (receipt.rowCount !== 1) throw new Error("manual-resume receipt is unavailable");
      }
      if (input.to === "failed") {
        await insertDeadLetter(client, lease.tenantId, {
          id: lease.runId,
          job_id: lease.jobId,
          lease_epoch: String(lease.epoch),
          attempt_count: lease.jobAttempt,
        }, input.reasonCode ?? "run_failed");
      }
      await appendRunEvent(client, lease.tenantId, lease.runId, `run.${input.to}`, lease.owner, {
        reasonCode: input.reasonCode ?? null, outcomeCode: input.outcomeCode ?? null,
      });
      const row = result.rows[0]!;
      return {
        id: row.id, tenantId: row.tenant_id, integrationId: row.integration_id,
        status: row.status, version: Number(row.version), leaseOwner: row.lease_owner ?? undefined,
        leaseEpoch: Number(row.lease_epoch), leaseExpiresAt: row.lease_expires_at?.toISOString(),
        deadlineAt: row.deadline_at.toISOString(), cancelRequestedAt: row.cancel_requested_at?.toISOString(),
        outcomeCode: row.outcome_code ?? undefined, errorCode: row.error_code ?? undefined,
      };
    });
  }

  async waitForPublicationDecision(
    lease: RunLease,
    input: {
      batchId: string;
      operationSetHash: string;
      businessOperationId: string;
      operationVersion: number;
      allowedDecisions: readonly ("confirm_occurred" | "confirm_not_occurred" |
        "authorize_retry" | "abandon_publication")[];
    },
  ): Promise<{ waitId: string; waitVersion: number }> {
    requiredHash(input.operationSetHash, "publication operation-set hash");
    if (!Number.isSafeInteger(input.operationVersion) || input.operationVersion < 0) {
      throw new Error("publication operation version must be non-negative");
    }
    if (!input.allowedDecisions.length) throw new Error("publication wait decisions are required");
    return this.withLease(lease, async (client) => {
      const operation = await client.query<{
        request_hash: string; version: string; status: string;
      }>(
        `SELECT ro.business_operation_id AS request_hash,ro.version,ro.status
         FROM pr_agent_harness.run_publication_batches rpb
         JOIN pr_agent_harness.publication_batch_operations pbo
           ON pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id
         JOIN pr_agent_harness.repository_operations ro
           ON ro.tenant_id=pbo.tenant_id AND ro.business_operation_id=pbo.business_operation_id
         WHERE rpb.tenant_id=$1 AND rpb.run_id=$2 AND rpb.batch_id=$3
           AND rpb.operation_set_hash=$4 AND pbo.business_operation_id=$5
         FOR UPDATE OF ro`,
        [lease.tenantId, lease.runId, input.batchId, input.operationSetHash,
          input.businessOperationId],
      );
      const row = operation.rows[0];
      if (!row || Number(row.version) !== input.operationVersion || row.status !== "manual_review") {
        throw new Error("publication wait no longer matches the exact operation version");
      }
      const inserted = await client.query<{ id: string; version: string }>(
        `INSERT INTO pr_agent_harness.run_waits
           (tenant_id,run_id,batch_id,operation_set_hash,business_operation_id,
            operation_version,intent_hash,allowed_decisions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (tenant_id,run_id,business_operation_id,operation_version) DO NOTHING
         RETURNING id,version`,
        [lease.tenantId, lease.runId, input.batchId, input.operationSetHash,
          input.businessOperationId, input.operationVersion, row.request_hash,
          JSON.stringify([...input.allowedDecisions])],
      );
      let wait = inserted.rows[0];
      if (!wait) {
        const existing = await client.query<{ id: string; version: string; allowed_decisions: unknown }>(
          `SELECT id,version,allowed_decisions FROM pr_agent_harness.run_waits
           WHERE tenant_id=$1 AND run_id=$2 AND business_operation_id=$3
             AND operation_version=$4 AND status='open'`,
          [lease.tenantId, lease.runId, input.businessOperationId, input.operationVersion],
        );
        wait = existing.rows[0];
        if (!wait || JSON.stringify(existing.rows[0]!.allowed_decisions) !== JSON.stringify([...input.allowedDecisions])) {
          throw new Error("publication wait identity conflict");
        }
      }
      await abandonActiveStepAttempts(client, lease.tenantId, lease.runId, "publication_manual_review");
      const run = await client.query<{ version: string }>(
        `UPDATE pr_agent_harness.agent_runs
         SET status='waiting_for_user',lease_owner=NULL,lease_expires_at=NULL,
             error_code='publication_manual_review',version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='running' RETURNING version`,
        [lease.tenantId, lease.runId],
      );
      if (run.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      const job = await client.query(
        `UPDATE pr_agent_harness.job_queue
         SET status='completed',completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND claimed_run_epoch=$4 AND status='running'`,
        [lease.tenantId, lease.jobId, lease.runId, lease.epoch],
      );
      if (job.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      if (lease.jobKind === "manual_resume") {
        const receiptId = typeof lease.jobPayload?.commandReceiptId === "string"
          ? lease.jobPayload.commandReceiptId
          : undefined;
        if (!receiptId) throw new Error("manual-resume job is missing its command receipt");
        const receipt = await client.query(
          `UPDATE pr_agent_harness.run_command_receipts
           SET status='completed',result_json=$4::jsonb,resulting_version=$5,updated_at=now()
           WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status IN ('accepted','completed')`,
          [lease.tenantId, lease.runId, receiptId,
            JSON.stringify({ status: "waiting_for_user", waitId: wait.id,
              waitVersion: Number(wait.version) }), Number(run.rows[0]!.version)],
        );
        if (receipt.rowCount !== 1) throw new Error("manual-resume receipt is unavailable");
      }
      await appendRunFact(client, {
        tenantId: lease.tenantId,
        runId: lease.runId,
        eventType: "run.waiting_for_user",
        actorType: "worker",
        actorId: lease.owner,
        payload: { reasonCode: "publication_manual_review", waitId: wait.id,
          waitVersion: Number(wait.version), businessOperationId: input.businessOperationId,
          operationVersion: input.operationVersion },
      });
      return { waitId: wait.id, waitVersion: Number(wait.version) };
    });
  }

  async retrySpecialJob(lease: RunLease, retryDelayMs: number, errorCode: string): Promise<void> {
    positiveInteger(retryDelayMs, "retry delay");
    if (lease.jobKind !== "publication_outcome" && lease.jobKind !== "manual_resume") {
      throw new Error("retrySpecialJob requires a special Run job");
    }
    await this.withLease(lease, async (client) => {
      const jobState = await client.query<{ max_attempts: number; attempt_count: number }>(
        `SELECT max_attempts,attempt_count FROM pr_agent_harness.job_queue
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND claimed_run_epoch=$4
           AND status='running' FOR UPDATE`,
        [lease.tenantId, lease.jobId, lease.runId, lease.epoch],
      );
      const jobRow = jobState.rows[0];
      if (!jobRow) throw new RunLeaseLostError(lease.runId);
      if (jobRow.attempt_count >= jobRow.max_attempts) {
        const reason = requiredText(errorCode, "error code");
        const run = await client.query<{ version: string; lease_epoch: string }>(
          `UPDATE pr_agent_harness.agent_runs
           SET status='failed',lease_owner=NULL,lease_expires_at=NULL,error_code=$3,
               finished_at=now(),
               next_outcome_scan_at=CASE WHEN NOT EXISTS (
                 SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
                 WHERE rpb.tenant_id=$1 AND rpb.run_id=$2
               ) THEN NULL ELSE COALESCE(next_outcome_scan_at,clock_timestamp()) END,
               version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND status='running'
           RETURNING version,lease_epoch`,
          [lease.tenantId, lease.runId, reason],
        );
        if (!run.rows[0]) throw new RunLeaseLostError(lease.runId);
        const job = await client.query(
          `UPDATE pr_agent_harness.job_queue
           SET status='dead_letter',last_error_code=$5,completed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND claimed_run_epoch=$4
             AND status='running'`,
          [lease.tenantId, lease.jobId, lease.runId, lease.epoch, reason],
        );
        if (job.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
        if (lease.jobKind === "manual_resume") {
          const receiptId = typeof lease.jobPayload?.commandReceiptId === "string"
            ? lease.jobPayload.commandReceiptId
            : undefined;
          if (!receiptId) throw new Error("manual-resume job is missing its command receipt");
          const receipt = await client.query(
            `UPDATE pr_agent_harness.run_command_receipts
             SET status='completed',result_json=$4::jsonb,resulting_version=$5,updated_at=now()
             WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status IN ('accepted','completed')`,
            [lease.tenantId, lease.runId, receiptId,
              JSON.stringify({ status: "failed", reasonCode: reason }),
              Number(run.rows[0].version)],
          );
          if (receipt.rowCount !== 1) throw new Error("manual-resume receipt is unavailable");
        }
        await insertDeadLetter(client, lease.tenantId, {
          id: lease.runId,
          job_id: lease.jobId,
          lease_epoch: run.rows[0].lease_epoch,
          attempt_count: jobRow.attempt_count,
        }, reason);
        await appendRunFact(client, {
          tenantId: lease.tenantId,
          runId: lease.runId,
          eventType: "run.failed",
          actorType: "worker",
          actorId: lease.owner,
          payload: { reasonCode: reason, jobKind: lease.jobKind,
            attempts: jobRow.attempt_count, maxAttempts: jobRow.max_attempts },
        });
        return;
      }
      const waitingStatus = lease.jobKind === "publication_outcome"
        ? "waiting_for_reconciliation"
        : "waiting_for_user";
      const run = await client.query<{ version: string }>(
        `UPDATE pr_agent_harness.agent_runs
         SET status=$3,lease_owner=NULL,lease_expires_at=NULL,error_code=$4,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='running'
         RETURNING version`,
        [lease.tenantId, lease.runId, waitingStatus, requiredText(errorCode, "error code")],
      );
      if (!run.rows[0]) throw new RunLeaseLostError(lease.runId);
      const job = await client.query(
        `UPDATE pr_agent_harness.job_queue
         SET status='retry_wait',available_at=now()+($5::double precision*interval '1 millisecond'),
             expected_run_version=$6,last_error_code=$7,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND run_id=$3 AND claimed_run_epoch=$4 AND status='running'`,
        [lease.tenantId, lease.jobId, lease.runId, lease.epoch, retryDelayMs,
          Number(run.rows[0].version), errorCode],
      );
      if (job.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
      await appendRunFact(client, {
        tenantId: lease.tenantId,
        runId: lease.runId,
        eventType: "run.retry_wait",
        actorType: "worker",
        actorId: lease.owner,
        payload: { reasonCode: errorCode },
      });
    });
  }

  async sweep(binding: ClaimableBinding, limit = 100): Promise<SweepResult> {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 1_000));
    return this.db.transaction(binding.tenantId, async (client) => {
      const result: SweepResult = { retried: 0, deadLettered: 0, cancelled: 0 };
      const waiting = await client.query<{
        id: string; cancel_requested_at: Date | null; deadline_expired: boolean;
      }>(
        `SELECT r.id,r.cancel_requested_at,(r.deadline_at<=now()) AS deadline_expired
         FROM pr_agent_harness.agent_runs r
         WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.authority_generation=$3
           AND r.execution_mode_generation=$4
           AND r.status IN ('waiting_for_reconciliation','waiting_for_user')
           AND (r.cancel_requested_at IS NOT NULL OR r.deadline_at<=now())
         ORDER BY r.updated_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT $5`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration, bounded],
      );
      for (const row of waiting.rows) {
        const status = row.cancel_requested_at ? "cancelled" : "failed";
        const reason = row.cancel_requested_at ? "cancel_requested" : "run_deadline_exceeded";
        await client.query(
          `UPDATE pr_agent_harness.agent_runs
           SET status=$3,error_code=$4,finished_at=now(),
               next_outcome_scan_at=CASE WHEN NOT EXISTS (
                 SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
                 WHERE rpb.tenant_id=$1 AND rpb.run_id=$2
               ) THEN NULL ELSE COALESCE(next_outcome_scan_at,clock_timestamp()) END,
               version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [binding.tenantId, row.id, status, reason],
        );
        await client.query(
          `UPDATE pr_agent_harness.job_queue
           SET status=CASE WHEN $3='cancelled' THEN 'cancelled' ELSE 'dead_letter' END,
               last_error_code=$4,completed_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND run_id=$2 AND status IN ('ready','retry_wait')`,
          [binding.tenantId, row.id, status, reason],
        );
        await appendRunFact(client, {
          tenantId: binding.tenantId,
          runId: row.id,
          eventType: `run.${status}`,
          actorType: "system",
          actorId: "run-sweeper",
          payload: { reasonCode: reason },
        });
        if (status === "cancelled") result.cancelled += 1;
        else result.deadLettered += 1;
      }
      const candidates = await client.query<{
        id: string; job_id: string; lease_epoch: string; attempt_count: number;
        job_kind: RunJobKind;
        max_attempts: number; cancel_requested_at: Date | null; deadline_at: Date;
        deadline_expired: boolean;
      }>(
        `SELECT r.id,j.id AS job_id,r.lease_epoch,j.attempt_count,j.max_attempts,j.job_kind,
                r.cancel_requested_at,r.deadline_at,
                (r.deadline_at<=now()) AS deadline_expired
         FROM pr_agent_harness.agent_runs r
         JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
         WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.authority_generation=$3
           AND r.execution_mode_generation=$4
           AND ((r.status='running' AND j.status='running')
             OR (r.status IN ('queued','retry_wait') AND j.status IN ('ready','retry_wait')))
           AND (r.cancel_requested_at IS NOT NULL OR r.deadline_at<=now()
                OR (r.status='running' AND r.lease_expires_at<=now()))
         ORDER BY r.updated_at,r.id FOR UPDATE OF r,j SKIP LOCKED LIMIT $5`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration, bounded],
      );
      for (const row of candidates.rows) {
        if (row.cancel_requested_at) {
          await settleSweptRun(client, binding.tenantId, row, "cancelled", "cancel_requested");
          result.cancelled += 1;
        } else if (row.deadline_expired || row.attempt_count >= row.max_attempts) {
          const reason = row.deadline_expired ? "run_deadline_exceeded" : "run_attempts_exhausted";
          await settleSweptRun(client, binding.tenantId, row, "failed", reason);
          if (row.job_kind === "manual_resume") {
            await completeManualReceiptForJob(client, binding.tenantId, row.job_id, reason);
          }
          await insertDeadLetter(client, binding.tenantId, row, reason);
          result.deadLettered += 1;
        } else {
          const delay = Math.min(this.initialRetryMs * 2 ** Math.max(0, row.attempt_count - 1), this.maxRetryMs);
          if (row.job_kind === "publication_outcome" || row.job_kind === "manual_resume") {
            await retrySweptSpecialRun(client, binding.tenantId, row, delay, row.job_kind);
          } else {
            await retrySweptRun(client, binding.tenantId, row, delay);
          }
          result.retried += 1;
        }
      }
      return result;
    });
  }
}

function capabilityForWorkflow(workflow: string): ProductCapability | undefined {
  return workflow === "review" ? "review.single" : workflowCapability(workflow);
}

async function capabilityEnabled(
  client: PoolClient,
  binding: ClaimableBinding,
  capability: ProductCapability,
): Promise<boolean> {
  try {
    await lockCurrentBindingCapability(client, { tenantId: binding.tenantId,
      integrationId: binding.integrationId, capability });
    return true;
  } catch (error) {
    if (error instanceof RunControlError
        && ["CAPABILITY_DISABLED", "BINDING_UNAVAILABLE"].includes(error.code)) return false;
    throw error;
  }
}

export async function assertRunLease(
  client: PoolClient,
  lease: RunLeaseIdentity,
  options: { lock?: "share" | "update" } = {},
): Promise<LockedRun> {
  const lock = options.lock === "share" ? "FOR SHARE" : "FOR UPDATE";
  const result = await client.query<{
    status: RunStatus; lease_expires_at: Date; deadline_at: Date;
  }>(
    `SELECT status,lease_expires_at,deadline_at
     FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND id=$2
       AND lease_owner=$3 AND lease_epoch=$4
       AND status='running' AND lease_expires_at>clock_timestamp()
       AND deadline_at>clock_timestamp() AND cancel_requested_at IS NULL
     ${lock}`,
    [lease.tenantId, lease.runId, lease.owner, lease.epoch],
  );
  const row = result.rows[0];
  if (!row) throw new RunLeaseLostError(lease.runId);
  return {
    status: row.status,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(),
  };
}

export async function linkBatchAndCheckpoint(
  client: PoolClient,
  lease: RunLease,
  input: {
    batchId: string;
    operationSetHash: string;
    schemaVersion: number;
    stateHash: string;
    state: JsonObject;
  },
): Promise<RunCheckpoint> {
  requiredHash(input.operationSetHash, "operation set hash");
  requiredHash(input.stateHash, "checkpoint state hash");
  positiveInteger(input.schemaVersion, "checkpoint schema version");
  await assertRunLease(client, lease, { lock: "update" });
  const batch = await client.query(
    `SELECT 1 FROM pr_agent_harness.publication_batches
     WHERE tenant_id=$1 AND id=$2 AND integration_id=$3
       AND authority_generation=$4 AND seal_state='sealed'
       AND operation_set_hash=$5`,
    [lease.tenantId, input.batchId, lease.integrationId, lease.authorityGeneration,
      input.operationSetHash],
  );
  if (batch.rowCount !== 1) throw new Error("sealed publication batch does not match the current Run");
  const existing = await client.query<CheckpointRow & { operation_set_hash: string }>(
    `SELECT c.*,l.operation_set_hash
     FROM pr_agent_harness.run_publication_batches l
     JOIN pr_agent_harness.checkpoints c
       ON c.tenant_id=l.tenant_id AND c.run_id=l.run_id
      AND c.publication_batch_id=l.batch_id
     WHERE l.tenant_id=$1 AND l.run_id=$2 AND l.batch_id=$3`,
    [lease.tenantId, lease.runId, input.batchId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.operation_set_hash !== input.operationSetHash
        || row.schema_version !== input.schemaVersion
        || row.runtime_version_hash !== lease.runtimeVersionHash
        || row.state_hash !== input.stateHash) {
      throw new RunCheckpointCompatibilityError(lease.runId);
    }
    await markRunForOutcomeScan(client, lease);
    return mapCheckpoint(row);
  }
  const link = await client.query<{ run_id: string; operation_set_hash: string }>(
    `INSERT INTO pr_agent_harness.run_publication_batches
       (tenant_id,run_id,batch_id,step_id,lease_epoch,operation_set_hash)
     VALUES ($1,$2,$3,NULL,$4,$5)
     ON CONFLICT DO NOTHING
     RETURNING run_id,operation_set_hash`,
    [lease.tenantId, lease.runId, input.batchId, lease.epoch, input.operationSetHash],
  );
  if (!link.rows[0]) {
    const owner = await client.query<{ run_id: string; operation_set_hash: string }>(
      `SELECT run_id,operation_set_hash
       FROM pr_agent_harness.run_publication_batches
       WHERE tenant_id=$1 AND batch_id=$2`,
      [lease.tenantId, input.batchId],
    );
    if (owner.rows[0]?.run_id !== lease.runId
        || owner.rows[0]?.operation_set_hash !== input.operationSetHash) {
      throw new Error("publication batch is already owned by another Run");
    }
  }
  await markRunForOutcomeScan(client, lease);
  const sequence = await nextCheckpointSequence(client, lease);
  const checkpoint = await client.query<CheckpointRow>(
    `INSERT INTO pr_agent_harness.checkpoints
       (tenant_id,run_id,sequence,checkpoint_kind,publication_batch_id,schema_version,
        runtime_version_hash,state_hash,state_json,lease_epoch)
     VALUES ($1,$2,$3,'publication_frozen',$4,$5,$6,$7,$8::jsonb,$9)
     RETURNING *`,
    [lease.tenantId, lease.runId, sequence, input.batchId, input.schemaVersion,
      lease.runtimeVersionHash, input.stateHash, JSON.stringify(input.state), lease.epoch],
  );
  await appendRunEvent(client, lease.tenantId, lease.runId, "publication.frozen", lease.owner, {
    batchId: input.batchId, operationSetHash: input.operationSetHash,
    checkpointSequence: sequence,
  });
  return mapCheckpoint(checkpoint.rows[0]!);
}

async function markRunForOutcomeScan(client: PoolClient, lease: RunLease): Promise<void> {
  const updated = await client.query(
    `UPDATE pr_agent_harness.agent_runs
     SET next_outcome_scan_at=COALESCE(next_outcome_scan_at,clock_timestamp()),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND integration_id=$2 AND id=$3
       AND lease_owner=$4 AND lease_epoch=$5 AND status='running'`,
    [lease.tenantId, lease.integrationId, lease.runId, lease.owner, lease.epoch],
  );
  if (updated.rowCount !== 1) throw new RunLeaseLostError(lease.runId);
}

async function appendRunEvent(
  client: PoolClient,
  tenantId: string,
  runId: string,
  eventType: string,
  actorId: string,
  payload: JsonObject,
): Promise<void> {
  await appendRunFact(client, {
    tenantId,
    runId,
    eventType,
    actorType: "worker",
    actorId,
    payload,
    visibility: eventType.startsWith("run.") ? "public" : "internal",
  });
}

async function nextCheckpointSequence(client: PoolClient, lease: RunLease): Promise<number> {
  const result = await client.query<{ sequence: string }>(
    `UPDATE pr_agent_harness.agent_runs
     SET checkpoint_version=checkpoint_version+1
     WHERE tenant_id=$1 AND id=$2 RETURNING checkpoint_version AS sequence`,
    [lease.tenantId, lease.runId],
  );
  return Number(result.rows[0]!.sequence);
}

async function activeStepAttempt(client: PoolClient, lease: RunLease, stepId: string) {
  const result = await client.query<{ id: string; attempt_number: number }>(
    `SELECT id,attempt_number FROM pr_agent_harness.step_attempts
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3
       AND lease_owner=$4 AND lease_epoch=$5 AND status='running'`,
    [lease.tenantId, lease.runId, stepId, lease.owner, lease.epoch],
  );
  return result.rows[0];
}

async function latestStepAttempt(client: PoolClient, lease: RunLease, stepId: string) {
  const result = await client.query<{ id: string; attempt_number: number }>(
    `SELECT id,attempt_number FROM pr_agent_harness.step_attempts
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND status='succeeded'
     ORDER BY attempt_number DESC LIMIT 1`,
    [lease.tenantId, lease.runId, stepId],
  );
  if (!result.rows[0]) throw new Error("completed run step has no successful attempt");
  return result.rows[0];
}

async function checkpointForStep(client: PoolClient, lease: RunLease, stepId: string) {
  const result = await client.query<CheckpointRow>(
    `SELECT * FROM pr_agent_harness.checkpoints
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3`,
    [lease.tenantId, lease.runId, stepId],
  );
  return result.rows[0];
}

function mapLease(row: ClaimRow, tenantId: string, owner: string): RunLease {
  return {
    tenantId, runId: row.id, integrationId: row.integration_id, runType: row.run_type,
    jobId: row.job_id,
    jobKind: row.job_kind, jobPayload: row.job_payload_json,
    owner, epoch: Number(row.lease_epoch), jobAttempt: row.job_attempt,
    authorityGeneration: Number(row.authority_generation), deadlineAt: row.deadline_at.toISOString(),
    executionModeGeneration: Number(row.execution_mode_generation),
    baseSha: row.base_sha, headSha: row.head_sha,
    workflowVersionHash: row.workflow_version_hash, promptVersionHash: row.prompt_version_hash,
    modelVersionHash: row.model_version_hash, toolVersionHash: row.tool_version_hash,
    policyVersionHash: row.policy_version_hash, runtimeVersionHash: row.runtime_version_hash,
    input: row.input_json, limits: row.limits_json, runtimeConfig: row.runtime_config_json,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

function mapStep(
  row: StepRow,
  attemptId: string,
  attemptNumber: number,
  reused: boolean,
): RunStep {
  return {
    id: row.id, runId: row.run_id, stepKey: row.step_key, kind: row.step_kind,
    inputHash: row.input_hash, status: row.status, attemptId, attemptNumber, reused,
    output: row.output_json ?? undefined, outputHash: row.output_hash ?? undefined,
    resultRef: row.result_ref ?? undefined,
  };
}

function mapCheckpoint(row: CheckpointRow): RunCheckpoint {
  return {
    id: row.id, runId: row.run_id, sequence: Number(row.sequence),
    stepId: row.step_id ?? undefined, stepAttemptId: row.step_attempt_id ?? undefined,
    schemaVersion: row.schema_version,
    runtimeVersionHash: row.runtime_version_hash, stateHash: row.state_hash,
    state: row.state_json, createdAt: row.created_at.toISOString(),
  };
}

async function settleSweptRun(
  client: PoolClient,
  tenantId: string,
  row: { id: string; job_id: string; lease_epoch: string; attempt_count: number },
  status: "failed" | "cancelled",
  reason: string,
): Promise<void> {
  await abandonActiveStepAttempts(client, tenantId, row.id, reason);
  await client.query(
    `UPDATE pr_agent_harness.agent_runs
     SET status=$3,lease_owner=NULL,lease_expires_at=NULL,error_code=$4,
         finished_at=now(),
         next_outcome_scan_at=CASE WHEN NOT EXISTS (
           SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
           WHERE rpb.tenant_id=$1 AND rpb.run_id=$2
         ) THEN NULL ELSE COALESCE(next_outcome_scan_at,clock_timestamp()) END,
         version=version+1,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, row.id, status, reason],
  );
  await client.query(
    `UPDATE pr_agent_harness.job_queue
         SET status=$3,last_error_code=$4,
         completed_at=now(),updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, row.job_id, status === "failed" ? "dead_letter" : "cancelled", reason],
  );
  await appendRunEvent(client, tenantId, row.id, `run.${status}`, "run-sweeper", { reasonCode: reason });
}

async function retrySweptRun(
  client: PoolClient,
  tenantId: string,
  row: { id: string; job_id: string },
  delayMs: number,
): Promise<void> {
  await abandonActiveStepAttempts(client, tenantId, row.id, "lease_expired");
  await client.query(
    `UPDATE pr_agent_harness.agent_runs
     SET status='retry_wait',lease_owner=NULL,lease_expires_at=NULL,
         error_code='lease_expired',version=version+1,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, row.id],
  );
  await client.query(
    `UPDATE pr_agent_harness.job_queue
     SET status='retry_wait',available_at=now()+($3::double precision*interval '1 millisecond'),
         last_error_code='lease_expired',updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, row.job_id, delayMs],
  );
  await appendRunEvent(client, tenantId, row.id, "run.retry_wait", "run-sweeper", {
    reasonCode: "lease_expired", retryDelayMs: delayMs,
  });
}

async function retrySweptSpecialRun(
  client: PoolClient,
  tenantId: string,
  row: { id: string; job_id: string },
  delayMs: number,
  jobKind: "publication_outcome" | "manual_resume",
): Promise<void> {
  const waitingStatus = jobKind === "publication_outcome"
    ? "waiting_for_reconciliation"
    : "waiting_for_user";
  const run = await client.query<{ version: string }>(
    `UPDATE pr_agent_harness.agent_runs
     SET status=$3,lease_owner=NULL,lease_expires_at=NULL,
         error_code='lease_expired',version=version+1,updated_at=now()
     WHERE tenant_id=$1 AND id=$2 RETURNING version`,
    [tenantId, row.id, waitingStatus],
  );
  await client.query(
    `UPDATE pr_agent_harness.job_queue
     SET status='retry_wait',available_at=now()+($3::double precision*interval '1 millisecond'),
         expected_run_version=$4,last_error_code='lease_expired',updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, row.job_id, delayMs, Number(run.rows[0]!.version)],
  );
  await appendRunEvent(client, tenantId, row.id, "run.retry_wait", "run-sweeper", {
    reasonCode: "lease_expired", retryDelayMs: delayMs,
  });
}

async function terminalizeExhaustedSpecialJobs(
  client: PoolClient,
  binding: ClaimableBinding,
  jobKind: "publication_outcome" | "manual_resume",
): Promise<void> {
  const exhausted = await client.query<{
    id: string; job_id: string; lease_epoch: string; attempt_count: number;
  }>(
    `SELECT r.id,j.id AS job_id,r.lease_epoch,j.attempt_count
     FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
     WHERE r.tenant_id=$1 AND r.integration_id=$2
       AND r.authority_generation=$3 AND r.execution_mode_generation=$4
       AND r.status IN ('waiting_for_reconciliation','waiting_for_user')
       AND j.job_kind=$5 AND j.status IN ('ready','retry_wait')
       AND j.attempt_count>=j.max_attempts
     ORDER BY j.updated_at,j.id FOR UPDATE OF r,j SKIP LOCKED LIMIT 100`,
    [binding.tenantId, binding.integrationId, binding.authorityGeneration,
      binding.executionModeGeneration, jobKind],
  );
  for (const row of exhausted.rows) {
    const reason = "run_attempts_exhausted";
    await settleSweptRun(client, binding.tenantId, row, "failed", reason);
    if (jobKind === "manual_resume") {
      await completeManualReceiptForJob(client, binding.tenantId, row.job_id, reason);
    }
    await insertDeadLetter(client, binding.tenantId, row, reason);
  }
}

async function lockBindingCapacity(
  client: PoolClient,
  binding: ClaimableBinding,
  limit: number,
): Promise<boolean> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,8310))",
    [`${binding.tenantId}:${binding.integrationId}`],
  );
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND integration_id=$2 AND status='running'
       AND lease_expires_at>clock_timestamp()`,
    [binding.tenantId, binding.integrationId],
  );
  return (active.rows[0]?.count ?? 0) < limit;
}

async function completeManualReceiptForJob(
  client: PoolClient,
  tenantId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE pr_agent_harness.run_command_receipts c
     SET status='completed',result_json=$3::jsonb,resulting_version=r.version,updated_at=now()
     FROM pr_agent_harness.job_queue j
     JOIN pr_agent_harness.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.run_id
     WHERE j.tenant_id=$1 AND j.id=$2 AND j.command_receipt_id=c.id
       AND c.tenant_id=j.tenant_id AND c.run_id=j.run_id
       AND c.status IN ('accepted','completed')`,
    [tenantId, jobId, JSON.stringify({ status: "failed", reasonCode: reason })],
  );
}

async function abandonActiveStepAttempts(
  client: PoolClient,
  tenantId: string,
  runId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE pr_agent_harness.tool_calls
     SET status='unknown',error_code=$3,completed_at=now()
     WHERE tenant_id=$1 AND run_id=$2 AND status='in_flight'`,
    [tenantId, runId, reason],
  );
  await client.query(
    `UPDATE pr_agent_harness.step_attempts
     SET status='abandoned',error_code=$3,completed_at=now()
     WHERE tenant_id=$1 AND run_id=$2 AND status='running'`,
    [tenantId, runId, reason],
  );
}

async function insertDeadLetter(
  client: PoolClient,
  tenantId: string,
  row: { id: string; job_id: string; lease_epoch: string; attempt_count: number },
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO pr_agent_harness.dead_letter_jobs
       (tenant_id,run_id,job_id,final_run_epoch,attempt_count,reason_code,details_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (tenant_id,job_id) DO NOTHING`,
    [tenantId, row.id, row.job_id, Number(row.lease_epoch), row.attempt_count,
      reason, JSON.stringify({ source: "run-sweeper" })],
  );
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
  return value;
}

function requiredHash(value: string, name: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${name} must be lowercase SHA-256`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function positiveLimit(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new Error(`${name} must be numeric`);
  return positiveInteger(value, name);
}
