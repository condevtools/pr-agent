import type { PoolClient } from "pg";

import { HarnessDatabase } from "./postgres/database.js";
import type { RunStatus } from "./postgres/run-store.js";
import {
  RunCheckpointCompatibilityError,
  RunLeaseLostError,
  RunStepConflictError,
  type ClaimableBinding,
  type JsonObject,
  type LeaseTransaction,
  type LockedRun,
  type RunCheckpoint,
  type RunExecutionSnapshot,
  type RunLease,
  type RunLeaseIdentity,
  type RunStep,
  type RunStepKind,
  type SweepResult,
  type ToolCallKind,
} from "./run-contracts.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RunExecutionStoreOptions {
  leaseTtlMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

interface ClaimRow {
  job_id: string;
  job_attempt: number;
  id: string;
  integration_id: string;
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

export class RunExecutionStore {
  private readonly leaseTtlMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly db: HarnessDatabase,
    options: RunExecutionStoreOptions = {},
  ) {
    this.leaseTtlMs = positiveInteger(options.leaseTtlMs ?? 60_000, "lease TTL");
    this.initialRetryMs = positiveInteger(options.initialRetryMs ?? 1_000, "initial retry delay");
    this.maxRetryMs = positiveInteger(options.maxRetryMs ?? 60_000, "maximum retry delay");
  }

