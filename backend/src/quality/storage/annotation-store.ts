import type { PoolClient } from "pg";

import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import type { ImportQualityAnnotationInput, QualityActor, QualityAnnotationImport,
  QualityAnnotationState, QualityScope } from "./contracts.js";
import { QualityStorageConflictError, QualityStorageNotFoundError } from "./contracts.js";
import { assertActor, assertHash, assertScope, assertText, iso, optionalIso, safeInteger } from "./internal.js";

interface AnnotationRow {
  id: string; tenant_id: string; integration_id: string; source_run_id: string; trace_link_id: string;
  remote_score_id: string; content_hash: string; score_json: Record<string, unknown>; state: QualityAnnotationState;
  imported_by_actor_type: "service" | "system"; imported_by_actor_id: string;
  review_command_key: string | null; reviewed_by_actor_type: QualityActor["actorType"] | null;
  reviewed_by_actor_id: string | null; reviewed_at: Date | null;
  created_at: Date; updated_at: Date; version: string;
}

export class PgQualityAnnotationStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async importScore(scope: QualityScope, input: ImportQualityAnnotationInput): Promise<QualityAnnotationImport> {
    validateImport(scope, input);
    return this.db.transaction(scope.tenantId, async (client) => {
      const inserted = await client.query<AnnotationRow>(
        `INSERT INTO pr_agent_harness.quality_annotation_imports
           (tenant_id,integration_id,source_run_id,trace_link_id,remote_score_id,content_hash,
            score_json,imported_by_actor_type,imported_by_actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (tenant_id,integration_id,remote_score_id) DO NOTHING RETURNING *`,
        [scope.tenantId, scope.integrationId, input.sourceRunId, input.traceLinkId, input.remoteScoreId,
          input.contentHash, JSON.stringify(input.score), input.actor.actorType, input.actor.actorId]);
      if (inserted.rows[0]) return mapAnnotation(inserted.rows[0]);
      const existing = await client.query<AnnotationRow>(
        `SELECT * FROM pr_agent_harness.quality_annotation_imports
         WHERE tenant_id=$1 AND integration_id=$2 AND remote_score_id=$3`,
        [scope.tenantId, scope.integrationId, input.remoteScoreId]);
      const row = existing.rows[0];
      if (!row || row.content_hash !== input.contentHash || row.source_run_id !== input.sourceRunId
          || row.trace_link_id !== input.traceLinkId) {
        throw new QualityStorageConflictError("Remote annotation identity was reused with different content");
      }
      return mapAnnotation(row);
    });
  }

  async list(scope: QualityScope, filter: { state?: QualityAnnotationState; sourceRunId?: string;
    limit?: number } = {}): Promise<QualityAnnotationImport[]> {
    assertScope(scope); const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid annotation list limit");
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<AnnotationRow>(
        `SELECT * FROM pr_agent_harness.quality_annotation_imports
         WHERE tenant_id=$1 AND integration_id=$2 AND ($3::text IS NULL OR state=$3)
           AND ($4::uuid IS NULL OR source_run_id=$4)
         ORDER BY created_at DESC,id DESC LIMIT $5`,
        [scope.tenantId, scope.integrationId, filter.state ?? null, filter.sourceRunId ?? null, limit]);
      return result.rows.map(mapAnnotation);
    });
  }

  async read(scope: QualityScope, annotationId: string): Promise<QualityAnnotationImport> {
    assertScope(scope);
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<AnnotationRow>(
        `SELECT * FROM pr_agent_harness.quality_annotation_imports
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
        [scope.tenantId, scope.integrationId, annotationId]);
      if (!result.rows[0]) throw new QualityStorageNotFoundError("Imported annotation was not found");
      return mapAnnotation(result.rows[0]);
    });
  }

  async review(scope: QualityScope, input: { annotationId: string; expectedContentHash: string;
    decision: "promoted" | "rejected"; reviewer: QualityActor; commandKey: string }): Promise<QualityAnnotationImport> {
    assertScope(scope); assertHash(input.expectedContentHash, "expected content hash");
    assertActor(input.reviewer); assertText(input.commandKey, "review command key", 240);
    return this.db.transaction(scope.tenantId,
      (client) => this.reviewInTransaction(client, scope, input));
  }

  async lockForReviewInTransaction(client: PoolClient, scope: QualityScope,
    annotationId: string): Promise<QualityAnnotationImport> {
    assertScope(scope);
    const current = await client.query<AnnotationRow>(
      `SELECT * FROM pr_agent_harness.quality_annotation_imports
       WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
      [scope.tenantId, scope.integrationId, annotationId]);
    if (!current.rows[0]) throw new QualityStorageNotFoundError("Imported annotation was not found");
    return mapAnnotation(current.rows[0]);
  }

  async reviewInTransaction(client: PoolClient, scope: QualityScope, input: { annotationId: string;
    expectedContentHash: string; decision: "promoted" | "rejected"; reviewer: QualityActor;
    commandKey: string }): Promise<QualityAnnotationImport> {
    assertScope(scope); assertHash(input.expectedContentHash, "expected content hash");
    assertActor(input.reviewer); assertText(input.commandKey, "review command key", 240);
    const row = await this.lockForReviewInTransaction(client, scope, input.annotationId);
    if (row.reviewCommandKey === input.commandKey) {
      if (row.contentHash !== input.expectedContentHash || row.state !== input.decision
          || row.reviewedBy?.actorType !== input.reviewer.actorType
          || row.reviewedBy.actorId !== input.reviewer.actorId) {
        throw new QualityStorageConflictError("Annotation review command was reused with different content");
      }
      return row;
    }
    if (row.state !== "pending_review" || row.contentHash !== input.expectedContentHash) {
      throw new QualityStorageConflictError("Imported annotation no longer matches the pending content");
    }
    const updated = await client.query<AnnotationRow>(
      `UPDATE pr_agent_harness.quality_annotation_imports SET state=$4,review_command_key=$5,
         reviewed_by_actor_type=$6,reviewed_by_actor_id=$7,reviewed_at=clock_timestamp(),
         updated_at=clock_timestamp(),version=version+1
       WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND state='pending_review'
         AND content_hash=$8 RETURNING *`,
      [scope.tenantId, scope.integrationId, input.annotationId, input.decision, input.commandKey,
        input.reviewer.actorType, input.reviewer.actorId, input.expectedContentHash]);
    if (!updated.rows[0]) throw new QualityStorageConflictError("Annotation review lost its content CAS");
    return mapAnnotation(updated.rows[0]);
  }

  async purgeRejected(scope: QualityScope, input: { before: Date; limit?: number }): Promise<number> {
    assertScope(scope); const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 || !Number.isFinite(input.before.getTime())) {
      throw new Error("invalid annotation retention request");
    }
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<{ count: number }>(
        `WITH candidates AS (
           SELECT id FROM pr_agent_harness.quality_annotation_imports
           WHERE tenant_id=$1 AND integration_id=$2 AND state='rejected' AND reviewed_at<$3
           ORDER BY reviewed_at,id LIMIT $4
         ), deleted AS (
           DELETE FROM pr_agent_harness.quality_annotation_imports a USING candidates c WHERE a.id=c.id RETURNING 1
         ) SELECT count(*)::int AS count FROM deleted`, [scope.tenantId, scope.integrationId, input.before, limit]);
      return result.rows[0]?.count ?? 0;
    });
  }
}

function validateImport(scope: QualityScope, input: ImportQualityAnnotationInput): void {
  assertScope(scope); assertActor(input.actor); assertText(input.remoteScoreId, "remote score id", 240);
  assertHash(input.contentHash, "annotation content hash");
  if (input.actor.actorType !== "service" && input.actor.actorType !== "system") {
    throw new Error("annotation imports require a service or system actor");
  }
}
function mapAnnotation(row: AnnotationRow): QualityAnnotationImport {
  return { id: row.id, scope: { tenantId: row.tenant_id, integrationId: row.integration_id },
    sourceRunId: row.source_run_id, traceLinkId: row.trace_link_id, remoteScoreId: row.remote_score_id,
    contentHash: row.content_hash, score: row.score_json, state: row.state,
    importedBy: { actorType: row.imported_by_actor_type, actorId: row.imported_by_actor_id },
    reviewedBy: row.reviewed_by_actor_type && row.reviewed_by_actor_id
      ? { actorType: row.reviewed_by_actor_type, actorId: row.reviewed_by_actor_id } : undefined,
    reviewCommandKey: row.review_command_key ?? undefined, reviewedAt: optionalIso(row.reviewed_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    version: safeInteger(row.version, "annotation version") };
}
