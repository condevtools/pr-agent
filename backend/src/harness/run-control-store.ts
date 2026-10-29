import type { PoolClient } from "pg";

import { HarnessDatabase } from "./postgres/database.js";
import { appendRunFact } from "./run-events.js";
import {
  createRunInTransaction,
  type CreateRunInput,
  type RunStatus,
} from "./postgres/run-store.js";
import {
  requireRunPermission,
  runCommandSchema,
  runConflict,
  runNotFound,
  type RunCommand,
  type RunCommandReceipt,
  type RunPermission,
  type RunPrincipal,
} from "./run-control-contracts.js";
import { fingerprint } from "./versions.js";

interface LockedRunRow {
  id: string;
  integration_id: string;
  status: RunStatus;
  version: string;
  create_scope: string;
  create_key: string;
  lease_expires_at: Date | null;
  deadline_at: Date;
  deadline_expired: boolean;
  runtime_config_json: Record<string, unknown>;
  authority_generation: string;
  execution_mode_generation: string;
  execution_attempt_count: number;
}

interface ReceiptRow {
  id: string;
  run_id: string;
  command_key: string;
  command_kind: RunCommand["kind"];
  request_hash: string;
  status: RunCommandReceipt["status"];
  result_json: Record<string, unknown>;
  created_at: Date;
}

const PERMISSION_BY_COMMAND: Record<RunCommand["kind"], RunPermission> = {
  cancel: "runs:cancel",
  resume: "runs:resume",
  retry: "runs:retry",
  recover: "runs:recover",
  rerun: "runs:rerun",
};

export class RunControlStore {
  constructor(private readonly db: HarnessDatabase) {}

  async apply(
    principal: RunPrincipal,
    runId: string,
    suppliedCommand: RunCommand,
    rerun?: CreateRunInput,
  ): Promise<RunCommandReceipt> {
    const command = runCommandSchema.parse(suppliedCommand);
    requireRunPermission(principal, PERMISSION_BY_COMMAND[command.kind]);
    if (!principal.subjectId.trim()) throw runConflict("Run principal subject is required");
    const requestHash = commandRequestHash(command);

    return this.db.transaction(principal.tenantId, async (client) => {
      await authorizeBinding(client, principal);
      const run = await lockRun(client, principal, runId);
      const duplicate = await findReceipt(client, principal.tenantId, runId, command.commandKey);
      if (duplicate) {
        if (duplicate.request_hash !== requestHash || duplicate.command_kind !== command.kind) {
          throw runConflict("Run command key was reused with a different request");
        }
        return mapReceipt(duplicate);
      }
      if (Number(run.version) !== command.expectedVersion) {
        throw runConflict("Run version changed before the command was applied");
      }

      const receipt = await insertReceipt(client, principal, run, command, requestHash);
      switch (command.kind) {
        case "cancel":
          return this.cancel(client, principal, run, command, receipt);
        case "retry":
          return this.retry(client, principal, run, command, receipt);
        case "recover":
          return this.recover(client, principal, run, command, receipt);
        case "rerun":
          return this.rerun(client, principal, run, command, receipt, rerun);
        case "resume":
          return this.resume(client, principal, run, command, receipt);
      }
    });
  }

  async lookupReceipt(
    principal: RunPrincipal,
    runId: string,
    suppliedCommand: RunCommand,
  ): Promise<RunCommandReceipt | undefined> {
    const command = runCommandSchema.parse(suppliedCommand);
    requireRunPermission(principal, PERMISSION_BY_COMMAND[command.kind]);
    if (!principal.subjectId.trim()) throw runConflict("Run principal subject is required");
    const requestHash = commandRequestHash(command);

    return this.db.transaction(principal.tenantId, async (client) => {
      await authorizeBinding(client, principal);
      await assertRunScope(client, principal, runId);
      const receipt = await findReceipt(client, principal.tenantId, runId, command.commandKey);
      if (!receipt) return undefined;
      if (receipt.request_hash !== requestHash || receipt.command_kind !== command.kind) {
        throw runConflict("Run command key was reused with a different request");
      }
      return mapReceipt(receipt);
    });
  }

