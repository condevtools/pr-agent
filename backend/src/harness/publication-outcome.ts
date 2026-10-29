import type { PoolClient } from "pg";

import type { PublicationBinding } from "./authority.js";
import type {
  FrozenPublicationBatch,
  PublicationAdapterFactory,
  PublicationBatchCoordinator,
  PublicationBatchStore,
} from "./publication-batches.js";
import type { ModelBudgetStore } from "./model-budget-store.js";
import type { PublicationControlStore } from "./publication-control.js";
import { HarnessDatabase } from "./postgres/database.js";
import { appendRunFact } from "./run-events.js";
import type { RunLease } from "./run-contracts.js";
import type { RunExecutionStore } from "./run-execution-store.js";

export interface PublicationOutcomeTickResult {
  scheduled: number;
  observedTerminal: number;
}

export class PublicationOutcomeCoordinator {
  constructor(private readonly dependencies: {
    db: HarnessDatabase;
    batchStore: PublicationBatchStore;
  }) {}

  async tick(binding: PublicationBinding, limit = 100): Promise<PublicationOutcomeTickResult> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const candidates = await this.dependencies.db.transaction(binding.tenantId, (client) =>
      claimOutcomeScanCandidates(client, binding, bounded));
    const result: PublicationOutcomeTickResult = { scheduled: 0, observedTerminal: 0 };
    for (const candidate of candidates.rows) {
      const batch = await this.dependencies.batchStore.refreshOutcome(
        binding.tenantId,
        candidate.batch_id,
      );
      if (!batch) continue;
      const hasManual = await batchHasStatus(
        this.dependencies.batchStore,
        binding.tenantId,
        batch,
        "manual_review",
      );
      if (batch.status === "waiting_reconciliation" && !hasManual) continue;
      const outcome = await this.dependencies.db.transaction(binding.tenantId, (client) =>
        scheduleOutcomeInTransaction(client, binding, candidate.run_id, batch, hasManual));
      if (outcome === "scheduled") result.scheduled += 1;
      else if (outcome === "observed_terminal") result.observedTerminal += 1;
    }
    return result;
  }
}

export interface PublicationOutcomeHandlerDependencies {
  store: RunExecutionStore;
  budget: ModelBudgetStore;
  batchStore: PublicationBatchStore;
  batchCoordinator: PublicationBatchCoordinator;
  control: PublicationControlStore;
  createAdapter: PublicationAdapterFactory;
}

export class PublicationOutcomeHandler {
  constructor(private readonly dependencies: PublicationOutcomeHandlerDependencies) {}

  async execute(lease: RunLease): Promise<void> {
    if (lease.jobKind === "publication_outcome") {
      await this.executePublicationOutcome(lease);
      return;
    }
    if (lease.jobKind === "manual_resume") {
      await this.executeManualResume(lease);
      return;
    }
    throw new Error("publication outcome handler received an unsupported job kind");
  }

  private async executePublicationOutcome(lease: RunLease): Promise<void> {
    const batch = await this.loadExpectedBatch(lease);
    let refreshed = await this.dependencies.batchStore.refreshOutcome(lease.tenantId, batch.id);
    if (!refreshed) throw new Error("publication outcome batch disappeared");
    if (refreshed.status === "pending") {
      refreshed = await this.dependencies.batchCoordinator.execute(
        lease.tenantId,
        refreshed.id,
        this.dependencies.createAdapter,
        lease,
      );
    }
    await this.finishOutcome(lease, refreshed);
  }

  private async executeManualResume(lease: RunLease): Promise<void> {
    const waitId = requiredUuid(lease.jobPayload?.waitId, "manual wait ID");
    const commandReceiptId = requiredUuid(
      lease.jobPayload?.commandReceiptId,
      "manual command receipt ID",
    );
    const applied = await this.dependencies.store.withLease(lease, (client) =>
      this.dependencies.control.applyLeased(client, lease, { waitId, commandReceiptId }));
    const batch = await this.loadExpectedBatch(lease);
    if (applied.decision === "confirm_not_occurred") {
      await this.dependencies.store.waitForPublicationDecision(lease, {
        batchId: batch.id,
        operationSetHash: requiredHash(lease.jobPayload?.operationSetHash),
        businessOperationId: applied.receipt.businessOperationId,
        operationVersion: applied.receipt.resultingVersion,
        allowedDecisions: ["authorize_retry", "abandon_publication"],
      });
      return;
    }
    let refreshed = await this.dependencies.batchStore.refreshOutcome(lease.tenantId, batch.id);
    if (!refreshed) throw new Error("manual publication batch disappeared");
    if (applied.decision === "authorize_retry") {
      refreshed = await this.dependencies.batchCoordinator.execute(
        lease.tenantId,
        batch.id,
        this.dependencies.createAdapter,
        lease,
      );
    }
    await this.finishOutcome(lease, refreshed);
  }

