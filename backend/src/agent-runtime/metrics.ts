import { RuntimeDatabase } from "./postgres/database.js";

const RUN_STATUSES = ["queued", "running", "waiting_for_user", "succeeded", "failed",
  "cancelled", "retry_wait", "waiting_for_reconciliation"] as const;

export interface RuntimeMetricsSnapshot {
  tenantId: string;
  integrationId: string;
  runs: Record<typeof RUN_STATUSES[number], number>;
  claimableJobs: number;
  oldestClaimableJobSeconds: number | null;
  expiredLeases: number;
  unresolvedPublications: number;
  pendingBudgetReservations: number;
  measuredAt: string;
}

export class RuntimeMetricsStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async snapshot(tenantId: string, integrationId: string): Promise<RuntimeMetricsSnapshot> {
    const result = await this.db.transaction(tenantId, (client) => client.query<{
      run_status: string; run_count: number; claimable_jobs: number;
      oldest_claimable_seconds: number | null; expired_leases: number;
      unresolved_publications: number; pending_budget_reservations: number; measured_at: Date;
    }>(
      `WITH scoped_runs AS (
         SELECT id,status,lease_expires_at FROM pr_agent_harness.agent_runs
         WHERE tenant_id=$1 AND integration_id=$2
       ), run_counts AS (
         SELECT status,count(*)::int AS count FROM scoped_runs GROUP BY status
       ), job_metrics AS (
         SELECT count(*) FILTER (WHERE j.status IN ('ready','retry_wait') AND j.available_at<=clock_timestamp())::int AS claimable,
                extract(epoch FROM clock_timestamp()-min(j.available_at)
                  FILTER (WHERE j.status IN ('ready','retry_wait') AND j.available_at<=clock_timestamp()))::double precision AS oldest
         FROM pr_agent_harness.job_queue j JOIN scoped_runs r ON r.id=j.run_id
       ), publication_metrics AS (
         SELECT count(DISTINCT ro.business_operation_id)::int AS unresolved
         FROM pr_agent_harness.repository_operations ro
         WHERE ro.tenant_id=$1 AND ro.integration_id=$2
           AND ro.status IN ('in_flight','unknown','manual_review')
       ), budget_metrics AS (
         SELECT count(*)::int AS pending
         FROM pr_agent_harness.model_budget_reservations mbr
         JOIN scoped_runs r ON r.id=mbr.run_id
         WHERE mbr.tenant_id=$1 AND mbr.status IN ('reserved','pending')
       )
       SELECT s.status AS run_status,COALESCE(rc.count,0)::int AS run_count,
              jm.claimable AS claimable_jobs,jm.oldest AS oldest_claimable_seconds,
              (SELECT count(*)::int FROM scoped_runs
               WHERE status='running' AND lease_expires_at<=clock_timestamp()) AS expired_leases,
              pm.unresolved AS unresolved_publications,bm.pending AS pending_budget_reservations,
              clock_timestamp() AS measured_at
       FROM unnest($3::text[]) s(status)
       LEFT JOIN run_counts rc ON rc.status=s.status
       CROSS JOIN job_metrics jm CROSS JOIN publication_metrics pm CROSS JOIN budget_metrics bm`,
      [tenantId, integrationId, [...RUN_STATUSES]],
    ));
    const first = result.rows[0];
    if (!first) throw new Error("Harness metrics query returned no status rows");
    const runs = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as RuntimeMetricsSnapshot["runs"];
    for (const row of result.rows) runs[row.run_status as keyof typeof runs] = row.run_count;
    return { tenantId, integrationId, runs, claimableJobs: first.claimable_jobs,
      oldestClaimableJobSeconds: first.oldest_claimable_seconds === null
        ? null : Math.max(0, first.oldest_claimable_seconds),
      expiredLeases: first.expired_leases, unresolvedPublications: first.unresolved_publications,
      pendingBudgetReservations: first.pending_budget_reservations,
      measuredAt: first.measured_at.toISOString() };
  }
}