  private async cancel(
    client: PoolClient,
    principal: RunPrincipal,
    run: LockedRunRow,
    command: Extract<RunCommand, { kind: "cancel" }>,
    receipt: ReceiptRow,
  ): Promise<RunCommandReceipt> {
    if (isTerminal(run.status)) throw runConflict("Terminal Runs cannot be cancelled");
    const immediate = run.status !== "running";
    const updated = await client.query<{ version: string; status: RunStatus }>(
      immediate
        ? `UPDATE pr_agent_harness.agent_runs
           SET status='cancelled',cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
               lease_owner=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),
               error_code='cancelled_by_command',version=version+1,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2 RETURNING version,status`
        : `UPDATE pr_agent_harness.agent_runs
           SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
               version=version+1,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2 RETURNING version,status`,
      [principal.tenantId, run.id],
    );
    const version = Number(updated.rows[0]!.version);
    await client.query(
      `UPDATE pr_agent_harness.job_queue
       SET status='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp(),
           last_error_code='cancelled_by_command'
       WHERE tenant_id=$1 AND run_id=$2 AND status IN ('ready','retry_wait')`,
      [principal.tenantId, run.id],
    );
    await client.query(
      "SELECT pr_agent_harness.skip_cancelled_run_publications($1::uuid,$2::uuid)",
      [principal.tenantId, run.id],
    );
    await appendCommandEvent(client, principal, run.id, receipt.id, "run.cancel_requested", {
      immediate,
      commandKey: command.commandKey,
    });
    return finishReceipt(client, receipt, immediate ? "completed" : "accepted", version, {
      status: updated.rows[0]!.status,
      cancellationPending: !immediate,
    });
  }

  private async retry(
    client: PoolClient,
    principal: RunPrincipal,
    run: LockedRunRow,
    command: Extract<RunCommand, { kind: "retry" }>,
    receipt: ReceiptRow,
  ): Promise<RunCommandReceipt> {
    if (run.status !== "retry_wait") throw runConflict("Only retry_wait Runs can be retried");
    if (run.deadline_expired) throw runConflict("Expired Run deadline cannot be retried");
    await assertReviewExecutionAuthority(client, principal, run, "active");
    await assertNoUnresolvedPublication(client, principal.tenantId, run.id);
    const job = await client.query<{ id: string }>(
      `UPDATE pr_agent_harness.job_queue
       SET status='ready',job_kind='retry',available_at=clock_timestamp(),
           dispatch_generation=dispatch_generation+1,claimed_run_epoch=NULL,
           completed_at=NULL,last_error_code=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND run_id=$2 AND status='retry_wait'
       RETURNING id`,
      [principal.tenantId, run.id],
    );
    if (!job.rows[0]) throw runConflict("Retry Run has no matching retry_wait Job");
    const updated = await client.query<{ version: string }>(
      `UPDATE pr_agent_harness.agent_runs
       SET status='queued',error_code=NULL,version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 RETURNING version`,
      [principal.tenantId, run.id],
    );
    const version = Number(updated.rows[0]!.version);
    await appendCommandEvent(client, principal, run.id, receipt.id, "run.retry_requested", {
      commandKey: command.commandKey,
      jobId: job.rows[0].id,
    });
    return finishReceipt(client, receipt, "completed", version, {
      status: "queued",
      jobId: job.rows[0].id,
    }, job.rows[0].id);
  }

