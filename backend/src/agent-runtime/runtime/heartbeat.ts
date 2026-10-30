import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { databaseTimingSnapshot } from "../database-timing.js";
import { ProcessHealthMarker } from "./process-health.js";

export type DurableProcessRole = "worker" | "recovery" | "verifier";

export interface ProcessHeartbeatConfiguration {
  intervalMs: number;
  staleAfterMs: number;
}

export interface ProcessHeartbeatSnapshot {
  fresh: boolean;
  capabilityReports: Record<string, unknown>[];
}

export function resolveProcessHeartbeatConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ProcessHeartbeatConfiguration {
  const intervalMs = strictInteger(env.RUNTIME_HEARTBEAT_INTERVAL_MS, 5_000,
    "RUNTIME_HEARTBEAT_INTERVAL_MS", 1_000, 60_000);
  const staleAfterMs = strictInteger(env.RUNTIME_HEARTBEAT_STALE_MS, 20_000,
    "RUNTIME_HEARTBEAT_STALE_MS", 3_000, 300_000);
  if (staleAfterMs < intervalMs * 2) {
    throw new Error("RUNTIME_HEARTBEAT_STALE_MS must be at least twice RUNTIME_HEARTBEAT_INTERVAL_MS");
  }
  return { intervalMs, staleAfterMs };
}

export class ProcessHeartbeatStore {
  constructor(private readonly pool: Pool) {}

  async beat(role: DurableProcessRole, instanceId: string, report: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "SELECT pr_agent_harness.record_runtime_process_heartbeat($1,$2,$3::jsonb)",
      [role, instanceId, JSON.stringify(report)],
    );
  }

  async remove(role: DurableProcessRole, instanceId: string): Promise<void> {
    await this.pool.query(
      "SELECT pr_agent_harness.remove_runtime_process_heartbeat($1,$2)",
      [role, instanceId],
    );
  }

  async freshness(staleAfterMs: number): Promise<Record<DurableProcessRole, ProcessHeartbeatSnapshot>> {
    const result = await this.pool.query<{
      process_role: DurableProcessRole;
      fresh: boolean;
      capability_reports: Record<string, unknown>[] | null;
    }>(
      `SELECT requested.process_role,
              EXISTS (SELECT 1 FROM pr_agent_harness.runtime_process_heartbeats h
                WHERE h.process_role=requested.process_role
                  AND h.heartbeat_at>clock_timestamp()-($1::double precision*interval '1 millisecond')) AS fresh,
              (SELECT jsonb_agg(fresh.capability_report ORDER BY fresh.heartbeat_at DESC)
               FROM (SELECT h.capability_report,h.heartbeat_at
                 FROM pr_agent_harness.runtime_process_heartbeats h
                 WHERE h.process_role=requested.process_role
                   AND h.heartbeat_at>clock_timestamp()-($1::double precision*interval '1 millisecond')
                 ORDER BY h.heartbeat_at DESC LIMIT 100) fresh) AS capability_reports
       FROM unnest(ARRAY['worker','recovery','verifier']::text[]) requested(process_role)`,
      [staleAfterMs],
    );
    return Object.fromEntries(result.rows.map((row) => [row.process_role, {
      fresh: row.fresh,
      capabilityReports: row.capability_reports ?? [],
    }])) as Record<DurableProcessRole, ProcessHeartbeatSnapshot>;
  }
}

export class ProcessHeartbeatLoop {
  readonly instanceId = randomUUID();
  private readonly health: ProcessHealthMarker;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private started = false;

  constructor(
    private readonly store: ProcessHeartbeatStore,
    readonly role: DurableProcessRole,
    private readonly report: Record<string, unknown>,
    private readonly configuration = resolveProcessHeartbeatConfiguration(),
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly automatic = true,
  ) { this.health = new ProcessHealthMarker(role, this.instanceId); }

  async start(): Promise<void> {
    if (this.stopped || this.started) return;
    this.started = true;
    await this.tick();
    if (this.automatic) {
      this.timer = setInterval(() => { void this.tick().catch(this.onError); }, this.configuration.intervalMs);
      this.timer.unref();
    }
  }

  async recordActivity(): Promise<void> { await this.tick(); }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    try { await this.active; }
    finally {
      try { await this.store.remove(this.role, this.instanceId); }
      finally { await this.health.clear(); }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.active) return;
    const active = (async () => {
      try {
        await this.store.beat(this.role, this.instanceId, {
          ...this.report, databaseTiming: databaseTimingSnapshot(),
        });
        await this.health.record();
      } catch (error) {
        await this.health.clear().catch(this.onError);
        throw error;
      }
    })();
    this.active = active;
    try { await active; }
    finally { if (this.active === active) this.active = undefined; }
  }
}

function strictInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || !raw.trim()) return fallback;
  if (!/^[0-9]+$/u.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
