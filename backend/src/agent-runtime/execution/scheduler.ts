import type { Pool } from "pg";

import type { PublicationAuthorityStore, PublicationBinding } from "../authority/publication-authority.js";

export type RuntimeQueueClass = "normal" | "publication_outcome" | "manual_resume" |
  "maintenance" | "recovery";

export interface RuntimeSchedulingRequest {
  queueClass: RuntimeQueueClass;
  limit: number;
  runtimeVersionHash?: string;
  supportedWorkflows?: readonly string[];
}

export class PgRunScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly authority: PublicationAuthorityStore,
    private readonly perBindingConcurrency = 2,
  ) {
    bounded(perBindingConcurrency, 1, 16, "per-binding worker concurrency");
  }

  async reserve(request: RuntimeSchedulingRequest): Promise<PublicationBinding[]> {
    const limit = bounded(request.limit, 1, 64, "scheduler reservation limit");
    const runtimeHash = request.runtimeVersionHash ?? "0".repeat(64);
    const workflows = request.supportedWorkflows ?? [];
    const result = await this.pool.query<{ tenant_id: string; integration_id: string }>(
      `SELECT tenant_id,integration_id
       FROM pr_agent_harness.reserve_runtime_bindings($1,$2,$3::text[],$4,$5)`,
      [request.queueClass, runtimeHash, workflows, limit, this.perBindingConcurrency],
    );
    return Promise.all(
      result.rows.map((row) => this.authority.get(row.tenant_id, row.integration_id)),
    );
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