  private async recover(
    client: PoolClient,
    principal: RunPrincipal,
    run: LockedRunRow,
    command: Extract<RunCommand, { kind: "recover" }>,
    receipt: ReceiptRow,
  ): Promise<RunCommandReceipt> {
    if (isTerminal(run.status)) throw runConflict("Terminal Runs cannot be recovered");
    if (run.deadline_expired) throw runConflict("Expired Run deadline cannot be recovered");
    await assertReviewExecutionAuthority(client, principal, run, "active");
    await assertNoUnresolvedPublication(client, principal.tenantId, run.id);
    const deadLetter = await client.query(
      `SELECT 1 FROM pr_agent_harness.job_queue
       WHERE tenant_id=$1 AND run_id=$2 AND status='dead_letter' LIMIT 1`,
      [principal.tenantId, run.id],
    );
    if (deadLetter.rowCount) throw runConflict("Dead-lettered Runs require explicit rerun");

    const active = await client.query<{
      id: string;
      status: string;
      lease_live: boolean;
      attempt_count: number;
      max_attempts: number;
    }>(
      `SELECT j.id,j.status,j.attempt_count,j.max_attempts,
              (r.status='running' AND r.lease_expires_at>clock_timestamp()) AS lease_live
       FROM pr_agent_harness.agent_runs r
       JOIN pr_agent_harness.job_queue j ON j.tenant_id=r.tenant_id AND j.run_id=r.id
       WHERE r.tenant_id=$1 AND r.id=$2
         AND j.status IN ('ready','running','retry_wait')
       ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j`,
      [principal.tenantId, run.id],
    );
    if (active.rows[0]?.lease_live) throw runConflict("A live Run lease cannot be recovered");
    if (active.rows[0] && active.rows[0].attempt_count >= active.rows[0].max_attempts) {
      throw runConflict("Run Job attempt limit is exhausted; rerun is required");
    }
    const expiredLease = run.status === "running"
      && run.lease_expires_at !== null
      && active.rows[0]?.status === "running";
    const orphan = (run.status === "queued" || run.status === "retry_wait") && !active.rows[0];
    if (!expiredLease && !orphan) throw runConflict("Run is not an expired lease or orphan");

    let jobId: string;
    if (active.rows[0]) {
      const job = await client.query<{ id: string }>(
        `UPDATE pr_agent_harness.job_queue
         SET job_kind='recover',status='ready',available_at=clock_timestamp(),
             dispatch_generation=dispatch_generation+1,claimed_run_epoch=NULL,
             completed_at=NULL,last_error_code=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 RETURNING id`,
        [principal.tenantId, run.id, active.rows[0].id],
      );
      jobId = job.rows[0]!.id;
    } else {
      const maxAttempts = recoverMaxAttempts(run.runtime_config_json);
      if (run.execution_attempt_count >= maxAttempts) {
        throw runConflict("Run execution attempt limit is exhausted; rerun is required");
      }
      const job = await client.query<{ id: string }>(
        `INSERT INTO pr_agent_harness.job_queue
           (tenant_id,run_id,job_kind,status,attempt_count,max_attempts)
         VALUES ($1,$2,'recover','ready',$3,$4) RETURNING id`,
        [principal.tenantId, run.id, run.execution_attempt_count, maxAttempts],
      );
      jobId = job.rows[0]!.id;
    }
    const updated = await client.query<{ version: string }>(
      `UPDATE pr_agent_harness.agent_runs
       SET status='queued',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,
           version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 RETURNING version`,
      [principal.tenantId, run.id],
    );
    const version = Number(updated.rows[0]!.version);
    await appendCommandEvent(client, principal, run.id, receipt.id, "run.recovery_requested", {
      commandKey: command.commandKey,
      jobId,
    });
    return finishReceipt(client, receipt, "completed", version, {
      status: "queued",
      jobId,
    }, jobId);
  }

  private async rerun(
    client: PoolClient,
    principal: RunPrincipal,
    run: LockedRunRow,
    command: Extract<RunCommand, { kind: "rerun" }>,
    receipt: ReceiptRow,
    supplied?: CreateRunInput,
  ): Promise<RunCommandReceipt> {
    if (!supplied) throw runConflict("Rerun creation input is required");
    if (supplied.createScope === run.create_scope && supplied.createKey === run.create_key) {
      throw runConflict("Rerun must use a fresh creation identity");
    }
    const rerunInput: CreateRunInput = {
      ...supplied,
      tenantId: principal.tenantId,
      integrationId: principal.integrationId,
      actorType: principal.actorType,
      actorId: principal.subjectId,
      parentRunId: run.id,
    };
    const created = await createRunInTransaction(client, rerunInput);
    if (!created.created || created.id === run.id) {
      throw runConflict("Rerun creation identity already exists");
    }
    await appendCommandEvent(client, principal, run.id, receipt.id, "run.rerun_created", {
      commandKey: command.commandKey,
      newRunId: created.id,
      newJobId: created.jobId,
    });
    return finishReceipt(client, receipt, "completed", Number(run.version), {
      newRunId: created.id,
      newJobId: created.jobId,
    }, undefined, created.id);
  }

