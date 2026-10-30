import type { Pool } from "pg";

export type MaintenanceAction = "preview" | "apply";

export interface MaintenancePolicy {
  action: MaintenanceAction;
  contentDays: number;
  replayDays: number;
  traceDays: number;
  batchLimit: number;
}

export interface MaintenanceCycleResult {
  schemaVersion: 1;
  action: MaintenanceAction;
  candidates: Record<string, number>;
  applied: Record<string, number>;
}

/** The maintenance role has no table privileges; this function is its only data-plane entrypoint. */
export class PeriodicMaintenanceStore {
  constructor(private readonly pool: Pool) {}

  async run(cycleId: string, policy: MaintenancePolicy): Promise<MaintenanceCycleResult> {
    const result = await this.pool.query<{ result: MaintenanceCycleResult }>(
      `SELECT pr_agent_harness.run_retention_maintenance(
         $1::uuid,$2::text,$3::integer,$4::integer,$5::integer,$6::integer
       ) AS result`,
      [cycleId, policy.action, policy.contentDays, policy.replayDays,
        policy.traceDays, policy.batchLimit],
    );
    if (!result.rows[0]?.result) throw new Error("Maintenance cycle returned no receipt");
    return result.rows[0].result;
  }
}