  private async finishOutcome(lease: RunLease, batch: FrozenPublicationBatch): Promise<void> {
    if (batch.status === "succeeded") {
      if (lease.input.workflow !== "fix.publish.v1") await this.dependencies.budget.closeRunBudget(lease);
      await this.dependencies.store.transition(lease, {
        to: "succeeded",
        outcomeCode: "publication_completed",
      });
      return;
    }
    if (batch.status === "failed_definite") {
      if (lease.input.workflow !== "fix.publish.v1") await this.dependencies.budget.closeRunBudget(lease);
      await this.dependencies.store.transition(lease, {
        to: "failed",
        reasonCode: "publication_failed_definite",
      });
      return;
    }
    const manual = await firstOperationWithStatus(
      this.dependencies.batchStore,
      lease.tenantId,
      batch,
      "manual_review",
    );
    if (manual) {
      await this.dependencies.store.waitForPublicationDecision(lease, {
        batchId: batch.id,
        operationSetHash: requiredHash(lease.jobPayload?.operationSetHash),
        businessOperationId: manual.businessOperationId,
        operationVersion: manual.version,
        allowedDecisions: ["confirm_occurred", "confirm_not_occurred", "abandon_publication"],
      });
      return;
    }
    await this.dependencies.store.transition(lease, {
      to: "waiting_for_reconciliation",
      reasonCode: "publication_still_pending",
    });
  }

  private async loadExpectedBatch(lease: RunLease): Promise<FrozenPublicationBatch> {
    const batchId = requiredUuid(lease.jobPayload?.batchId, "publication batch ID");
    const expectedHash = requiredHash(lease.jobPayload?.operationSetHash);
    const batch = await this.dependencies.batchStore.load(lease.tenantId, batchId);
    if (!batch) throw new Error("publication outcome batch was not found");
    const actualHash = await expectedBatchHash(this.dependencies.store, lease, batchId);
    if (actualHash !== expectedHash) throw new Error("publication outcome batch hash changed");
    return batch;
  }
}

async function scheduleOutcomeInTransaction(
  client: PoolClient,
  binding: PublicationBinding,
  runId: string,
  batch: FrozenPublicationBatch,
  hasManual: boolean,
): Promise<"scheduled" | "observed_terminal" | "noop"> {
  const run = await client.query<{
    status: string; version: string; waiting_batch_id: string | null;
    waiting_operation_set_hash: string | null; publication_outcome_generation: string;
    runtime_config_json: Record<string, unknown>;
  }>(
    `SELECT status,version,waiting_batch_id,waiting_operation_set_hash,
            publication_outcome_generation,runtime_config_json
     FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND id=$2 AND integration_id=$3 FOR UPDATE`,
    [binding.tenantId, runId, binding.id],
  );
  const row = run.rows[0];
  if (!row) return "noop";
  const terminal = ["succeeded", "failed", "cancelled"].includes(row.status);
  let expectedHash = row.waiting_operation_set_hash;
  if (row.waiting_batch_id !== batch.id) {
    if (!terminal || row.waiting_batch_id !== null) return "noop";
    const linked = await client.query<{ operation_set_hash: string }>(
      `SELECT operation_set_hash FROM pr_agent_harness.run_publication_batches
       WHERE tenant_id=$1 AND run_id=$2 AND batch_id=$3`,
      [binding.tenantId, runId, batch.id],
    );
    if (linked.rowCount !== 1) return "noop";
    expectedHash = linked.rows[0]!.operation_set_hash;
  }
  const batchRow = await client.query<{ operation_set_hash: string; status: string }>(
    `SELECT operation_set_hash,status FROM pr_agent_harness.publication_batches
     WHERE tenant_id=$1 AND id=$2 AND seal_state='sealed'`,
    [binding.tenantId, batch.id],
  );
  const frozen = batchRow.rows[0];
  if (!frozen || frozen.operation_set_hash !== expectedHash) return "noop";
  if (terminal) {
    if (frozen.status !== "succeeded" && frozen.status !== "failed_definite") return "noop";
    const eventKey = `publication-outcome:${batch.id}:${frozen.status}`;
    const existing = await client.query(
      `SELECT 1 FROM pr_agent_harness.run_events
       WHERE tenant_id=$1 AND run_id=$2 AND event_key=$3`,
      [binding.tenantId, runId, eventKey],
    );
    await client.query(
      `UPDATE pr_agent_harness.agent_runs
       SET next_outcome_scan_at=clock_timestamp()+interval '1 day'
       WHERE tenant_id=$1 AND id=$2`,
      [binding.tenantId, runId],
    );
    if (existing.rowCount) return "noop";
    await appendRunFact(client, {
      tenantId: binding.tenantId,
      runId,
      eventType: "publication.outcome_observed",
      actorType: "system",
      actorId: "publication-outcome-coordinator",
      eventKey,
      payload: { batchId: batch.id, publicationStatus: frozen.status },
    });
    return "observed_terminal";
  }
  if (row.status !== "waiting_for_reconciliation") return "noop";
  if (frozen.status === "waiting_reconciliation" && !hasManual) return "noop";
  const active = await client.query(
    `SELECT 1 FROM pr_agent_harness.job_queue
     WHERE tenant_id=$1 AND run_id=$2 AND status IN ('ready','running','retry_wait') LIMIT 1`,
    [binding.tenantId, runId],
  );
  if (active.rowCount) return "noop";
  const generation = Number(row.publication_outcome_generation) + 1;
  const configuredAttempts = row.runtime_config_json.maxJobAttempts;
  const maxAttempts = typeof configuredAttempts === "number" && Number.isSafeInteger(configuredAttempts)
    && configuredAttempts > 0 ? configuredAttempts : 3;
  await client.query(
    `UPDATE pr_agent_harness.agent_runs
     SET publication_outcome_generation=$3,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [binding.tenantId, runId, generation],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pr_agent_harness.job_queue
       (tenant_id,run_id,job_kind,expected_run_version,expected_batch_id,
        expected_operation_set_hash,outcome_generation,job_payload_json,max_attempts)
     VALUES ($1,$2,'publication_outcome',$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT DO NOTHING RETURNING id`,
    [binding.tenantId, runId, Number(row.version), batch.id, frozen.operation_set_hash,
      generation, JSON.stringify({ batchStatus: frozen.status, hasManual }), maxAttempts],
  );
  if (!inserted.rows[0]) return "noop";
  await appendRunFact(client, {
    tenantId: binding.tenantId,
    runId,
    eventType: "publication.outcome_ready",
    actorType: "system",
    actorId: "publication-outcome-coordinator",
    eventKey: `publication-outcome-job:${generation}:${frozen.operation_set_hash}`,
    payload: { batchId: batch.id, publicationStatus: frozen.status, outcomeGeneration: generation },
  });
  return "scheduled";
}