  private async resume(
    client: PoolClient,
    principal: RunPrincipal,
    run: LockedRunRow,
    command: Extract<RunCommand, { kind: "resume" }>,
    receipt: ReceiptRow,
  ): Promise<RunCommandReceipt> {
    if (run.status !== "waiting_for_user" && run.status !== "waiting_for_reconciliation") {
      throw runConflict("Run is not waiting for an external decision");
    }
    if (run.deadline_expired) throw runConflict("Expired Run deadline cannot be resumed");
    await assertReviewExecutionAuthority(client, principal, run, "resumable");
    const decision = command.decision;
    const remoteId = "remoteId" in decision ? decision.remoteId : null;
    const wait = await client.query<{
      id: string;
      version: string;
      intent_hash: string;
      operation_version: string;
      allowed_decisions: unknown;
      batch_id: string;
      operation_set_hash: string;
      business_operation_id: string;
    }>(
      `SELECT id,version,intent_hash,operation_version,allowed_decisions,
              batch_id,operation_set_hash,business_operation_id
       FROM pr_agent_harness.run_waits
       WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='open'
       FOR UPDATE`,
      [principal.tenantId, run.id, decision.waitId],
    );
    const pending = wait.rows[0];
    if (!pending
        || Number(pending.version) !== decision.waitVersion
        || pending.intent_hash !== decision.intentHash
        || Number(pending.operation_version) !== decision.operationVersion) {
      throw runConflict("Run wait identity or version changed");
    }
    const allowed = Array.isArray(pending.allowed_decisions) ? pending.allowed_decisions : [];
    if (!allowed.includes(decision.decision)) throw runConflict("Decision is not allowed for this wait");
    const operation = await client.query<{ version: string }>(
      `SELECT version FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=$2
       FOR UPDATE`,
      [principal.tenantId, pending.business_operation_id],
    );
    if (Number(operation.rows[0]?.version) !== decision.operationVersion) {
      throw runConflict("Publication operation changed before the decision was consumed");
    }
    await client.query(
      `UPDATE pr_agent_harness.run_waits
       SET status='consumed',consumed_at=clock_timestamp(),version=version+1
       WHERE tenant_id=$1 AND run_id=$2 AND id=$3`,
      [principal.tenantId, run.id, pending.id],
    );
    await client.query(
      `INSERT INTO pr_agent_harness.run_wait_decisions
         (tenant_id,run_id,wait_id,command_receipt_id,decision,evidence_json,remote_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [principal.tenantId, run.id, pending.id, receipt.id, decision.decision,
        JSON.stringify(decision.evidence), remoteId],
    );
    const updated = await client.query<{ version: string }>(
      `UPDATE pr_agent_harness.agent_runs
       SET publication_outcome_generation=publication_outcome_generation+1,
           version=version+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 RETURNING version`,
      [principal.tenantId, run.id],
    );
    const version = Number(updated.rows[0]!.version);
    const job = await client.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.job_queue
         (tenant_id,run_id,job_kind,status,expected_run_version,expected_batch_id,
          expected_operation_set_hash,command_receipt_id,wait_id,wait_version,job_payload_json,
          max_attempts)
       VALUES ($1,$2,'manual_resume','ready',$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id`,
      [principal.tenantId, run.id, version, pending.batch_id, pending.operation_set_hash,
        receipt.id, pending.id, decision.waitVersion,
        JSON.stringify({ decision: decision.decision, evidence: decision.evidence,
          remoteId }), recoverMaxAttempts(run.runtime_config_json)],
    );
    await appendCommandEvent(client, principal, run.id, receipt.id, "run.resume_requested", {
      commandKey: command.commandKey,
      waitId: pending.id,
      decision: decision.decision,
      jobId: job.rows[0]!.id,
    });
    return finishReceipt(client, receipt, "accepted", version, {
      status: run.status,
      waitId: pending.id,
      jobId: job.rows[0]!.id,
    }, job.rows[0]!.id);
  }
}

async function authorizeBinding(client: PoolClient, principal: RunPrincipal): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM pr_agent_harness.integration_bindings
     WHERE tenant_id=$1 AND id=$2 AND active`,
    [principal.tenantId, principal.integrationId],
  );
  if (result.rowCount !== 1) throw runNotFound();
}

async function lockRun(
  client: PoolClient,
  principal: RunPrincipal,
  runId: string,
): Promise<LockedRunRow> {
  const result = await client.query<LockedRunRow>(
    `SELECT id,integration_id,status,version,create_scope,create_key,
            lease_expires_at,deadline_at,runtime_config_json,
            authority_generation,execution_mode_generation,execution_attempt_count,
            (deadline_at<=clock_timestamp()) AS deadline_expired
     FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
    [principal.tenantId, principal.integrationId, runId],
  );
  if (!result.rows[0]) throw runNotFound();
  return result.rows[0];
}

async function assertReviewExecutionAuthority(
  client: PoolClient,
  principal: RunPrincipal,
  run: LockedRunRow,
  mode: "active" | "resumable",
): Promise<void> {
  const functionName = mode === "active"
    ? "lock_active_review_execution_authority"
    : "lock_resumable_review_execution_authority";
  const result = await client.query<{ allowed: boolean }>(
    `SELECT pr_agent_harness.${functionName}(
       $1::uuid,$2::uuid,$3::bigint,$4::bigint
     ) AS allowed`,
    [principal.tenantId, principal.integrationId, run.authority_generation,
      run.execution_mode_generation],
  );
  if (!result.rows[0]?.allowed) {
    throw runConflict("Run execution authority no longer matches the frozen Run");
  }
}

