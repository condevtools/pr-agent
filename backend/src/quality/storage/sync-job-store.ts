import { createHash } from "node:crypto";

import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import type { EnqueueQualitySyncJobInput, QualityScope, QualitySyncJob, QualitySyncJobKind,
  QualitySyncJobStatus, QualitySyncLease } from "./contracts.js";
import { QualityLeaseLostError, QualityStorageConflictError, QualityStorageNotFoundError } from "./contracts.js";
import { assertHash, assertScope, assertText, iso, optionalIso, safeInteger } from "./internal.js";

interface SyncJobRow {
  id: string; tenant_id: string; integration_id: string; kind: QualitySyncJobKind;
  external_id: string; idempotency_key: string; request_hash: string; target_fingerprint: string;
  payload_json: Record<string, unknown>; principal_json: Record<string, unknown>; status: QualitySyncJobStatus;
  attempt_count: number; max_attempts: number; max_age_seconds: number; available_at: Date;
  retry_started_at: Date;
  lease_owner: string | null; lease_epoch: string; lease_expires_at: Date | null;
  result_json: Record<string, unknown> | null; error_code: string | null; completed_at: Date | null;
  created_at: Date; updated_at: Date; version: string; retry_command_key?: string | null;
}

const KINDS = new Set<QualitySyncJobKind>([
  "prompt_pull", "dataset_export", "evaluation_export", "annotation_queue", "annotation_pull", "scores_export",
]);