  async claim(
    binding: ClaimableBinding,
    owner: string,
    runtimeVersionHash: string,
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

      const candidate = await client.query<{ job_id: string; run_id: string }>(
        `SELECT j.id AS job_id, r.id AS run_id
         FROM pr_agent_harness.job_queue j
         JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=j.tenant_id AND r.id=j.run_id
         WHERE j.tenant_id=$1 AND r.integration_id=$2
           AND r.authority_generation=$3 AND r.execution_mode_generation=$4
           AND r.runtime_version_hash=$5
           AND j.job_kind IN ('start','retry','recover')
           AND r.status IN ('queued','retry_wait')
           AND r.cancel_requested_at IS NULL AND r.deadline_at > now()
           AND j.status IN ('ready','retry_wait') AND j.available_at <= now()
         ORDER BY j.priority DESC,j.available_at,j.id
         FOR UPDATE OF j,r SKIP LOCKED LIMIT 1`,
        [binding.tenantId, binding.integrationId, binding.authorityGeneration,
          binding.executionModeGeneration, runtimeVersionHash],
      );
      const selected = candidate.rows[0];
      if (!selected) {
        await deadLetterIncompatibleRun(client, binding, runtimeVersionHash);
        return undefined;
      }

      const run = await client.query<Omit<ClaimRow, "job_id" | "job_attempt">>(
        `UPDATE pr_agent_harness.agent_runs
         SET status='running',lease_owner=$3,
             lease_expires_at=now()+($4::double precision*interval '1 millisecond'),
             lease_epoch=lease_epoch+1,execution_attempt_count=execution_attempt_count+1,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,integration_id,lease_epoch,authority_generation,
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
      }, binding.tenantId, owner);
    });
  }

  async heartbeat(lease: RunLease): Promise<RunLease> {
    return this.db.transaction(lease.tenantId, async (client) => {
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
    });
  }

  async withLease<T>(lease: RunLease, fn: LeaseTransaction<T>): Promise<T> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease, { lock: "update" });
      return fn(client);
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
    return this.withLease(lease, async (client) => {
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
        if (step.attempt_count >= maxStepAttempts) {
          throw new Error(`run step attempt limit exhausted: ${input.stepKey}`);
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
    });
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
      resultRef?: string;
      checkpoint: { schemaVersion: number; stateHash: string; state: JsonObject };
    },
  ): Promise<RunCheckpoint> {
    requiredHash(input.outputHash, "step output hash");
    requiredHash(input.checkpoint.stateHash, "checkpoint state hash");
    positiveInteger(input.checkpoint.schemaVersion, "checkpoint schema version");
    return this.withLease(lease, async (client) => {
      const selected = await client.query<StepRow>(
        `SELECT * FROM pr_agent_harness.agent_steps
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE`,
        [lease.tenantId, lease.runId, input.stepId],
      );
      const step = selected.rows[0];
      if (!step) throw new Error("run step not found");
      if (step.status === "succeeded") {
        if (step.output_hash !== input.outputHash) throw new RunStepConflictError(step.step_key);
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
      const toolCall = await client.query(
        `UPDATE pr_agent_harness.tool_calls
         SET status='succeeded',result_hash=$4,result_ref=$5,completed_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND step_attempt_id=$3 AND status='in_flight'`,
        [lease.tenantId, lease.runId, input.attemptId, input.outputHash, input.resultRef ?? null],
      );
      if (step.step_kind === "tool" && toolCall.rowCount !== 1) {
        throw new Error("tool step attempt has no in-flight tool call");
      }
      await client.query(
        `UPDATE pr_agent_harness.agent_steps
         SET status='succeeded',output_hash=$4,output_json=$5::jsonb,
             completed_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3`,
        [lease.tenantId, lease.runId, input.stepId, input.outputHash, JSON.stringify(input.output)],
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
  ): Promise<RunExecutionSnapshot> {
    return this.withLease(lease, async (client) => {
      const terminal = input.to === "succeeded" || input.to === "failed" || input.to === "cancelled";
      if (input.to === "retry_wait" && input.retryDelayMs === undefined && !input.retryAt) {
        throw new Error("retryDelayMs is required for retry_wait");
      }
      if (input.retryDelayMs !== undefined) {
        positiveInteger(input.retryDelayMs, "retry delay");
      }
      await abandonActiveStepAttempts(
        client,
        lease.tenantId,
        lease.runId,
        input.reasonCode ?? `run_${input.to}`,
      );
      const result = await client.query<{
        id: string; tenant_id: string; integration_id: string; status: RunStatus;
        version: string; lease_owner: string | null; lease_epoch: string;
        lease_expires_at: Date | null; deadline_at: Date; cancel_requested_at: Date | null;
        outcome_code: string | null; error_code: string | null;
      }>(
        `UPDATE pr_agent_harness.agent_runs
         SET status=$3,lease_owner=NULL,lease_expires_at=NULL,
             outcome_code=$4,error_code=$5,
             finished_at=CASE WHEN $6 THEN now() ELSE NULL END,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,tenant_id,integration_id,status,version,lease_owner,lease_epoch,
           lease_expires_at,deadline_at,cancel_requested_at,outcome_code,error_code`,
        [lease.tenantId, lease.runId, input.to, input.outcomeCode ?? null,
          input.reasonCode ?? null, terminal],
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

  async sweep(binding: ClaimableBinding, limit = 100): Promise<SweepResult> {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 1_000));
    return this.db.transaction(binding.tenantId, async (client) => {
      const candidates = await client.query<{
        id: string; job_id: string; lease_epoch: string; attempt_count: number;
        max_attempts: number; cancel_requested_at: Date | null; deadline_at: Date;
        deadline_expired: boolean;
      }>(
        `SELECT r.id,j.id AS job_id,r.lease_epoch,j.attempt_count,j.max_attempts,
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
      const result: SweepResult = { retried: 0, deadLettered: 0, cancelled: 0 };
      for (const row of candidates.rows) {
        if (row.cancel_requested_at) {
          await settleSweptRun(client, binding.tenantId, row, "cancelled", "cancel_requested");
          result.cancelled += 1;
        } else if (row.deadline_expired || row.attempt_count >= row.max_attempts) {
          const reason = row.deadline_expired ? "run_deadline_exceeded" : "run_attempts_exhausted";
          await settleSweptRun(client, binding.tenantId, row, "failed", reason);
          await insertDeadLetter(client, binding.tenantId, row, reason);
          result.deadLettered += 1;
        } else {
          const delay = Math.min(this.initialRetryMs * 2 ** Math.max(0, row.attempt_count - 1), this.maxRetryMs);
          await retrySweptRun(client, binding.tenantId, row, delay);
          result.retried += 1;
        }
      }
      return result;
    });
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
    return mapCheckpoint(row);
  }
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
  await client.query(
    `INSERT INTO pr_agent_harness.run_publication_batches
       (tenant_id,run_id,batch_id,step_id,lease_epoch,operation_set_hash)
     VALUES ($1,$2,$3,NULL,$4,$5)
     ON CONFLICT (tenant_id,run_id,batch_id) DO NOTHING`,
    [lease.tenantId, lease.runId, input.batchId, lease.epoch, input.operationSetHash],
  );
  await appendRunEvent(client, lease.tenantId, lease.runId, "publication.frozen", lease.owner, {
    batchId: input.batchId, operationSetHash: input.operationSetHash,
    checkpointSequence: sequence,
  });
  return mapCheckpoint(checkpoint.rows[0]!);
}

