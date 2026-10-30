import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip, constants as zlibConstants } from "node:zlib";

import type { Pool, PoolClient } from "pg";

import { RuntimeDatabase } from "../postgres/database.js";
import { fingerprint } from "../versions.js";
import { RUN_ARTIFACT_LIMITS, RunArtifactCorruptError, RunArtifactLimitError,
  RunArtifactUnavailableError,
  type PreparedRunArtifact, type RunArtifactHoldKind, type RunArtifactPurpose,
  type RunArtifactRead, type RunArtifactRef, type RunArtifactScope } from "./contracts.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const HASH = /^[a-f0-9]{64}$/;

interface ArtifactRow {
  tenant_id: string; integration_id: string; run_id: string; artifact_hash: string;
  purpose: RunArtifactPurpose; content_type: string; raw_size_bytes: number; compressed_size_bytes: number;
  content_compressed: Buffer | null; retention_expires_at: Date; purged_at: Date | null;
}

export async function prepareRunArtifact(
  content: Uint8Array,
  metadata: { contentType: string; purpose: RunArtifactPurpose },
): Promise<PreparedRunArtifact> {
  validateMetadata(metadata.contentType, metadata.purpose);
  if (content.byteLength > RUN_ARTIFACT_LIMITS.maxRawBytes) throw new RunArtifactLimitError("artifact_raw_limit");
  const raw = Buffer.from(content);
  const compressed = await gzipAsync(raw, { level: zlibConstants.Z_BEST_COMPRESSION });
  if (compressed.byteLength > RUN_ARTIFACT_LIMITS.maxCompressedBytes) {
    throw new RunArtifactLimitError("artifact_compressed_limit");
  }
  return { artifactHash: sha256(raw), rawSizeBytes: raw.byteLength, compressedSizeBytes: compressed.byteLength,
    contentType: metadata.contentType, purpose: metadata.purpose, compressed };
}

