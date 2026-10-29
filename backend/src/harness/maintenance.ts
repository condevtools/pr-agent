import type { Pool, PoolClient } from "pg";

import { appendRunFact } from "./run-events.js";

export interface RetentionRequest {
  tenantId: string;
  olderThanDays?: number;
  limit?: number;
}

export interface RetentionCandidate {
  runId: string;
  finishedAt: string;
  eventCount: number;
  alreadyPurged: boolean;
}

export interface RetentionResult {
  cutoff: string;
  examined: number;
  applied: number;
  candidates: RetentionCandidate[];
}

export class HarnessMaintenanceStore {
  constructor(private readonly pool: Pool) {}

  async preview(request: RetentionRequest): Promise<RetentionResult> {
    const normalized = normalizeRequest(request);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await administrativeIdentity(client);
      const cutoff = await databaseCutoff(client, normalized.olderThanDays);
      const candidates = await selectCandidates(client, normalized, cutoff, false);
      await client.query("COMMIT");
      return { cutoff: cutoff.toISOString(), examined: candidates.length,
        applied: 0, candidates };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async apply(request: RetentionRequest): Promise<RetentionResult> {
    const normalized = normalizeRequest(request);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const administrator = await administrativeIdentity(client);
      const cutoff = await databaseCutoff(client, normalized.olderThanDays);
      const candidates = await selectCandidates(client, normalized, cutoff, true);
      let applied = 0;
      for (const candidate of candidates) {
        if (candidate.alreadyPurged) continue;
        if (!await lockAndConfirmPublicationResolved(
          client,
          normalized.tenantId,
          candidate.runId,
        )) continue;
        await client.query(
          `SELECT sequence FROM pr_agent_harness.run_events
           WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence FOR SHARE`,
          [normalized.tenantId, candidate.runId],
        );
        const run = await client.query<{ next_event_seq: string; event_retention_floor: string }>(
          `SELECT next_event_seq,event_retention_floor FROM pr_agent_harness.agent_runs
           WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [normalized.tenantId, candidate.runId],
        );
        if (!run.rows[0]) continue;
        const floor = Number(run.rows[0].next_event_seq);
        const previousFloor = Number(run.rows[0].event_retention_floor);
        await client.query(
          `DELETE FROM pr_agent_harness.run_events
           WHERE tenant_id=$1 AND run_id=$2 AND sequence<$3`,
          [normalized.tenantId, candidate.runId, floor],
        );
        await scrubRunContent(client, normalized.tenantId, candidate.runId, floor);
        await appendRunFact(client, {
          tenantId: normalized.tenantId,
          runId: candidate.runId,
          eventType: "maintenance.retention_applied",
          eventKey: `retention:${floor}`,
          visibility: "internal",
          actorType: "system",
          actorId: administrator,
          payload: { reasonCode: "retention_policy", eventRetentionFloor: floor },
        });
        await client.query(
          `INSERT INTO pr_agent_harness.audit_logs
             (tenant_id,run_id,actor_type,actor_id,action,decision,reason_code,
              resource_type,resource_ref,details_json)
           VALUES ($1,$2,'database_role',$3,'harness.retention_apply','allowed',
             'retention_policy','agent_run',$5,$4::jsonb)`,
          [normalized.tenantId, candidate.runId, administrator,
            JSON.stringify({ cutoff: cutoff.toISOString(), previousEventRetentionFloor: previousFloor,
              newEventRetentionFloor: floor }), candidate.runId],
        );
        applied += 1;
      }
      await client.query("COMMIT");
      return { cutoff: cutoff.toISOString(), examined: candidates.length,
        applied, candidates };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockAndConfirmPublicationResolved(
  client: PoolClient,
  tenantId: string,
  runId: string,
): Promise<boolean> {
  await client.query(
    `SELECT ro.business_operation_id
     FROM pr_agent_harness.run_publication_batches rpb
     JOIN pr_agent_harness.publication_batch_operations pbo
       ON pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id
     JOIN pr_agent_harness.repository_operations ro
       ON ro.tenant_id=pbo.tenant_id AND ro.business_operation_id=pbo.business_operation_id
     WHERE rpb.tenant_id=$1 AND rpb.run_id=$2
     ORDER BY ro.business_operation_id
     FOR SHARE OF ro`,
    [tenantId, runId],
  );
  const unresolved = await client.query(
    `SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
     JOIN pr_agent_harness.publication_batches pb
       ON pb.tenant_id=rpb.tenant_id AND pb.id=rpb.batch_id
     JOIN pr_agent_harness.publication_batch_operations pbo
       ON pbo.tenant_id=pb.tenant_id AND pbo.batch_id=pb.id
     JOIN pr_agent_harness.repository_operations ro
       ON ro.tenant_id=pbo.tenant_id AND ro.business_operation_id=pbo.business_operation_id
     WHERE rpb.tenant_id=$1 AND rpb.run_id=$2
       AND (pb.status IN ('pending','waiting_reconciliation')
         OR ro.status IN ('prepared','in_flight','unknown','manual_review'))
     LIMIT 1`,
    [tenantId, runId],
  );
  return unresolved.rowCount === 0;
}

async function selectCandidates(
  client: PoolClient,
  request: NormalizedRetentionRequest,
  cutoff: Date,
  lock: boolean,
): Promise<RetentionCandidate[]> {
  const result = await client.query<{
    id: string; finished_at: Date; event_count: string; content_purged_at: Date | null;
  }>(
    `SELECT r.id,r.finished_at,r.content_purged_at,
            (SELECT count(*) FROM pr_agent_harness.run_events e
             WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id) AS event_count
     FROM pr_agent_harness.agent_runs r
     WHERE r.tenant_id=$1 AND r.status IN ('succeeded','failed','cancelled')
       AND r.content_purged_at IS NULL
       AND r.finished_at<$2
       AND NOT EXISTS (
         SELECT 1 FROM pr_agent_harness.run_publication_batches rpb
         JOIN pr_agent_harness.publication_batches pb
           ON pb.tenant_id=rpb.tenant_id AND pb.id=rpb.batch_id
         JOIN pr_agent_harness.publication_batch_operations pbo
           ON pbo.tenant_id=pb.tenant_id AND pbo.batch_id=pb.id
         JOIN pr_agent_harness.repository_operations ro
           ON ro.tenant_id=pbo.tenant_id AND ro.business_operation_id=pbo.business_operation_id
         WHERE rpb.tenant_id=r.tenant_id AND rpb.run_id=r.id
           AND (pb.status IN ('pending','waiting_reconciliation')
             OR ro.status IN ('prepared','in_flight','unknown','manual_review'))
       )
       AND NOT EXISTS (
         SELECT 1 FROM pr_agent_harness.model_budget_reservations mbr
         WHERE mbr.tenant_id=r.tenant_id AND mbr.run_id=r.id
           AND mbr.status IN ('reserved','pending')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pr_agent_harness.model_calls mc
         WHERE mc.tenant_id=r.tenant_id AND mc.run_id=r.id
           AND mc.status IN ('prepared','in_flight','unknown')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pr_agent_harness.run_budget_envelopes rbe
         WHERE rbe.tenant_id=r.tenant_id AND rbe.run_id=r.id
           AND rbe.status<>'closed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM pr_agent_harness.agent_runs child
         WHERE child.tenant_id=r.tenant_id AND child.parent_run_id=r.id
           AND child.status NOT IN ('succeeded','failed','cancelled')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pr_agent_harness.fix_approval_requests far
         WHERE far.tenant_id=r.tenant_id AND far.proposal_run_id=r.id
           AND ((far.status IN ('open','approved') AND far.expires_at>clock_timestamp())
             OR EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs publish
               WHERE publish.tenant_id=far.tenant_id AND publish.id=far.approved_publish_run_id
                 AND publish.status NOT IN ('succeeded','failed','cancelled')))
       )
     ORDER BY r.finished_at,r.id LIMIT $3
     ${lock ? "FOR UPDATE OF r SKIP LOCKED" : ""}`,
    [request.tenantId, cutoff, request.limit],
  );
  return result.rows.map((row) => ({ runId: row.id, finishedAt: row.finished_at.toISOString(),
    eventCount: Number(row.event_count), alreadyPurged: row.content_purged_at !== null }));
}

async function scrubRunContent(
  client: PoolClient,
  tenantId: string,
  runId: string,
  floor: number,
): Promise<void> {
  await client.query(
    `UPDATE pr_agent_harness.agent_runs
     SET input_json='{}'::jsonb,content_purged_at=clock_timestamp(),event_retention_floor=$3,
         updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId, floor],
  );
  await client.query(
    `UPDATE pr_agent_harness.agent_steps
     SET output_json='{}'::jsonb,content_purged_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.checkpoints
     SET state_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.tool_calls
     SET result_ref=NULL,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.model_calls
     SET request_metadata_json='{}'::jsonb,response_json=CASE WHEN response_json IS NULL THEN NULL ELSE '{}'::jsonb END,
         content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.usage_records
     SET original_usage_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.evidence_records
     SET summary='',result_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.finding_candidates
     SET record_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.finding_decisions
     SET record_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.review_artifacts
     SET artifact_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE pr_agent_harness.fix_run_sources
     SET source_json='{}'::jsonb,allowed_paths_json='[]'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId]);
  await client.query(
    `UPDATE pr_agent_harness.fix_proposals
     SET code_patch='',test_patch='',proposal_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId]);
  await client.query(
    `UPDATE pr_agent_harness.verification_jobs
     SET result_json=CASE WHEN result_json IS NULL THEN NULL ELSE '{}'::jsonb END,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId]);
  await client.query(
    `UPDATE pr_agent_harness.fix_verifications
     SET result_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId]);
  await client.query(
    `UPDATE pr_agent_harness.fix_artifacts
     SET artifact_json='{}'::jsonb,content_purged_at=clock_timestamp()
     WHERE tenant_id=$1 AND run_id=$2 AND content_purged_at IS NULL`, [tenantId, runId]);
}

