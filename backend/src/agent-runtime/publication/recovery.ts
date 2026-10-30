import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../postgres/database.js";
import type { PublicationBinding, PublicationAuthorityStore } from "../authority/publication-authority.js";
import type {
  FrozenPublicationBatch,
  PublicationBatchCoordinator,
  PublicationBatchStore,
} from "./batches.js";
import type {
  PublicationAdapter,
  PublicationOperation,
  PublicationService,
} from "./publication.js";

export interface PublicationRecoveryClaim {
  tenantId: string;
  integrationId: string;
  businessOperationId: string;
  claimOwner: string;
  claimVersion: number;
  operationVersion: number;
}

export interface PublicationRecoveryDependencies {
  listBindings(): Promise<PublicationBinding[]>;
  listBatches(
    binding: PublicationBinding,
    limit: number,
    signal?: AbortSignal,
  ): Promise<FrozenPublicationBatch[]>;
  executeBatch(
    binding: PublicationBinding,
    batch: FrozenPublicationBatch,
    signal?: AbortSignal,
  ): Promise<boolean | void>;
  refreshBatch(binding: PublicationBinding, batch: FrozenPublicationBatch): Promise<FrozenPublicationBatch | undefined>;
  claimOperations(
    binding: PublicationBinding,
    owner: string,
    limit: number,
  ): Promise<PublicationRecoveryClaim[]>;
  reconcileOperation(binding: PublicationBinding, claim: PublicationRecoveryClaim): Promise<void>;
  finishOperation(claim: PublicationRecoveryClaim): Promise<"resolved" | "scheduled" | "manual_review" | "lost">;
  onError(error: unknown, context: PublicationRecoveryErrorContext): void;
}

export interface PublicationRecoveryErrorContext {
  phase: "tick" | "batch_execute" | "batch_refresh" | "operation_reconcile" | "operation_finish";
  tenantId?: string;
  integrationId?: string;
  resourceId?: string;
}

export interface PublicationRecoveryOptions {
  owner?: string;
  intervalMs?: number;
  batchLimit?: number;
  operationLimit?: number;
}

export interface PublicationRecoveryTickResult {
  skipped: boolean;
  bindings: number;
  batchesExecuted: number;
  operationsClaimed: number;
  operationsManualReview: number;
  errors: number;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 100;

export class PublicationRecoveryLoop {
  private readonly owner: string;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly operationLimit: number;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<PublicationRecoveryTickResult> | undefined;
  private readonly stopController = new AbortController();
  private stopped = false;

  constructor(
    private readonly dependencies: PublicationRecoveryDependencies,
    options: PublicationRecoveryOptions = {},
  ) {
    this.owner = requiredOwner(options.owner ?? `recovery-${randomUUID()}`);
    this.intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "recovery interval");
    this.batchLimit = boundedLimit(options.batchLimit ?? DEFAULT_LIMIT, "batch recovery limit");
    this.operationLimit = boundedLimit(
      options.operationLimit ?? DEFAULT_LIMIT,
      "operation recovery limit",
    );
  }