export class PgRunArtifactStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async put(scope: RunArtifactScope, content: Uint8Array,
    metadata: { contentType: string; purpose: RunArtifactPurpose }): Promise<RunArtifactRef> {
    const prepared = await prepareRunArtifact(content, metadata);
    return this.db.transaction(scope.tenantId, (client) => this.putPreparedInTransaction(client, scope, prepared));
  }

  async putStepOutput(scope: RunArtifactScope, content: Uint8Array, contentType = "application/json"):
  Promise<RunArtifactRef> {
    return this.put(scope, content, { contentType, purpose: "step_output" });
  }

  async putFixSnapshotForQueuedRunInTransaction(
    client: PoolClient,
    scope: RunArtifactScope,
    prepared: PreparedRunArtifact,
  ): Promise<RunArtifactRef> {
    return this.putPreparedInTransaction(client, scope, prepared, "queued");
  }

  async putPreparedInTransaction(
    client: PoolClient,
    scope: RunArtifactScope,
    prepared: PreparedRunArtifact,
    requiredRunStatus?: "queued",
  ): Promise<RunArtifactRef> {
    await validatePrepared(prepared);
    const run = await client.query<{ status: string }>(
      `SELECT status FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
      [scope.tenantId, scope.integrationId, scope.runId]);
    if (!run.rows[0] || (requiredRunStatus && run.rows[0].status !== requiredRunStatus)) {
      throw new Error(requiredRunStatus ? "artifact requires a queued Run" : "artifact Run scope is unavailable");
    }
    const existing = await client.query<ArtifactRow>(
      `SELECT * FROM pr_agent_harness.run_artifacts
       WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND artifact_hash=$4`,
      [scope.tenantId, scope.integrationId, scope.runId, prepared.artifactHash]);
    if (existing.rows[0]) {
      assertImmutable(existing.rows[0], prepared);
      return refFromRow(existing.rows[0]);
    }
    const total = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(raw_size_bytes),0)::text AS total FROM pr_agent_harness.run_artifacts
       WHERE tenant_id=$1 AND run_id=$2`, [scope.tenantId, scope.runId]);
    if (Number(total.rows[0]?.total ?? 0) + prepared.rawSizeBytes > RUN_ARTIFACT_LIMITS.maxRunRawBytes) {
      throw new RunArtifactLimitError("run_artifact_quota");
    }
    const inserted = await client.query<ArtifactRow>(
      `INSERT INTO pr_agent_harness.run_artifacts
         (tenant_id,integration_id,run_id,artifact_hash,purpose,content_type,raw_size_bytes,
          compressed_size_bytes,content_compressed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [scope.tenantId, scope.integrationId, scope.runId, prepared.artifactHash, prepared.purpose,
        prepared.contentType, prepared.rawSizeBytes, prepared.compressedSizeBytes, prepared.compressed]);
    return refFromRow(inserted.rows[0]!);
  }

  async read(scope: RunArtifactScope, artifactHash: string): Promise<RunArtifactRead | undefined> {
    if (!HASH.test(artifactHash)) throw new Error("invalid artifact hash");
    return this.db.transaction(scope.tenantId,
      (client) => this.readInTransaction(client, scope, artifactHash));
  }

  async readInTransaction(client: PoolClient, scope: RunArtifactScope,
    artifactHash: string): Promise<RunArtifactRead | undefined> {
    if (!HASH.test(artifactHash)) throw new Error("invalid artifact hash");
    const result = await client.query<ArtifactRow>(
      `SELECT * FROM pr_agent_harness.run_artifacts
       WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND artifact_hash=$4`,
      [scope.tenantId, scope.integrationId, scope.runId, artifactHash]);
    const row = result.rows[0];
    if (!row) return undefined;
    const ref = refFromRow(row);
    if (!row.content_compressed || row.purged_at) {
      return { status: "gone", ref, purgedAt: row.purged_at!.toISOString() };
    }
    try {
      const raw = await gunzipAsync(row.content_compressed, { maxOutputLength: row.raw_size_bytes + 1 });
      if (raw.byteLength !== row.raw_size_bytes || sha256(raw) !== row.artifact_hash) {
        throw new RunArtifactCorruptError(row.artifact_hash);
      }
      return { status: "available", ref, content: raw };
    } catch (error) {
      if (error instanceof RunArtifactCorruptError) throw error;
      throw new RunArtifactCorruptError(row.artifact_hash);
    }
  }

  async readRequiredJsonInTransaction(client: PoolClient, scope: RunArtifactScope,
    artifactHash: string): Promise<Record<string, unknown>> {
    const stored = await this.readInTransaction(client, scope, artifactHash);
    if (!stored) throw new RunArtifactUnavailableError(artifactHash, "missing");
    if (stored.status === "gone") throw new RunArtifactUnavailableError(artifactHash, "gone");
    try {
      const parsed: unknown = JSON.parse(stored.content.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RunArtifactCorruptError) throw error;
      throw new RunArtifactCorruptError(artifactHash);
    }
  }

  async readStepOutputValueInTransaction<T>(client: PoolClient, scope: RunArtifactScope, input: {
    resultRef?: string | null;
    output?: Record<string, unknown> | null;
    outputHash: string;
  }): Promise<T> {
    const output = input.resultRef
      ? await this.readRequiredJsonInTransaction(client, scope, input.resultRef)
      : input.output;
    if (!output || fingerprint(output) !== input.outputHash || !("value" in output)) {
      throw new RunArtifactCorruptError(input.resultRef ?? input.outputHash);
    }
    return output.value as T;
  }

  async hold(scope: RunArtifactScope, artifactHash: string, holdKey: string, holdKind: RunArtifactHoldKind): Promise<void> {
    validateHold(artifactHash, holdKey, holdKind);
    await this.db.transaction(scope.tenantId,
      (client) => this.holdInTransaction(client, scope, artifactHash, holdKey, holdKind));
  }

  async holdInTransaction(client: PoolClient, scope: RunArtifactScope, artifactHash: string,
    holdKey: string, holdKind: RunArtifactHoldKind): Promise<void> {
    validateHold(artifactHash, holdKey, holdKind);
    const artifact = await client.query<{ available: boolean }>(
      `SELECT pr_agent_harness.lock_available_run_artifact($1,$2,$3,$4) AS available`,
      [scope.tenantId, scope.integrationId, scope.runId, artifactHash]);
    if (!artifact.rows[0]?.available) throw new RunArtifactUnavailableError(artifactHash, "gone");
    const inserted = await client.query(
        `INSERT INTO pr_agent_harness.run_artifact_holds
          (tenant_id,integration_id,run_id,artifact_hash,hold_key,hold_kind)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING hold_key`,
        [scope.tenantId, scope.integrationId, scope.runId, artifactHash, holdKey, holdKind]);
    if (!inserted.rowCount) {
      const exact = await client.query(
          `SELECT 1 FROM pr_agent_harness.run_artifact_holds
           WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND artifact_hash=$4
             AND hold_key=$5 AND hold_kind=$6`,
          [scope.tenantId, scope.integrationId, scope.runId, artifactHash, holdKey, holdKind]);
      if (!exact.rowCount) throw new Error("artifact hold identity conflict");
    }
  }

  async releaseHold(scope: RunArtifactScope, artifactHash: string, holdKey: string): Promise<void> {
    if (!HASH.test(artifactHash) || !holdKey || holdKey.length > 200) throw new Error("invalid artifact hold release");
    await this.db.transaction(scope.tenantId,
      (client) => this.releaseHoldInTransaction(client, scope, artifactHash, holdKey));
  }

  async releaseHoldInTransaction(client: PoolClient, scope: RunArtifactScope, artifactHash: string,
    holdKey: string): Promise<void> {
    if (!HASH.test(artifactHash) || !holdKey || holdKey.length > 200) throw new Error("invalid artifact hold release");
    const inserted = await client.query(
        `INSERT INTO pr_agent_harness.run_artifact_hold_releases
          (tenant_id,integration_id,run_id,artifact_hash,hold_key)
         SELECT tenant_id,integration_id,run_id,artifact_hash,hold_key
         FROM pr_agent_harness.run_artifact_holds
         WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND artifact_hash=$4 AND hold_key=$5
         ON CONFLICT DO NOTHING RETURNING hold_key`,
        [scope.tenantId, scope.integrationId, scope.runId, artifactHash, holdKey]);
    if (!inserted.rowCount) {
      const existing = await client.query(
          `SELECT 1 FROM pr_agent_harness.run_artifact_hold_releases
           WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND artifact_hash=$4 AND hold_key=$5`,
          [scope.tenantId, scope.integrationId, scope.runId, artifactHash, holdKey]);
      if (!existing.rowCount) throw new Error("artifact hold is unavailable");
    }
  }
}

export class PgRunArtifactGarbageCollector {
  constructor(private readonly pool: Pool) {}

  async purgeExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid artifact GC limit");
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT a.tenant_id,a.run_id,a.artifact_hash
         FROM pr_agent_harness.run_artifacts a
         JOIN pr_agent_harness.agent_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
         WHERE a.purged_at IS NULL AND a.retention_expires_at<=clock_timestamp()
           AND r.status IN ('succeeded','failed','cancelled')
           AND r.finished_at+interval '30 days'<=clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
             JOIN pr_agent_harness.publication_batch_operations bo
               ON bo.tenant_id=rb.tenant_id AND bo.batch_id=rb.batch_id
             JOIN pr_agent_harness.repository_operations o
               ON o.tenant_id=bo.tenant_id AND o.business_operation_id=bo.business_operation_id
             WHERE rb.tenant_id=a.tenant_id AND rb.run_id=a.run_id
               AND o.status IN ('prepared','in_flight','unknown','manual_review'))
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls c
             WHERE c.tenant_id=a.tenant_id AND c.run_id=a.run_id
               AND c.status IN ('prepared','in_flight','unknown'))
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_budget_reservations b
             WHERE b.tenant_id=a.tenant_id AND b.run_id=a.run_id AND b.status IN ('reserved','pending'))
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes e
             WHERE e.tenant_id=a.tenant_id AND e.run_id=a.run_id AND e.status<>'closed')
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds h
             LEFT JOIN pr_agent_harness.run_artifact_hold_releases x
               ON x.tenant_id=h.tenant_id AND x.run_id=h.run_id
                 AND x.artifact_hash=h.artifact_hash AND x.hold_key=h.hold_key
             WHERE h.tenant_id=a.tenant_id AND h.run_id=a.run_id AND h.artifact_hash=a.artifact_hash
               AND x.hold_key IS NULL)
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_hold_releases x
             WHERE x.tenant_id=a.tenant_id AND x.run_id=a.run_id AND x.artifact_hash=a.artifact_hash
               AND x.released_at+interval '30 days'>clock_timestamp())
         ORDER BY a.retention_expires_at,a.tenant_id,a.run_id,a.artifact_hash
         FOR UPDATE OF a SKIP LOCKED LIMIT $1
       ), purged AS (
         UPDATE pr_agent_harness.run_artifacts a
         SET content_compressed=NULL,purged_at=clock_timestamp()
         FROM candidates c WHERE a.tenant_id=c.tenant_id AND a.run_id=c.run_id
           AND a.artifact_hash=c.artifact_hash RETURNING 1
       ) SELECT count(*)::int AS count FROM purged`, [limit]);
    return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
  }
}