async function claimOutcomeScanCandidates(
  client: PoolClient,
  binding: PublicationBinding,
  limit: number,
): Promise<{ rows: { run_id: string; batch_id: string }[] }> {
  const claimed = await client.query<{ run_id: string; waiting_batch_id: string | null }>(
    `WITH due AS (
       SELECT r.id
       FROM pr_agent_harness.agent_runs r
       WHERE r.tenant_id=$1 AND r.integration_id=$2
         AND r.authority_generation=$3 AND r.execution_mode_generation=$4
         AND r.status IN ('waiting_for_reconciliation','succeeded','failed','cancelled')
         AND r.next_outcome_scan_at<=clock_timestamp()
         AND (r.waiting_batch_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
           WHERE rpb.tenant_id=r.tenant_id AND rpb.run_id=r.id
         ))
       ORDER BY r.next_outcome_scan_at,r.id
       FOR UPDATE OF r SKIP LOCKED LIMIT $5
     )
     UPDATE pr_agent_harness.agent_runs r
     SET next_outcome_scan_at=clock_timestamp()+interval '5 seconds'
     FROM due WHERE r.tenant_id=$1 AND r.id=due.id
     RETURNING r.id AS run_id,r.waiting_batch_id`,
    [binding.tenantId, binding.id, binding.generation,
      binding.executionModeGeneration ?? 0, limit],
  );
  const rows: { run_id: string; batch_id: string }[] = [];
  for (const candidate of claimed.rows) {
    if (candidate.waiting_batch_id) {
      rows.push({ run_id: candidate.run_id, batch_id: candidate.waiting_batch_id });
      continue;
    }
    const linked = await client.query<{ batch_id: string }>(
      `SELECT batch_id FROM pr_agent_harness.run_publication_batches
       WHERE tenant_id=$1 AND run_id=$2 ORDER BY batch_id LIMIT 2`,
      [binding.tenantId, candidate.run_id],
    );
    if (linked.rowCount === 1) {
      rows.push({ run_id: candidate.run_id, batch_id: linked.rows[0]!.batch_id });
    }
  }
  return { rows };
}

async function batchHasStatus(
  store: PublicationBatchStore,
  tenantId: string,
  batch: FrozenPublicationBatch,
  status: string,
): Promise<boolean> {
  return Boolean(await firstOperationWithStatus(store, tenantId, batch, status));
}

async function firstOperationWithStatus(
  store: PublicationBatchStore,
  tenantId: string,
  batch: FrozenPublicationBatch,
  status: string,
) {
  for (const frozen of batch.operations) {
    const operation = await store.loadOperation(tenantId, frozen.businessOperationId);
    if (!operation) throw new Error("publication batch references a missing operation");
    if (operation.status === status) return operation;
  }
  return undefined;
}

async function expectedBatchHash(
  store: RunExecutionStore,
  lease: RunLease,
  batchId: string,
): Promise<string> {
  return store.withLease(lease, async (client) => {
    const result = await client.query<{ operation_set_hash: string }>(
      `SELECT operation_set_hash FROM pr_agent_harness.run_publication_batches
       WHERE tenant_id=$1 AND run_id=$2 AND batch_id=$3`,
      [lease.tenantId, lease.runId, batchId],
    );
    if (!result.rows[0]) throw new Error("Run is not linked to the publication batch");
    return result.rows[0].operation_set_hash;
  });
}

function requiredHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("publication operation-set hash is required");
  }
  return value;
}

function requiredUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}