  async tick(): Promise<PublicationRecoveryTickResult> {
    if (this.activeTick || this.stopped) return emptyResult(true);
    const running = this.runTick();
    this.activeTick = running;
    try {
      return await running;
    } finally {
      if (this.activeTick === running) this.activeTick = undefined;
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const poll = () => {
      void this.tick().catch((error: unknown) => {
        this.dependencies.onError(error, { phase: "tick" });
      });
    };
    poll();
    this.timer = setInterval(poll, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController.abort(new Error("Publication recovery stopped"));
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  private async runTick(): Promise<PublicationRecoveryTickResult> {
    const result = emptyResult(false);
    const bindings = await this.dependencies.listBindings();
    if (this.stopped) return result;
    result.bindings = bindings.length;
    for (const binding of bindings) {
      if (this.stopped) break;
      const executedBatchIds = new Set<string>();
      const initial = await this.dependencies.listBatches(
        binding,
        this.batchLimit,
        this.stopController.signal,
      );
      for (const batch of initial) {
        if (this.stopped) break;
        if (batch.status !== "pending") continue;
        if (await this.executeBatch(binding, batch, result)) executedBatchIds.add(batch.id);
      }

      if (this.stopped) break;
      const claims = await this.dependencies.claimOperations(
        binding,
        this.owner,
        this.operationLimit,
      );
      result.operationsClaimed += claims.length;
      for (const claim of claims) {
        try {
          await this.dependencies.reconcileOperation(binding, claim);
        } catch (error) {
          result.errors += 1;
          this.dependencies.onError(error, operationContext("operation_reconcile", claim));
        }
        try {
          const outcome = await this.dependencies.finishOperation(claim);
          if (outcome === "manual_review") result.operationsManualReview += 1;
        } catch (error) {
          result.errors += 1;
          this.dependencies.onError(error, operationContext("operation_finish", claim));
        }
      }

      if (this.stopped) break;
      const afterReconciliation = await this.dependencies.listBatches(
        binding,
        this.batchLimit,
        this.stopController.signal,
      );
      for (const batch of afterReconciliation) {
        if (this.stopped) break;
        if (batch.status !== "waiting_reconciliation") continue;
        let refreshed: FrozenPublicationBatch | undefined;
        try {
          refreshed = await this.dependencies.refreshBatch(binding, batch);
        } catch (error) {
          result.errors += 1;
          this.dependencies.onError(error, batchContext("batch_refresh", binding, batch));
          continue;
        }
        if (refreshed?.status === "pending" && !executedBatchIds.has(refreshed.id)) {
          if (await this.executeBatch(binding, refreshed, result)) {
            executedBatchIds.add(refreshed.id);
          }
        }
      }
    }
    return result;
  }

  private async executeBatch(
    binding: PublicationBinding,
    batch: FrozenPublicationBatch,
    result: PublicationRecoveryTickResult,
  ): Promise<boolean> {
    if (this.stopped) return false;
    try {
      const executed = await this.dependencies.executeBatch(
        binding,
        batch,
        this.stopController.signal,
      );
      if (executed === false) return false;
      result.batchesExecuted += 1;
      return true;
    } catch (error) {
      result.errors += 1;
      this.dependencies.onError(error, batchContext("batch_execute", binding, batch));
      return false;
    }
  }
}

export interface PgPublicationRecoveryScheduleOptions {
  claimTtlMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class PgPublicationRecoverySchedule {
  private readonly claimTtlMs: number;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly db: RuntimeDatabase,
    options: PgPublicationRecoveryScheduleOptions = {},
  ) {
    this.claimTtlMs = positiveInteger(options.claimTtlMs ?? 30_000, "recovery claim TTL");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "maximum reconciliation attempts");
    this.initialBackoffMs = positiveInteger(
      options.initialBackoffMs ?? 1_000,
      "initial reconciliation backoff",
    );
    this.maxBackoffMs = positiveInteger(
      options.maxBackoffMs ?? 50_000,
      "maximum reconciliation backoff",
    );
  }

  async claim(
    binding: PublicationBinding,
    owner: string,
    limit: number,
  ): Promise<PublicationRecoveryClaim[]> {
    const claimOwner = requiredOwner(owner);
    const bounded = boundedLimit(limit, "operation recovery limit");
    return this.db.transaction(binding.tenantId, async (client) => {
      await exhaustExpiredRecoveryClaims(
        client,
        binding,
        this.maxAttempts,
        "reconcile",
        undefined,
        bounded,
      );
      const result = await client.query<{
        business_operation_id: string;
        reconcile_claim_version: string;
        version: string;
      }>(
        `
          WITH due AS (
            SELECT ro.business_operation_id
            FROM pr_agent_harness.repository_operations ro
            WHERE ro.tenant_id = $1 AND ro.integration_id = $2
              AND ro.authority_generation = $3
              AND ro.status IN ('in_flight', 'unknown')
              AND ro.reconcile_attempt_count < $7
              AND (ro.next_reconcile_at IS NULL OR ro.next_reconcile_at <= now())
              AND (ro.reconcile_claim_expires_at IS NULL OR ro.reconcile_claim_expires_at <= now())
              AND (
                ro.status <> 'in_flight'
                OR NOT EXISTS (
                  SELECT 1
                  FROM pr_agent_harness.publication_batch_operations pbo
                  JOIN pr_agent_harness.run_publication_batches rpb
                    ON rpb.tenant_id=pbo.tenant_id AND rpb.batch_id=pbo.batch_id
                  JOIN pr_agent_harness.agent_runs r
                    ON r.tenant_id=rpb.tenant_id AND r.id=rpb.run_id
                  WHERE pbo.tenant_id=ro.tenant_id
                    AND pbo.business_operation_id=ro.business_operation_id
                    AND r.status='running' AND r.lease_expires_at > now()
                )
              )
            ORDER BY COALESCE(ro.next_reconcile_at, '-infinity'::timestamptz),
                     ro.updated_at, ro.business_operation_id
            FOR UPDATE SKIP LOCKED
            LIMIT $4
          )
          UPDATE pr_agent_harness.repository_operations ro
          SET reconcile_claim_owner = $5,
              reconcile_claim_version = reconcile_claim_version + 1,
              reconcile_attempt_count = reconcile_attempt_count + 1,
              version = version + 1,
              reconcile_claim_expires_at = now() + ($6::double precision * interval '1 millisecond'),
              updated_at = now()
          FROM due
          WHERE ro.tenant_id = $1
            AND ro.business_operation_id = due.business_operation_id
          RETURNING ro.business_operation_id, ro.reconcile_claim_version, ro.version
        `,
        [
          binding.tenantId,
          binding.id,
          binding.generation,
          bounded,
          claimOwner,
          this.claimTtlMs,
          this.maxAttempts,
        ],
      );
      return result.rows.map((row) => ({
        tenantId: binding.tenantId,
        integrationId: binding.id,
        businessOperationId: row.business_operation_id,
        claimOwner,
        claimVersion: Number(row.reconcile_claim_version),
        operationVersion: Number(row.version),
      }));
    });
  }

  async finish(
    claim: PublicationRecoveryClaim,
  ): Promise<"resolved" | "scheduled" | "manual_review" | "lost"> {
    return this.db.transaction(claim.tenantId, async (client) => {
      const selected = await client.query<{
        status: PublicationOperation["status"];
        reconcile_attempt_count: number;
      }>(
        `
          SELECT status, reconcile_attempt_count
          FROM pr_agent_harness.repository_operations
          WHERE tenant_id = $1 AND integration_id = $2 AND business_operation_id = $3
            AND reconcile_claim_owner = $4 AND reconcile_claim_version = $5
            AND reconcile_claim_expires_at > now()
          FOR UPDATE
        `,
        [
          claim.tenantId,
          claim.integrationId,
          claim.businessOperationId,
          claim.claimOwner,
          claim.claimVersion,
        ],
      );
      const row = selected.rows[0];
      if (!row) return "lost";
      if (row.status !== "in_flight" && row.status !== "unknown") {
        await clearRecoveryClaim(client, claim);
        return "resolved";
      }

      const attempts = Number(row.reconcile_attempt_count);
      if (attempts >= this.maxAttempts) {
        const updated = await client.query(
          `
            UPDATE pr_agent_harness.repository_operations
            SET status = 'manual_review', last_error_code = 'reconcile_attempts_exhausted',
                next_reconcile_at = NULL,
                reconcile_claim_owner = NULL, reconcile_claim_expires_at = NULL,
                version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND integration_id = $2 AND business_operation_id = $3
              AND reconcile_claim_owner = $4 AND reconcile_claim_version = $5
              AND status IN ('in_flight', 'unknown')
          `,
          [
            claim.tenantId,
            claim.integrationId,
            claim.businessOperationId,
            claim.claimOwner,
            claim.claimVersion,
          ],
        );
        if (updated.rowCount !== 1) return "lost";
        await client.query(
          `
            INSERT INTO pr_agent_harness.audit_logs (
              tenant_id, actor_type, actor_id, action, decision, reason_code,
              resource_type, resource_ref, details_json
            ) VALUES ($1, 'system', 'publication-recovery',
                      'publication.reconciliation_exhausted', 'error',
                      'reconcile_attempts_exhausted', 'repository_operation', $2, $3::jsonb)
          `,
          [
            claim.tenantId,
            claim.businessOperationId,
            JSON.stringify({ attempts, claimVersion: claim.claimVersion }),
          ],
        );
        return "manual_review";
      }

      const delayMs = this.backoffMs(attempts);
      const updated = await client.query(
        `
          UPDATE pr_agent_harness.repository_operations
          SET next_reconcile_at = now() + ($6::double precision * interval '1 millisecond'),
              reconcile_claim_owner = NULL, reconcile_claim_expires_at = NULL,
              updated_at = now()
          WHERE tenant_id = $1 AND integration_id = $2 AND business_operation_id = $3
            AND reconcile_claim_owner = $4 AND reconcile_claim_version = $5
            AND status IN ('in_flight', 'unknown')
        `,
        [
          claim.tenantId,
          claim.integrationId,
          claim.businessOperationId,
          claim.claimOwner,
          claim.claimVersion,
          delayMs,
        ],
      );
      return updated.rowCount === 1 ? "scheduled" : "lost";
    });
  }

  async claimPrepared(
    binding: PublicationBinding,
    businessOperationId: string,
    owner: string,
  ): Promise<PublicationRecoveryClaim | undefined> {
    const claimOwner = requiredOwner(owner);
    return this.db.transaction(binding.tenantId, async (client) => {
      await exhaustExpiredRecoveryClaims(
        client,
        binding,
        this.maxAttempts,
        "preflight",
        businessOperationId,
        1,
      );
      const result = await client.query<{ reconcile_claim_version: string; version: string }>(
        `UPDATE pr_agent_harness.repository_operations
         SET reconcile_claim_owner=$4, reconcile_claim_version=reconcile_claim_version+1,
             reconcile_attempt_count=reconcile_attempt_count+1,
             version=version+1,
             reconcile_claim_expires_at=now()+($5::double precision*interval '1 millisecond'),
             updated_at=now()
         WHERE tenant_id=$1 AND integration_id=$2 AND business_operation_id=$3
           AND authority_generation=$6 AND status='prepared'
           AND reconcile_attempt_count<$7
           AND (next_reconcile_at IS NULL OR next_reconcile_at<=now())
           AND (reconcile_claim_expires_at IS NULL OR reconcile_claim_expires_at<=now())
         RETURNING reconcile_claim_version,version`,
        [binding.tenantId, binding.id, businessOperationId, claimOwner,
          this.claimTtlMs, binding.generation, this.maxAttempts],
      );
      const row = result.rows[0];
      return row ? {
        tenantId: binding.tenantId,
        integrationId: binding.id,
        businessOperationId,
        claimOwner,
        claimVersion: Number(row.reconcile_claim_version),
        operationVersion: Number(row.version),
      } : undefined;
    });
  }

  async finishPrepared(
    claim: PublicationRecoveryClaim,
  ): Promise<"resolved" | "scheduled" | "manual_review" | "lost"> {
    return this.db.transaction(claim.tenantId, async (client) => {
      const selected = await client.query<{
        status: PublicationOperation["status"];
        reconcile_attempt_count: number;
      }>(
        `SELECT status,reconcile_attempt_count
         FROM pr_agent_harness.repository_operations
         WHERE tenant_id=$1 AND integration_id=$2 AND business_operation_id=$3
           AND reconcile_claim_owner=$4 AND reconcile_claim_version=$5
           AND reconcile_claim_expires_at>now() FOR UPDATE`,
        claimValues(claim),
      );
      const row = selected.rows[0];
      if (!row) return "lost";
      if (row.status !== "prepared") {
        await clearRecoveryClaim(client, claim);
        return "resolved";
      }
      const attempts = Number(row.reconcile_attempt_count);
      if (attempts >= this.maxAttempts) {
        const updated = await client.query(
          `UPDATE pr_agent_harness.repository_operations
           SET status='manual_review',last_error_code='preflight_attempts_exhausted',
               next_reconcile_at=NULL,
               reconcile_claim_owner=NULL,reconcile_claim_expires_at=NULL,
               version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND integration_id=$2 AND business_operation_id=$3
             AND reconcile_claim_owner=$4 AND reconcile_claim_version=$5 AND status='prepared'`,
          claimValues(claim),
        );
        if (updated.rowCount !== 1) return "lost";
        await insertExhaustedAudit(
          client,
          claim,
          attempts,
          "preflight_attempts_exhausted",
        );
        return "manual_review";
      }
      const updated = await client.query(
        `UPDATE pr_agent_harness.repository_operations
         SET next_reconcile_at=now()+($6::double precision*interval '1 millisecond'),
             reconcile_claim_owner=NULL,reconcile_claim_expires_at=NULL,updated_at=now()
         WHERE tenant_id=$1 AND integration_id=$2 AND business_operation_id=$3
           AND reconcile_claim_owner=$4 AND reconcile_claim_version=$5 AND status='prepared'`,
        [...claimValues(claim), this.backoffMs(attempts)],
      );
      return updated.rowCount === 1 ? "scheduled" : "lost";
    });
  }

  private backoffMs(attempts: number): number {
    return Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * 2 ** Math.max(0, attempts - 1),
    );
  }
}

interface RecoveryRuntime {
  service: PublicationService;
  createAdapter(operation: PublicationOperation): Promise<PublicationAdapter>;
}

export function createPublicationRecoveryLoop(input: {
  db: RuntimeDatabase;
  authority: PublicationAuthorityStore;
  batchStore: PublicationBatchStore;
  batchCoordinator: PublicationBatchCoordinator;
  runtimeForBinding(binding: PublicationBinding): Promise<RecoveryRuntime>;
  onError(error: unknown, context: PublicationRecoveryErrorContext): void;
  onActivity?(): void;
  loopOptions?: PublicationRecoveryOptions;
  scheduleOptions?: PgPublicationRecoveryScheduleOptions;
}): PublicationRecoveryLoop {
  const schedule = new PgPublicationRecoverySchedule(input.db, input.scheduleOptions);
  const owner = requiredOwner(input.loopOptions?.owner ?? `recovery-${randomUUID()}`);
  return new PublicationRecoveryLoop(
    {
      listBindings: async () => {
        const bindings = await input.authority.listRecoverable();
        input.onActivity?.();
        return bindings;
      },
      listBatches: async (binding, limit, signal) => {
        if (signal?.aborted) return [];
        const batches = await input.batchStore.listRecoverable(binding.tenantId, binding.id, limit);
        const recoverable: FrozenPublicationBatch[] = [];
        for (const batch of batches) {
          if (signal?.aborted) break;
          if (batch.status !== "pending") {
            recoverable.push(batch);
            continue;
          }
          const operation = await firstRecoverablePreparedOperation(
            (tenantId, operationId) => input.batchStore.loadOperation(tenantId, operationId),
            binding,
            batch,
          );
          if (!operation) {
            const refreshed = await input.batchStore.refreshOutcome(binding.tenantId, batch.id);
            if (refreshed?.status === "waiting_reconciliation") recoverable.push(refreshed);
            continue;
          }
          recoverable.push(batch);
        }
        return recoverable;
      },
      executeBatch: async (binding, batch, signal) => {
        if (signal?.aborted) return false;
        const operation = await firstRecoverablePreparedOperation(
          (tenantId, operationId) => input.batchStore.loadOperation(tenantId, operationId),
          binding,
          batch,
        );
        if (!operation || signal?.aborted) return false;
        const claim = await schedule.claimPrepared(binding, operation.businessOperationId, owner);
        if (!claim) return false;
        try {
          if (signal?.aborted) return false;
          const runtime = await input.runtimeForBinding(binding);
          await input.batchCoordinator.execute(binding.tenantId, batch.id, runtime.createAdapter);
          return true;
        } finally {
          const outcome = await schedule.finishPrepared(claim);
          if (outcome === "manual_review") {
            await input.batchStore.refreshOutcome(binding.tenantId, batch.id);
          }
        }
      },
      refreshBatch: (binding, batch) =>
        input.batchStore.refreshOutcome(binding.tenantId, batch.id),
      claimOperations: (binding, owner, limit) => schedule.claim(binding, owner, limit),
      reconcileOperation: async (binding, claim) => {
        const operation = await input.batchStore.loadOperation(
          binding.tenantId,
          claim.businessOperationId,
        );
        if (!operation) throw new Error("recoverable publication operation disappeared");
        if (operation.version !== claim.operationVersion) {
          throw new Error("recoverable publication operation version changed after claim");
        }
        const runtime = await input.runtimeForBinding(binding);
        const adapter = await runtime.createAdapter(operation);
        await runtime.service.reconcileOperation(
          binding.tenantId,
          claim.businessOperationId,
          adapter,
          claim.operationVersion,
        );
      },
      finishOperation: (claim) => schedule.finish(claim),
      onError: input.onError,
    },
    { ...input.loopOptions, owner },
  );
}

export async function firstRecoverablePreparedOperation(
  loadOperation: (
    tenantId: string,
    operationId: string,
  ) => Promise<PublicationOperation | undefined>,
  binding: PublicationBinding,
  batch: FrozenPublicationBatch,
): Promise<PublicationOperation | undefined> {
  for (const frozen of batch.operations) {
    const operation = await loadOperation(binding.tenantId, frozen.businessOperationId);
    if (!operation) throw new Error("publication batch references a missing operation");
    if (operation.status === "succeeded" && operation.outcomeCode === "current") continue;
    if (operation.status === "prepared") return operation;
    return undefined;
  }
  return undefined;
}

async function clearRecoveryClaim(
  client: { query(query: string, values: unknown[]): Promise<unknown> },
  claim: PublicationRecoveryClaim,
): Promise<void> {
  await client.query(
    `
      UPDATE pr_agent_harness.repository_operations
      SET reconcile_claim_owner = NULL, reconcile_claim_expires_at = NULL,
          next_reconcile_at = NULL, updated_at = now()
      WHERE tenant_id = $1 AND integration_id = $2 AND business_operation_id = $3
        AND reconcile_claim_owner = $4 AND reconcile_claim_version = $5
    `,
    [
      claim.tenantId,
      claim.integrationId,
      claim.businessOperationId,
      claim.claimOwner,
      claim.claimVersion,
    ],
  );
}

async function insertExhaustedAudit(
  client: { query(query: string, values: unknown[]): Promise<unknown> },
  claim: PublicationRecoveryClaim,
  attempts: number,
  reasonCode: "preflight_attempts_exhausted" | "reconcile_attempts_exhausted",
): Promise<void> {
  await client.query(
    `INSERT INTO pr_agent_harness.audit_logs (
       tenant_id,actor_type,actor_id,action,decision,reason_code,
       resource_type,resource_ref,details_json
     ) VALUES ($1,'system','publication-recovery',$2,'error',$3,
               'repository_operation',$4,$5::jsonb)`,
    [
      claim.tenantId,
      reasonCode === "preflight_attempts_exhausted"
        ? "publication.preflight_exhausted"
        : "publication.reconciliation_exhausted",
      reasonCode,
      claim.businessOperationId,
      JSON.stringify({ attempts, claimVersion: claim.claimVersion }),
    ],
  );
}

async function exhaustExpiredRecoveryClaims(
  client: PoolClient,
  binding: PublicationBinding,
  maxAttempts: number,
  kind: "reconcile" | "preflight",
  businessOperationId?: string,
  limit = 100,
): Promise<void> {
  const statuses = kind === "reconcile"
    ? "ro.status IN ('in_flight','unknown')"
    : "ro.status = 'prepared'";
  const reasonCode = kind === "reconcile"
    ? "reconcile_attempts_exhausted"
    : "preflight_attempts_exhausted";
  const result = await client.query<{
    business_operation_id: string;
    reconcile_claim_version: string;
    reconcile_attempt_count: number;
  }>(
    `WITH exhausted AS (
       SELECT ro.business_operation_id
       FROM pr_agent_harness.repository_operations ro
       WHERE ro.tenant_id=$1 AND ro.integration_id=$2 AND ro.authority_generation=$3
         AND ${statuses}
         AND ro.reconcile_attempt_count >= $4
         AND (ro.reconcile_claim_expires_at IS NULL OR ro.reconcile_claim_expires_at <= now())
         AND ($6::text IS NULL OR ro.business_operation_id=$6)
         AND (
           ro.status <> 'in_flight'
           OR (
             (ro.next_reconcile_at IS NULL OR ro.next_reconcile_at <= now())
             AND NOT EXISTS (
               SELECT 1
               FROM pr_agent_harness.publication_batch_operations pbo
               JOIN pr_agent_harness.run_publication_batches rpb
                 ON rpb.tenant_id=pbo.tenant_id AND rpb.batch_id=pbo.batch_id
               JOIN pr_agent_harness.agent_runs r
                 ON r.tenant_id=rpb.tenant_id AND r.id=rpb.run_id
               WHERE pbo.tenant_id=ro.tenant_id
                 AND pbo.business_operation_id=ro.business_operation_id
                 AND r.status='running' AND r.lease_expires_at > now()
             )
           )
         )
       ORDER BY ro.updated_at,ro.business_operation_id
       FOR UPDATE SKIP LOCKED
       LIMIT $7
     )
     UPDATE pr_agent_harness.repository_operations ro
     SET status='manual_review',last_error_code=$5,next_reconcile_at=NULL,
         reconcile_claim_owner=NULL,reconcile_claim_expires_at=NULL,
         version=version+1,updated_at=now()
     FROM exhausted
     WHERE ro.tenant_id=$1 AND ro.business_operation_id=exhausted.business_operation_id
     RETURNING ro.business_operation_id,ro.reconcile_claim_version,ro.reconcile_attempt_count`,
    [
      binding.tenantId,
      binding.id,
      binding.generation,
      maxAttempts,
      reasonCode,
      businessOperationId ?? null,
      boundedLimit(limit, "recovery exhaustion limit"),
    ],
  );
  for (const row of result.rows) {
    await insertExhaustedAudit(
      client,
      {
        tenantId: binding.tenantId,
        integrationId: binding.id,
        businessOperationId: row.business_operation_id,
        claimOwner: "expired",
        claimVersion: Number(row.reconcile_claim_version),
        operationVersion: 0,
      },
      Number(row.reconcile_attempt_count),
      reasonCode,
    );
  }
}

function claimValues(claim: PublicationRecoveryClaim): unknown[] {
  return [
    claim.tenantId,
    claim.integrationId,
    claim.businessOperationId,
    claim.claimOwner,
    claim.claimVersion,
  ];
}

function operationContext(
  phase: "operation_reconcile" | "operation_finish",
  claim: PublicationRecoveryClaim,
): PublicationRecoveryErrorContext {
  return {
    phase,
    tenantId: claim.tenantId,
    integrationId: claim.integrationId,
    resourceId: claim.businessOperationId,
  };
}

function batchContext(
  phase: "batch_execute" | "batch_refresh",
  binding: PublicationBinding,
  batch: FrozenPublicationBatch,
): PublicationRecoveryErrorContext {
  return {
    phase,
    tenantId: binding.tenantId,
    integrationId: binding.id,
    resourceId: batch.id,
  };
}

function emptyResult(skipped: boolean): PublicationRecoveryTickResult {
  return {
    skipped,
    bindings: 0,
    batchesExecuted: 0,
    operationsClaimed: 0,
    operationsManualReview: 0,
    errors: 0,
  };
}

function requiredOwner(owner: string): string {
  const normalized = owner.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("recovery owner must be between 1 and 200 characters");
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function boundedLimit(value: number, label: string): number {
  return Math.min(500, positiveInteger(value, label));
}