async function validatePrepared(value: PreparedRunArtifact): Promise<void> {
  validateMetadata(value.contentType, value.purpose);
  if (!HASH.test(value.artifactHash) || value.rawSizeBytes < 0
      || value.rawSizeBytes > RUN_ARTIFACT_LIMITS.maxRawBytes) throw new RunArtifactLimitError("artifact_raw_limit");
  if (value.compressedSizeBytes !== value.compressed.byteLength
      || value.compressedSizeBytes > RUN_ARTIFACT_LIMITS.maxCompressedBytes) {
    throw new RunArtifactLimitError("artifact_compressed_limit");
  }
  try {
    const raw = await gunzipAsync(value.compressed, { maxOutputLength: value.rawSizeBytes + 1 });
    if (raw.byteLength !== value.rawSizeBytes || sha256(raw) !== value.artifactHash) {
      throw new RunArtifactCorruptError(value.artifactHash);
    }
  } catch (error) {
    if (error instanceof RunArtifactCorruptError) throw error;
    throw new RunArtifactCorruptError(value.artifactHash);
  }
}

function validateMetadata(contentType: string, purpose: RunArtifactPurpose): void {
  if (!contentType || contentType.length > 200 || /[\r\n]/.test(contentType)) throw new Error("invalid artifact content type");
  if (!["step_output", "fix_snapshot", "evaluation", "log", "other"].includes(purpose)) {
    throw new Error("invalid artifact purpose");
  }
}

function validateHold(hash: string, key: string, kind: RunArtifactHoldKind): void {
  if (!HASH.test(hash) || !key || key.length > 200
      || !["fix", "evolution", "qualification", "legal", "other"].includes(kind)) {
    throw new Error("invalid artifact hold");
  }
}

function assertImmutable(row: ArtifactRow, prepared: PreparedRunArtifact): void {
  if (row.purged_at || row.raw_size_bytes !== prepared.rawSizeBytes
      || row.compressed_size_bytes !== prepared.compressedSizeBytes
      || row.content_type !== prepared.contentType || row.purpose !== prepared.purpose
      || !row.content_compressed?.equals(prepared.compressed)) throw new Error("artifact identity conflict");
}

function refFromRow(row: ArtifactRow): RunArtifactRef {
  return { tenantId: row.tenant_id, integrationId: row.integration_id, runId: row.run_id,
    artifactHash: row.artifact_hash, rawSizeBytes: row.raw_size_bytes,
    compressedSizeBytes: row.compressed_size_bytes, contentType: row.content_type,
    purpose: row.purpose, retentionExpiresAt: row.retention_expires_at.toISOString() };
}

function sha256(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