async function assertRunScope(
  client: PoolClient,
  principal: RunPrincipal,
  runId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
    [principal.tenantId, principal.integrationId, runId],
  );
  if (result.rowCount !== 1) throw runNotFound();
}

async function findReceipt(
  client: PoolClient,
  tenantId: string,
  runId: string,
  commandKey: string,
): Promise<ReceiptRow | undefined> {
  const result = await client.query<ReceiptRow>(
    `SELECT id,run_id,command_key,command_kind,request_hash,status,result_json,created_at
     FROM pr_agent_harness.run_command_receipts
     WHERE tenant_id=$1 AND run_id=$2 AND command_key=$3`,
    [tenantId, runId, commandKey],
  );
  return result.rows[0];
}

async function insertReceipt(
  client: PoolClient,
  principal: RunPrincipal,
  run: LockedRunRow,
  command: RunCommand,
  requestHash: string,
): Promise<ReceiptRow> {
  const result = await client.query<ReceiptRow>(
    `INSERT INTO pr_agent_harness.run_command_receipts
       (tenant_id,integration_id,run_id,command_kind,command_key,request_hash,
        actor_type,actor_id,request_json,accepted_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     RETURNING id,run_id,command_key,command_kind,request_hash,status,result_json,created_at`,
    [principal.tenantId, principal.integrationId, run.id, command.kind, command.commandKey,
      requestHash, principal.actorType, principal.subjectId, JSON.stringify(command), Number(run.version)],
  );
  return result.rows[0]!;
}

async function finishReceipt(
  client: PoolClient,
  receipt: ReceiptRow,
  status: RunCommandReceipt["status"],
  resultingVersion: number,
  result: Record<string, unknown>,
  jobId?: string,
  newRunId?: string,
): Promise<RunCommandReceipt> {
  const updated = await client.query<ReceiptRow>(
    `UPDATE pr_agent_harness.run_command_receipts
     SET status=$4,result_json=$5::jsonb,resulting_version=$6,
         job_id=$7,new_run_id=$8,updated_at=clock_timestamp()
     WHERE tenant_id=current_setting('app.tenant_id')::uuid AND run_id=$1 AND id=$2
       AND command_key=$3
     RETURNING id,run_id,command_key,command_kind,request_hash,status,result_json,created_at`,
    [receipt.run_id, receipt.id, receipt.command_key, status, JSON.stringify(result),
      resultingVersion, jobId ?? null, newRunId ?? null],
  );
  return mapReceipt(updated.rows[0]!);
}

async function appendCommandEvent(
  client: PoolClient,
  principal: RunPrincipal,
  runId: string,
  receiptId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendRunFact(client, {
    tenantId: principal.tenantId,
    runId,
    eventType,
    eventKey: `run-command:${receiptId}`,
    visibility: "internal",
    actorType: principal.actorType,
    actorId: principal.subjectId,
    payload,
  });
}

async function assertNoUnresolvedPublication(
  client: PoolClient,
  tenantId: string,
  runId: string,
): Promise<void> {
  const unresolved = await client.query(
    `SELECT 1
     FROM pr_agent_harness.run_publication_batches rpb
     JOIN pr_agent_harness.publication_batch_operations pbo
       ON pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id
     JOIN pr_agent_harness.repository_operations ro
       ON ro.tenant_id=pbo.tenant_id AND ro.business_operation_id=pbo.business_operation_id
     WHERE rpb.tenant_id=$1 AND rpb.run_id=$2 AND pbo.action_state='active'
       AND ro.status IN ('in_flight','unknown','manual_review')
     LIMIT 1`,
    [tenantId, runId],
  );
  if (unresolved.rowCount) throw runConflict("Run has an unresolved publication outcome");
}

function commandRequestHash(command: RunCommand): string {
  return fingerprint(command);
}

function mapReceipt(row: ReceiptRow): RunCommandReceipt {
  return {
    id: row.id,
    runId: row.run_id,
    commandKey: row.command_key,
    kind: row.command_kind,
    status: row.status,
    result: row.result_json,
    createdAt: row.created_at.toISOString(),
  };
}

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function recoverMaxAttempts(runtimeConfig: Record<string, unknown>): number {
  const value = runtimeConfig.maxJobAttempts;
  if (value === undefined) return 3;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw runConflict("Run maxJobAttempts must be a positive integer");
  }
  return value;
}