async function appendRunEvent(
  client: PoolClient,
  tenantId: string,
  runId: string,
  eventType: string,
  actorId: string,
  payload: JsonObject,
): Promise<void> {
  const sequence = await client.query<{ sequence: string }>(
    `UPDATE pr_agent_harness.agent_runs
     SET next_event_seq=next_event_seq+1
     WHERE tenant_id=$1 AND id=$2 RETURNING next_event_seq-1 AS sequence`,
    [tenantId, runId],
  );
  if (!sequence.rows[0]) throw new Error("run disappeared while allocating an event sequence");
  await client.query(
    `INSERT INTO pr_agent_harness.run_events
       (tenant_id,run_id,sequence,event_type,visibility,actor_type,actor_id,payload_json)
     VALUES ($1,$2,$3,$4,'internal','worker',$5,$6::jsonb)`,
    [tenantId, runId, sequence.rows[0].sequence, eventType, actorId, JSON.stringify(payload)],
  );
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
    tenantId, runId: row.id, integrationId: row.integration_id, jobId: row.job_id,
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

async function deadLetterIncompatibleRun(
  client: PoolClient,
  binding: ClaimableBinding,
  runtimeVersionHash: string,
): Promise<void> {
  const incompatible = await client.query<{
    id: string; job_id: string; lease_epoch: string; attempt_count: number;
  }>(
    `SELECT r.id,j.id AS job_id,r.lease_epoch,j.attempt_count
     FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
     WHERE r.tenant_id=$1 AND r.integration_id=$2
       AND r.authority_generation=$3 AND r.execution_mode_generation=$4
       AND r.runtime_version_hash<>$5
       AND j.job_kind IN ('start','retry','recover')
       AND r.status IN ('queued','retry_wait') AND j.status IN ('ready','retry_wait')
       AND j.available_at<=now()
     ORDER BY j.priority DESC,j.available_at,j.id
     FOR UPDATE OF r,j SKIP LOCKED LIMIT 1`,
    [binding.tenantId, binding.integrationId, binding.authorityGeneration,
      binding.executionModeGeneration, runtimeVersionHash],
  );
  const row = incompatible.rows[0];
  if (!row) return;
  const reason = "runtime_version_incompatible";
  await client.query(
    `UPDATE pr_agent_harness.agent_runs
     SET status='failed',error_code=$3,finished_at=now(),version=version+1,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [binding.tenantId, row.id, reason],
  );
  await client.query(
    `UPDATE pr_agent_harness.job_queue
     SET status='dead_letter',last_error_code=$3,completed_at=now(),updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [binding.tenantId, row.job_id, reason],
  );
  await insertDeadLetter(client, binding.tenantId, row, reason);
  await appendRunEvent(client, binding.tenantId, row.id, "run.failed", "run-claimer", {
    reasonCode: reason,
  });
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
         finished_at=now(),version=version+1,updated_at=now()
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
