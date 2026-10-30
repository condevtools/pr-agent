import { createHash } from "node:crypto";

import type { RuntimeDatabase } from "../postgres/database.js";

export interface BusinessStateScope {
  tenantId: string;
  integrationId: string;
  platform: "github" | "gitlab";
  origin: string;
  repository: string;
}

export class PgBusinessStateStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async isRateLimited(scope: Pick<BusinessStateScope, "tenantId" | "integrationId"> & {
    key: string; limit: number; windowMs: number;
  }): Promise<boolean> {
    const key = scope.key.trim().slice(0, 512);
    const limit = Math.max(1, Math.min(1_000_000, Math.floor(scope.limit)));
    const windowMs = Math.max(1_000, Math.floor(scope.windowMs));
    if (!key) throw new Error("rate-limit key is required");
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<{ request_count: number }>(`
        INSERT INTO pr_agent_harness.command_rate_limits
          (tenant_id,integration_id,scope_key,window_started_at,request_count,expires_at)
        VALUES ($1,$2,$3,clock_timestamp(),1,clock_timestamp()+($4::bigint*interval '1 millisecond'))
        ON CONFLICT (tenant_id,integration_id,scope_key) DO UPDATE SET
          window_started_at=CASE WHEN command_rate_limits.expires_at<=clock_timestamp()
            THEN clock_timestamp() ELSE command_rate_limits.window_started_at END,
          request_count=CASE WHEN command_rate_limits.expires_at<=clock_timestamp()
            THEN 1 ELSE command_rate_limits.request_count+1 END,
          expires_at=CASE WHEN command_rate_limits.expires_at<=clock_timestamp()
            THEN clock_timestamp()+($4::bigint*interval '1 millisecond') ELSE command_rate_limits.expires_at END,
          updated_at=clock_timestamp()
        RETURNING request_count`, [scope.tenantId, scope.integrationId, key, windowMs]);
      return (result.rows[0]?.request_count ?? 1) > limit;
    });
  }

  async loadIncrementalHead(scope: BusinessStateScope & { target: string }): Promise<string | undefined> {
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<{ head_sha: string }>(`
        SELECT head_sha FROM pr_agent_harness.review_incremental_cursors
        WHERE tenant_id=$1 AND integration_id=$2 AND platform=$3 AND origin=$4 AND repository=$5 AND target=$6
          AND expires_at>clock_timestamp()`, [scope.tenantId, scope.integrationId, scope.platform,
        scope.origin, scope.repository, scope.target]);
      return result.rows[0]?.head_sha;
    });
  }

  async rememberIncrementalHead(scope: BusinessStateScope & { target: string; headSha: string; ttlMs: number }): Promise<void> {
    await this.db.transaction(scope.tenantId, (client) => client.query(`
      INSERT INTO pr_agent_harness.review_incremental_cursors
        (tenant_id,integration_id,platform,origin,repository,target,head_sha,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::bigint*interval '1 millisecond'))
      ON CONFLICT (tenant_id,integration_id,platform,origin,repository,target) DO UPDATE SET
        head_sha=EXCLUDED.head_sha,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp()`,
    [scope.tenantId, scope.integrationId, scope.platform, scope.origin, scope.repository, scope.target,
      scope.headSha, Math.max(1_000, Math.floor(scope.ttlMs))]));
  }

  async recordFeedbackSignal(scope: BusinessStateScope & { target: string; signal: string; ttlMs: number }): Promise<void> {
    const signal = scope.signal.trim().slice(0, 4_000);
    if (!signal) return;
    const hash = createHash("sha256").update(signal).digest("hex");
    await this.db.transaction(scope.tenantId, (client) => client.query(`
      INSERT INTO pr_agent_harness.review_feedback_signals
        (tenant_id,integration_id,platform,origin,repository,target,signal,signal_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+($9::bigint*interval '1 millisecond'))
      ON CONFLICT (tenant_id,integration_id,platform,origin,repository,target,signal_hash) DO UPDATE SET
        expires_at=EXCLUDED.expires_at`, [scope.tenantId, scope.integrationId, scope.platform, scope.origin,
      scope.repository, scope.target, signal, hash, Math.max(1_000, Math.floor(scope.ttlMs))]));
  }

  async loadFeedbackSignals(scope: BusinessStateScope & { target: string; limit?: number }): Promise<string[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(scope.limit ?? 80)));
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<{ signal: string }>(`
        SELECT signal FROM pr_agent_harness.review_feedback_signals
        WHERE tenant_id=$1 AND integration_id=$2 AND platform=$3 AND origin=$4 AND repository=$5
          AND target IN ($6,'repository') AND expires_at>clock_timestamp()
        ORDER BY CASE WHEN target=$6 THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT $7`,
      [scope.tenantId, scope.integrationId, scope.platform, scope.origin, scope.repository, scope.target, limit]);
      return result.rows.map((row) => row.signal).reverse();
    });
  }
}
