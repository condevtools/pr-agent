import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

import { addedLineNumbers } from "../review/deep/run.js";
import type { RuntimeDatabase } from "../agent-runtime/postgres/database.js";
import type { RunPrincipal } from "../agent-runtime/runs/control-contracts.js";
import { runConflict, runNotFound } from "../agent-runtime/runs/control-contracts.js";
import { fingerprint } from "../agent-runtime/versions.js";
import { redactRepositoryText } from "../integrations/shared/repository-read-tools.js";
import {
  annotationRequestSchema, arbitrationRequestSchema, canonicalizeLabelSet, feedbackObservationSchema,
  labelSetHash, type AnnotationReceipt, type AnnotationRequest, type ArbitrationReceipt,
  type ArbitrationRequest, type FeedbackObservationRequest, type FeedbackReceipt, type TrustedLabelSetV1,
} from "./feedback-contracts.js";

const collectedSourceSchema = z.object({ files: z.array(z.object({
  newPath: z.string().min(1).max(512), patch: z.string().max(2_000_000),
}).passthrough()).max(2_000) }).passthrough();

interface EligibleSource {
  artifactHash: string;
  artifactId: string;
  changedLines?: Map<string, Set<number>>;
}

export class FeedbackStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async recordObservation(principal: RunPrincipal, sourceRunId: string, commandKey: string,
    raw: unknown): Promise<FeedbackReceipt> {
    const parsed = feedbackObservationSchema.parse(raw);
    const request = { ...parsed, comment: parsed.comment === undefined ? undefined : redactRepositoryText(parsed.comment) };
    const requestHash = fingerprint(request);
    return this.db.transaction(principal.tenantId, async (client) => {
      const source = await eligibleSource(client, principal, sourceRunId, request.artifactHash, false, true, false);
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO pr_agent_harness.feedback_observations
           (tenant_id,integration_id,source_run_id,artifact_hash,command_key,request_hash,
            actor_type,actor_id,observation_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (tenant_id,source_run_id,command_key) DO NOTHING RETURNING id,created_at`,
        [principal.tenantId, principal.integrationId, sourceRunId, source.artifactHash, commandKey, requestHash,
          principal.actorType, principal.subjectId, JSON.stringify(request)]);
      if (inserted.rows[0]) return feedbackReceipt(inserted.rows[0], sourceRunId, source.artifactHash);
      const existing = await client.query<{ id: string; request_hash: string; artifact_hash: string; created_at: Date }>(
        `SELECT id,request_hash,artifact_hash,created_at FROM pr_agent_harness.feedback_observations
         WHERE tenant_id=$1 AND source_run_id=$2 AND command_key=$3`,
        [principal.tenantId, sourceRunId, commandKey]);
      const row = existing.rows[0];
      if (!row || row.request_hash !== requestHash) throw runConflict("Feedback idempotency key was reused with different content");
      return feedbackReceipt(row, sourceRunId, row.artifact_hash);
    });
  }

  async createAnnotation(principal: RunPrincipal, sourceRunId: string, commandKey: string,
    raw: unknown): Promise<AnnotationReceipt> {
    const parsed = annotationRequestSchema.parse(raw);
    const request: AnnotationRequest = { ...parsed, provenance: { ...parsed.provenance,
      notes: parsed.provenance.notes === undefined ? undefined : redactRepositoryText(parsed.provenance.notes) } };
    const labels = canonicalizeLabelSet(request.labelSet);
    const labelsHash = labelSetHash(labels);
    const requestHash = fingerprint({ ...request, labelSet: labels });
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockTenantEvolution(client, principal.tenantId);
      const source = await eligibleSource(client, principal, sourceRunId, request.artifactHash, true, true, true);
      validateChangedLocations(labels, source.changedLines!);
      const duplicate = await existingAnnotation(client, principal.tenantId, sourceRunId, commandKey);
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw runConflict("Annotation idempotency key was reused with different content");
        return annotationReceipt(client, duplicate, sourceRunId, source.artifactHash, principal);
      }
      const active = await client.query<{ id: string }>(
        `SELECT id FROM pr_agent_harness.review_annotations
         WHERE tenant_id=$1 AND source_run_id=$2 AND rubric_version='review-quality.v1'
           AND actor_type=$3 AND actor_id=$4 AND superseded_by_annotation_id IS NULL FOR UPDATE`,
        [principal.tenantId, sourceRunId, principal.actorType, principal.subjectId]);
      const current = active.rows[0];
      if ((current?.id ?? undefined) !== request.supersedesAnnotationId) {
        throw runConflict("Annotation revision must supersede the actor's exact active annotation");
      }
      const id = randomUUID();
      if (current) await client.query(
        `UPDATE pr_agent_harness.review_annotations SET superseded_by_annotation_id=$4
         WHERE tenant_id=$1 AND source_run_id=$2 AND id=$3 AND superseded_by_annotation_id IS NULL`,
        [principal.tenantId, sourceRunId, current.id, id]);
      if (current) await client.query(
        `UPDATE pr_agent_harness.trusted_review_label_sets SET active=false
         WHERE tenant_id=$1 AND source_run_id=$2 AND rubric_version='review-quality.v1' AND active`,
        [principal.tenantId, sourceRunId]);
      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO pr_agent_harness.review_annotations
           (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,label_set_json,
            provenance_json,actor_type,actor_id,command_key,request_hash,supersedes_annotation_id)
         VALUES ($1,$2,$3,$4,$5,'review-quality.v1',$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
         RETURNING created_at`,
        [id, principal.tenantId, principal.integrationId, sourceRunId, source.artifactHash, labelsHash,
          JSON.stringify(labels), JSON.stringify({ ...request.provenance, actor: actor(principal) }),
          principal.actorType, principal.subjectId, commandKey, requestHash, request.supersedesAnnotationId ?? null]);
      const trustedLabelSetId = await createConsensusIfExact(client, principal, sourceRunId, source.artifactHash,
        labelsHash, current !== undefined);
      return { id, sourceRunId, artifactHash: source.artifactHash, rubricVersion: "review-quality.v1", labelSetHash: labelsHash,
        actor: actor(principal), supersedesAnnotationId: request.supersedesAnnotationId, trustedLabelSetId,
        createdAt: inserted.rows[0]!.created_at.toISOString() };
    });
  }

  async arbitrate(principal: RunPrincipal, sourceRunId: string, commandKey: string,
    raw: unknown): Promise<ArbitrationReceipt> {
    const parsed = arbitrationRequestSchema.parse(raw);
    const request: ArbitrationRequest = { ...parsed, reason: redactRepositoryText(parsed.reason) };
    const requestHash = fingerprint(request);
    return this.db.transaction(principal.tenantId, async (client) => {
      await lockTenantEvolution(client, principal.tenantId);
      const source = await eligibleSource(client, principal, sourceRunId, request.artifactHash, false, true, true);
      const duplicate = await client.query<{ id: string; request_hash: string; chosen_label_set_hash: string; created_at: Date }>(
        `SELECT id,request_hash,chosen_label_set_hash,created_at
         FROM pr_agent_harness.review_annotation_arbitrations
         WHERE tenant_id=$1 AND source_run_id=$2 AND command_key=$3`,
        [principal.tenantId, sourceRunId, commandKey]);
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) throw runConflict("Arbitration idempotency key was reused with different content");
        const trusted = await client.query<{ id: string }>(
          `SELECT id FROM pr_agent_harness.trusted_review_label_sets
           WHERE tenant_id=$1 AND source_run_id=$2 AND arbitration_id=$3`,
          [principal.tenantId, sourceRunId, duplicate.rows[0].id]).then(({ rows }) => rows[0]);
        if (!trusted) throw runConflict("Arbitration receipt has no trusted label set");
        return { id: duplicate.rows[0].id, sourceRunId, chosenLabelSetHash: duplicate.rows[0].chosen_label_set_hash,
          trustedLabelSetId: trusted.id, createdAt: duplicate.rows[0].created_at.toISOString() };
      }
      if (await trustedLabel(client, principal.tenantId, sourceRunId)) throw runConflict("A trusted label set already exists");
      const annotations = await client.query<AnnotationRow>(
        `SELECT id,label_set_hash,label_set_json,actor_type,actor_id FROM pr_agent_harness.review_annotations
         WHERE tenant_id=$1 AND integration_id=$2 AND source_run_id=$3
           AND id=ANY($4::uuid[]) AND rubric_version=$5 AND artifact_hash=$6
           AND superseded_by_annotation_id IS NULL AND content_purged_at IS NULL FOR UPDATE`,
        [principal.tenantId, principal.integrationId, sourceRunId,
          [request.leftAnnotationId, request.rightAnnotationId], request.rubricVersion, source.artifactHash]);
      if (annotations.rows.length !== 2) throw runConflict("Arbitration annotations are unavailable or no longer active");
      const byId = new Map(annotations.rows.map((row) => [row.id, row]));
      const left = byId.get(request.leftAnnotationId); const right = byId.get(request.rightAnnotationId);
      if (!left || !right || left.label_set_hash !== request.leftLabelSetHash
          || right.label_set_hash !== request.rightLabelSetHash
          || left.label_set_hash === right.label_set_hash
          || ![left.label_set_hash, right.label_set_hash].includes(request.chosenLabelSetHash)) {
        throw runConflict("Arbitration must bind two exact conflicting annotation hashes");
      }
      const arbitrator = `${principal.actorType}:${principal.subjectId}`;
      if ([left, right].some((row) => `${row.actor_type}:${row.actor_id}` === arbitrator)) {
        throw runConflict("Arbitration requires a third independent actor");
      }
      const arbitrationId = randomUUID();
      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO pr_agent_harness.review_annotation_arbitrations
           (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,
            left_annotation_id,left_label_set_hash,right_annotation_id,right_label_set_hash,chosen_label_set_hash,
            actor_type,actor_id,command_key,request_hash,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING created_at`,
        [arbitrationId, principal.tenantId, principal.integrationId, sourceRunId, source.artifactHash,
          request.rubricVersion, left.id, left.label_set_hash, right.id, right.label_set_hash,
          request.chosenLabelSetHash, principal.actorType, principal.subjectId, commandKey, requestHash, request.reason]);
      const chosen = request.chosenLabelSetHash === left.label_set_hash ? left : right;
      const trustedId = await insertTrustedLabel(client, principal, sourceRunId, source.artifactHash,
        chosen.label_set_hash, chosen.label_set_json, "arbitration",
        { arbitrationId, leftAnnotationId: left.id, rightAnnotationId: right.id }, arbitrationId);
      return { id: arbitrationId, sourceRunId, chosenLabelSetHash: chosen.label_set_hash,
        trustedLabelSetId: trustedId, createdAt: inserted.rows[0]!.created_at.toISOString() };
    });
  }
}

async function lockTenantEvolution(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1830))", [tenantId]);
}

interface AnnotationRow {
  id: string; label_set_hash: string; label_set_json: TrustedLabelSetV1;
  actor_type: "user" | "service"; actor_id: string;
}
interface ExistingAnnotation extends AnnotationRow {
  request_hash: string; artifact_hash: string; supersedes_annotation_id: string | null; created_at: Date;
}

async function eligibleSource(client: PoolClient, principal: RunPrincipal, sourceRunId: string,
  artifactHash: string, includeDiff: boolean, lockRun = false, requireCompleteCoverage = false): Promise<EligibleSource> {
  const result = await client.query<{ artifact_id: string; content_hash: string; artifact_json: unknown; source_json: unknown }>(
    `SELECT a.id AS artifact_id,a.content_hash,a.artifact_json,
            ${includeDiff ? "s.output_json->'value'" : "NULL::jsonb"} AS source_json
     FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.review_artifacts a
       ON a.tenant_id=r.tenant_id AND a.integration_id=r.integration_id AND a.run_id=r.id AND a.content_purged_at IS NULL
     ${includeDiff ? `JOIN LATERAL (SELECT output_json FROM pr_agent_harness.agent_steps
       WHERE tenant_id=r.tenant_id AND run_id=r.id AND step_key IN ('github.collect_context.v1','gitlab.collect_context.v1')
         AND status='succeeded' ORDER BY completed_at DESC LIMIT 1) s ON true` : ""}
     WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3
       AND r.run_type='review.deep.v1' AND r.status='succeeded' AND r.content_purged_at IS NULL
     ${lockRun ? "FOR UPDATE OF r" : ""}`,
    [principal.tenantId, principal.integrationId, sourceRunId]);
  const row = result.rows[0];
  if (!row) throw runNotFound();
  if (row.content_hash !== artifactHash || fingerprint(row.artifact_json) !== row.content_hash) {
    throw runConflict("Source review artifact hash does not match the immutable artifact");
  }
  const coverageStatus = z.object({ sourceCoverage: z.object({ status: z.string() }).passthrough() }).passthrough()
    .safeParse(row.artifact_json);
  if (requireCompleteCoverage && (!coverageStatus.success || coverageStatus.data.sourceCoverage.status !== "complete")) {
    throw runConflict("Complete source coverage is required for trusted annotations");
  }
  if (!includeDiff) return { artifactId: row.artifact_id, artifactHash: row.content_hash };
  const collected = collectedSourceSchema.parse(row.source_json);
  const changedLines = new Map<string, Set<number>>();
  for (const file of collected.files) changedLines.set(file.newPath, new Set(addedLineNumbers(file.patch)));
  return { artifactId: row.artifact_id, artifactHash: row.content_hash, changedLines };
}

function validateChangedLocations(labels: TrustedLabelSetV1, changed: Map<string, Set<number>>): void {
  for (const finding of labels.expectedFindings) {
    const lines = changed.get(finding.path);
    if (!lines || ![...lines].some((line) => line >= finding.startLine && line <= finding.endLine)) {
      throw runConflict("Every expected finding must overlap a persisted changed line");
    }
  }
}

async function existingAnnotation(client: PoolClient, tenantId: string, runId: string,
  commandKey: string): Promise<ExistingAnnotation | undefined> {
  return (await client.query<ExistingAnnotation>(
    `SELECT id,request_hash,artifact_hash,label_set_hash,label_set_json,actor_type,actor_id,
            supersedes_annotation_id,created_at
     FROM pr_agent_harness.review_annotations WHERE tenant_id=$1 AND source_run_id=$2 AND command_key=$3`,
    [tenantId, runId, commandKey])).rows[0];
}

async function annotationReceipt(client: PoolClient, row: ExistingAnnotation, sourceRunId: string,
  artifactHash: string, principal: RunPrincipal): Promise<AnnotationReceipt> {
  const trusted = await trustedLabel(client, principal.tenantId, sourceRunId);
  return { id: row.id, sourceRunId, artifactHash, rubricVersion: "review-quality.v1",
    labelSetHash: row.label_set_hash, actor: { type: row.actor_type, id: row.actor_id },
    supersedesAnnotationId: row.supersedes_annotation_id ?? undefined,
    trustedLabelSetId: trusted?.id, createdAt: row.created_at.toISOString() };
}

async function createConsensusIfExact(client: PoolClient, principal: RunPrincipal, sourceRunId: string,
  artifactHash: string, newLabelSetHash: string, currentRevision: boolean): Promise<string | undefined> {
  const annotations = await client.query<AnnotationRow>(
    `SELECT id,label_set_hash,label_set_json,actor_type,actor_id FROM pr_agent_harness.review_annotations
     WHERE tenant_id=$1 AND integration_id=$2 AND source_run_id=$3 AND rubric_version='review-quality.v1'
       AND superseded_by_annotation_id IS NULL AND content_purged_at IS NULL ORDER BY created_at,id FOR UPDATE`,
    [principal.tenantId, principal.integrationId, sourceRunId]);
  const hashes = new Set(annotations.rows.map((row) => row.label_set_hash));
  const existing = await trustedLabel(client, principal.tenantId, sourceRunId, true);
  if (existing && !currentRevision && existing.label_set_hash === newLabelSetHash) return existing.id;
  if (existing) {
    await client.query(
      `UPDATE pr_agent_harness.trusted_review_label_sets SET active=false
       WHERE tenant_id=$1 AND source_run_id=$2 AND rubric_version='review-quality.v1' AND id=$3 AND active`,
      [principal.tenantId, sourceRunId, existing.id]);
  }
  if (annotations.rows.length < 2 || hashes.size !== 1) return undefined;
  const actors = new Set(annotations.rows.map((row) => `${row.actor_type}:${row.actor_id}`));
  if (actors.size < 2) return undefined;
  const first = annotations.rows[0]!; const ids = annotations.rows.slice(0, 2).map(({ id }) => id);
  return insertTrustedLabel(client, principal, sourceRunId, artifactHash, first.label_set_hash,
    first.label_set_json, "consensus", { annotationIds: ids }, null);
}

async function insertTrustedLabel(client: PoolClient, principal: RunPrincipal, sourceRunId: string,
  artifactHash: string, hash: string, labels: TrustedLabelSetV1, kind: "consensus" | "arbitration",
  resolution: Record<string, unknown>, arbitrationId: string | null): Promise<string> {
  const previous = await client.query<{ id: string; version: string }>(
    `SELECT id,version FROM pr_agent_harness.trusted_review_label_sets
     WHERE tenant_id=$1 AND source_run_id=$2 AND rubric_version='review-quality.v1'
     ORDER BY version DESC LIMIT 1`, [principal.tenantId, sourceRunId]);
  const id = randomUUID(); const prior = previous.rows[0];
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pr_agent_harness.trusted_review_label_sets
       (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,
        label_set_json,version,active,supersedes_label_set_id,resolution_kind,resolution_json,arbitration_id)
     VALUES ($1,$2,$3,$4,$5,'review-quality.v1',$6,$7::jsonb,$8,true,$9,$10,$11::jsonb,$12)
     ON CONFLICT (tenant_id,source_run_id,rubric_version) WHERE active DO NOTHING RETURNING id`,
    [id, principal.tenantId, principal.integrationId, sourceRunId, artifactHash, hash,
      JSON.stringify(labels), prior ? Number(prior.version) + 1 : 1, prior?.id ?? null,
      kind, JSON.stringify(resolution), arbitrationId]);
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await trustedLabel(client, principal.tenantId, sourceRunId);
  if (!existing || existing.label_set_hash !== hash) throw runConflict("Trusted label set was concurrently resolved differently");
  return existing.id;
}

async function trustedLabel(client: PoolClient, tenantId: string,
  sourceRunId: string, lock = false): Promise<{ id: string; label_set_hash: string } | undefined> {
  return (await client.query<{ id: string; label_set_hash: string }>(
    `SELECT id,label_set_hash FROM pr_agent_harness.trusted_review_label_sets
     WHERE tenant_id=$1 AND source_run_id=$2 AND rubric_version='review-quality.v1' AND active
     ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, sourceRunId])).rows[0];
}

function actor(principal: RunPrincipal) { return { type: principal.actorType, id: principal.subjectId }; }
function feedbackReceipt(row: { id: string; created_at: Date }, sourceRunId: string, artifactHash: string): FeedbackReceipt {
  return { id: row.id, sourceRunId, artifactHash, createdAt: row.created_at.toISOString() };
}