async function administrativeIdentity(client: PoolClient): Promise<string> {
  const authority = await client.query<{ allowed: boolean; role_name: string }>(
    `SELECT (r.rolsuper OR r.rolbypassrls) AS allowed,r.rolname AS role_name
     FROM pg_roles r WHERE r.rolname=current_user`,
  );
  if (!authority.rows[0]?.allowed) {
    throw new Error("Harness retention requires an administrative PostgreSQL role");
  }
  return authority.rows[0].role_name;
}

async function databaseCutoff(client: PoolClient, olderThanDays: number): Promise<Date> {
  const result = await client.query<{ cutoff: Date }>(
    "SELECT clock_timestamp()-($1::double precision*interval '1 day') AS cutoff",
    [olderThanDays],
  );
  return result.rows[0]!.cutoff;
}

interface NormalizedRetentionRequest {
  tenantId: string;
  olderThanDays: number;
  limit: number;
}

function normalizeRequest(request: RetentionRequest): NormalizedRetentionRequest {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.tenantId)) {
    throw new Error("tenantId must be a UUID");
  }
  const days = request.olderThanDays ?? 30;
  if (!Number.isSafeInteger(days) || days < 7 || days > 3650) {
    throw new Error("retention age must be an integer between 7 and 3650 days");
  }
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("retention limit must be an integer between 1 and 1000");
  }
  return { tenantId: request.tenantId, olderThanDays: days, limit };
}