export class PgQualitySyncJobStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async enqueue(scope: QualityScope, input: EnqueueQualitySyncJobInput): Promise<QualitySyncJob> {
    validateEnqueue(scope, input);
    return this.db.transaction(scope.tenantId, async (client) => {
      const inserted = await client.query<SyncJobRow>(
        `INSERT INTO pr_agent_harness.quality_sync_jobs
           (tenant_id,integration_id,kind,external_id,idempotency_key,request_hash,target_fingerprint,
            payload_json,principal_json,max_attempts,max_age_seconds,available_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,COALESCE($12,clock_timestamp()))
         ON CONFLICT (tenant_id,integration_id,kind,idempotency_key) DO NOTHING RETURNING *`,
        [scope.tenantId, scope.integrationId, input.kind, input.externalId, input.idempotencyKey,
          input.requestHash, input.targetFingerprint, JSON.stringify(input.payload), JSON.stringify(input.principal),
          input.maxAttempts ?? 8, input.maxAgeSeconds ?? 86_400, input.availableAt ?? null]);
      if (inserted.rows[0]) return mapSyncJob(inserted.rows[0]);
      const existing = await client.query<SyncJobRow>(
        `SELECT * FROM pr_agent_harness.quality_sync_jobs
         WHERE tenant_id=$1 AND integration_id=$2 AND kind=$3 AND idempotency_key=$4`,
        [scope.tenantId, scope.integrationId, input.kind, input.idempotencyKey]);
      const row = existing.rows[0];
      if (!row || row.request_hash !== input.requestHash || row.target_fingerprint !== input.targetFingerprint
          || row.external_id !== input.externalId) {
        throw new QualityStorageConflictError("Quality sync idempotency key was reused with different content");
      }
      return mapSyncJob(row);
    });
  }

  async claim(scope: QualityScope, input: { owner: string; limit?: number; leaseMs?: number }): Promise<QualitySyncLease[]> {
    assertScope(scope); assertText(input.owner, "lease owner", 240);
    const limit = input.limit ?? 10; const leaseMs = input.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
      throw new Error("invalid quality sync claim bounds");
    }
    return this.db.transaction(scope.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,947))", [
        `quality-sync:${scope.tenantId}:${scope.integrationId}`,
      ]);
      await client.query(
        `UPDATE pr_agent_harness.quality_sync_jobs SET status='dead_letter',completed_at=clock_timestamp(),
           lease_owner=NULL,lease_expires_at=NULL,error_code=COALESCE(error_code,'retry_budget_exhausted'),
           updated_at=clock_timestamp(),version=version+1
         WHERE tenant_id=$1 AND integration_id=$2 AND status IN ('queued','retry_wait','running')
           AND (attempt_count>=max_attempts OR retry_started_at+(max_age_seconds*interval '1 second')<=clock_timestamp())
           AND (status<>'running' OR lease_expires_at<=clock_timestamp())`, [scope.tenantId, scope.integrationId]);
      const active = await client.query<{ active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pr_agent_harness.quality_sync_jobs
         WHERE tenant_id=$1 AND integration_id=$2 AND status='running'
           AND lease_expires_at>clock_timestamp()) AS active`, [scope.tenantId, scope.integrationId]);
      if (active.rows[0]?.active) return [];
      const claimed = await client.query<SyncJobRow>(
        `WITH candidates AS (
           SELECT id FROM pr_agent_harness.quality_sync_jobs
           WHERE tenant_id=$1 AND integration_id=$2
             AND ((status IN ('queued','retry_wait') AND available_at<=clock_timestamp())
               OR (status='running' AND lease_expires_at<=clock_timestamp()))
             AND attempt_count<max_attempts
             AND retry_started_at+(max_age_seconds*interval '1 second')>clock_timestamp()
           ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE pr_agent_harness.quality_sync_jobs j SET status='running',lease_owner=$3,
           lease_epoch=j.lease_epoch+1,lease_expires_at=clock_timestamp()+($4::bigint*interval '1 millisecond'),
           attempt_count=j.attempt_count+1,error_code=NULL,completed_at=NULL,updated_at=clock_timestamp(),version=j.version+1
         FROM candidates c WHERE j.id=c.id RETURNING j.*`,
        [scope.tenantId, scope.integrationId, input.owner, leaseMs]);
      return claimed.rows.map((row) => mapSyncJob(row) as QualitySyncLease);
    });
  }

  async complete(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number },
    result: Record<string, unknown>): Promise<QualitySyncJob> {
    validateLease(scope, lease);
    return this.db.transaction(scope.tenantId, async (client) => {
      const updated = await client.query<SyncJobRow>(
        `UPDATE pr_agent_harness.quality_sync_jobs SET status='succeeded',result_json=$6::jsonb,error_code=NULL,
           lease_owner=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='running'
           AND lease_owner=$4 AND lease_epoch=$5 AND lease_expires_at>clock_timestamp() RETURNING *`,
        [scope.tenantId, scope.integrationId, lease.jobId, lease.owner, lease.epoch, JSON.stringify(result)]);
      if (!updated.rows[0]) throw new QualityLeaseLostError("Quality sync lease is no longer current");
      return mapSyncJob(updated.rows[0]);
    });
  }

  async heartbeat(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number },
    leaseMs: number): Promise<QualitySyncJob> {
    validateLease(scope, lease);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
      throw new Error("invalid quality sync lease duration");
    }
    return this.db.transaction(scope.tenantId, async (client) => {
      const updated = await client.query<SyncJobRow>(
        `UPDATE pr_agent_harness.quality_sync_jobs
         SET lease_expires_at=clock_timestamp()+($6::bigint*interval '1 millisecond'),
           updated_at=clock_timestamp(),version=version+1
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='running'
           AND lease_owner=$4 AND lease_epoch=$5 AND lease_expires_at>clock_timestamp() RETURNING *`,
        [scope.tenantId, scope.integrationId, lease.jobId, lease.owner, lease.epoch, leaseMs]);
      if (!updated.rows[0]) throw new QualityLeaseLostError("Quality sync lease is no longer current");
      return mapSyncJob(updated.rows[0]);
    });
  }

  async fail(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number },
    input: { errorCode: string; retryAfterMs?: number }): Promise<QualitySyncJob> {
    validateLease(scope, lease); assertText(input.errorCode, "error code", 160);
    if (input.retryAfterMs !== undefined && (!Number.isSafeInteger(input.retryAfterMs)
        || input.retryAfterMs < 1_000 || input.retryAfterMs > 15 * 60_000)) throw new Error("invalid retry delay");
    return this.db.transaction(scope.tenantId, async (client) => {
      const current = await client.query<SyncJobRow>(
        `SELECT * FROM pr_agent_harness.quality_sync_jobs
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='running'
           AND lease_owner=$4 AND lease_epoch=$5 FOR UPDATE`,
        [scope.tenantId, scope.integrationId, lease.jobId, lease.owner, lease.epoch]);
      const row = current.rows[0];
      if (!row) throw new QualityLeaseLostError("Quality sync lease is no longer current");
      const exhausted = row.attempt_count >= row.max_attempts
        || row.retry_started_at.getTime() + row.max_age_seconds * 1_000 <= Date.now();
      const delay = input.retryAfterMs ?? retryDelayMs(row.id, Number(row.lease_epoch), row.attempt_count);
      const updated = await client.query<SyncJobRow>(
        `UPDATE pr_agent_harness.quality_sync_jobs SET status=$6,error_code=$7,result_json=NULL,
           available_at=CASE WHEN $6='retry_wait' THEN clock_timestamp()+($8::bigint*interval '1 millisecond') ELSE available_at END,
           lease_owner=NULL,lease_expires_at=NULL,completed_at=CASE WHEN $6='dead_letter' THEN clock_timestamp() ELSE NULL END,
           updated_at=clock_timestamp(),version=version+1
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='running'
           AND lease_owner=$4 AND lease_epoch=$5 RETURNING *`,
        [scope.tenantId, scope.integrationId, lease.jobId, lease.owner, lease.epoch,
          exhausted ? "dead_letter" : "retry_wait", input.errorCode, delay]);
      if (!updated.rows[0]) throw new QualityLeaseLostError("Quality sync lease is no longer current");
      return mapSyncJob(updated.rows[0]);
    });
  }

  async list(scope: QualityScope, filter: { status?: QualitySyncJobStatus; kind?: QualitySyncJobKind;
    limit?: number } = {}): Promise<QualitySyncJob[]> {
    assertScope(scope); const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid quality sync list limit");
    if (filter.kind !== undefined && !KINDS.has(filter.kind)) throw new Error("invalid quality sync kind");
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<SyncJobRow>(
        `SELECT * FROM pr_agent_harness.quality_sync_jobs
         WHERE tenant_id=$1 AND integration_id=$2 AND ($3::text IS NULL OR status=$3)
           AND ($4::text IS NULL OR kind=$4) ORDER BY created_at DESC,id DESC LIMIT $5`,
        [scope.tenantId, scope.integrationId, filter.status ?? null, filter.kind ?? null, limit]);
      return result.rows.map(mapSyncJob);
    });
  }

  async read(scope: QualityScope, jobId: string): Promise<QualitySyncJob> {
    assertScope(scope);
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<SyncJobRow>(
        `SELECT * FROM pr_agent_harness.quality_sync_jobs
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
        [scope.tenantId, scope.integrationId, jobId]);
      if (!result.rows[0]) throw new QualityStorageNotFoundError("Quality sync job was not found");
      return mapSyncJob(result.rows[0]);
    });
  }

  async retry(scope: QualityScope, input: { jobId: string; expectedVersion: number; commandKey: string }): Promise<QualitySyncJob> {
    assertScope(scope); assertText(input.commandKey, "retry command key", 240);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error("invalid expected version");
    return this.db.transaction(scope.tenantId, async (client) => {
      const current = await client.query<SyncJobRow>(
        `SELECT * FROM pr_agent_harness.quality_sync_jobs
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
        [scope.tenantId, scope.integrationId, input.jobId]);
      const row = current.rows[0];
      if (!row) throw new QualityStorageNotFoundError("Quality sync job was not found");
      if (row.retry_command_key === input.commandKey) return mapSyncJob(row);
      if (Number(row.version) !== input.expectedVersion || row.status !== "dead_letter") {
        throw new QualityStorageConflictError("Quality sync retry no longer matches the dead-letter version");
      }
      const updated = await client.query<SyncJobRow>(
        `UPDATE pr_agent_harness.quality_sync_jobs SET status='queued',attempt_count=0,
           retry_started_at=clock_timestamp(),available_at=clock_timestamp(),
           retry_command_key=$4,error_code=NULL,completed_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
           updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 RETURNING *`,
        [scope.tenantId, scope.integrationId, input.jobId, input.commandKey]);
      return mapSyncJob(updated.rows[0]!);
    });
  }

  async purgeTerminal(scope: QualityScope, input: { before: Date; limit?: number }): Promise<number> {
    assertScope(scope); const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 || !Number.isFinite(input.before.getTime())) {
      throw new Error("invalid quality sync retention request");
    }
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<{ count: number }>(
        `WITH candidates AS (
           SELECT id FROM pr_agent_harness.quality_sync_jobs
           WHERE tenant_id=$1 AND integration_id=$2 AND status IN ('succeeded','dead_letter')
             AND completed_at<$3 ORDER BY completed_at,id LIMIT $4
         ), deleted AS (
           DELETE FROM pr_agent_harness.quality_sync_jobs j USING candidates c WHERE j.id=c.id RETURNING 1
         ) SELECT count(*)::int AS count FROM deleted`, [scope.tenantId, scope.integrationId, input.before, limit]);
      return result.rows[0]?.count ?? 0;
    });
  }
}

function validateEnqueue(scope: QualityScope, input: EnqueueQualitySyncJobInput): void {
  assertScope(scope);
  if (!KINDS.has(input.kind)) throw new Error("invalid quality sync kind");
  assertText(input.externalId, "external id", 240); assertText(input.idempotencyKey, "idempotency key", 240);
  assertHash(input.requestHash, "request hash"); assertHash(input.targetFingerprint, "target fingerprint");
  if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts)
      || input.maxAttempts < 1 || input.maxAttempts > 32)) throw new Error("invalid max attempts");
  if (input.maxAgeSeconds !== undefined && (!Number.isSafeInteger(input.maxAgeSeconds)
      || input.maxAgeSeconds < 60 || input.maxAgeSeconds > 604_800)) throw new Error("invalid max age");
}

function validateLease(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number }): void {
  assertScope(scope); assertText(lease.owner, "lease owner", 240);
  if (!Number.isSafeInteger(lease.epoch) || lease.epoch < 1) throw new Error("invalid lease epoch");
}

function retryDelayMs(id: string, epoch: number, attempt: number): number {
  const base = Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));
  const byte = createHash("sha256").update(`${id}:${epoch}`).digest()[0] ?? 128;
  return Math.max(1_000, Math.round(base * (0.8 + (byte / 255) * 0.4)));
}

function mapSyncJob(row: SyncJobRow): QualitySyncJob {
  return { id: row.id, scope: { tenantId: row.tenant_id, integrationId: row.integration_id }, kind: row.kind,
    externalId: row.external_id, idempotencyKey: row.idempotency_key, requestHash: row.request_hash,
    targetFingerprint: row.target_fingerprint, payload: row.payload_json, principal: row.principal_json,
    status: row.status, attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    maxAgeSeconds: row.max_age_seconds, availableAt: iso(row.available_at),
    leaseOwner: row.lease_owner ?? undefined, leaseEpoch: safeInteger(row.lease_epoch, "lease epoch"),
    leaseExpiresAt: optionalIso(row.lease_expires_at), result: row.result_json ?? undefined,
    errorCode: row.error_code ?? undefined, completedAt: optionalIso(row.completed_at), createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at), version: safeInteger(row.version, "sync job version") };
}
