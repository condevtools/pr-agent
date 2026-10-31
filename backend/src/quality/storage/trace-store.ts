import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import type { QualityScope, QualityTraceLink, RecordQualityTraceInput } from "./contracts.js";
import { QualityStorageConflictError } from "./contracts.js";
import { assertHash, assertScope, assertText, iso } from "./internal.js";

interface TraceRow {
  id: string; tenant_id: string; integration_id: string; run_id: string; run_attempt: number;
  trace_id: string; external_id: string; target_fingerprint: string; created_at: Date;
}

export class PgQualityTraceStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async record(scope: QualityScope, input: RecordQualityTraceInput): Promise<QualityTraceLink> {
    validate(scope, input);
    return this.db.transaction(scope.tenantId, async (client) => {
      const inserted = await client.query<TraceRow>(
        `INSERT INTO pr_agent_harness.quality_trace_links
           (tenant_id,integration_id,run_id,run_attempt,trace_id,external_id,target_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,integration_id,run_id,run_attempt) DO NOTHING RETURNING *`,
        [scope.tenantId, scope.integrationId, input.runId, input.runAttempt, input.traceId,
          input.externalId, input.targetFingerprint]);
      if (inserted.rows[0]) return mapTrace(inserted.rows[0]);
      const existing = await client.query<TraceRow>(
        `SELECT * FROM pr_agent_harness.quality_trace_links
         WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 AND run_attempt=$4`,
        [scope.tenantId, scope.integrationId, input.runId, input.runAttempt]);
      const row = existing.rows[0];
      if (!row || row.trace_id !== input.traceId || row.external_id !== input.externalId
          || row.target_fingerprint !== input.targetFingerprint) {
        throw new QualityStorageConflictError("Run attempt trace identity was reused with different content");
      }
      return mapTrace(row);
    });
  }

  async listForRun(scope: QualityScope, runId: string): Promise<QualityTraceLink[]> {
    assertScope(scope);
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<TraceRow>(
        `SELECT * FROM pr_agent_harness.quality_trace_links
         WHERE tenant_id=$1 AND integration_id=$2 AND run_id=$3 ORDER BY run_attempt,id`,
        [scope.tenantId, scope.integrationId, runId]);
      return result.rows.map(mapTrace);
    });
  }
}

function validate(scope: QualityScope, input: RecordQualityTraceInput): void {
  assertScope(scope);
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1) throw new Error("invalid run attempt");
  if (!/^[0-9a-f]{32}$/u.test(input.traceId)) throw new Error("trace id must be 32 lowercase hexadecimal characters");
  assertText(input.externalId, "trace external id", 240);
  assertHash(input.targetFingerprint, "target fingerprint");
}
function mapTrace(row: TraceRow): QualityTraceLink {
  return { id: row.id, scope: { tenantId: row.tenant_id, integrationId: row.integration_id },
    runId: row.run_id, runAttempt: row.run_attempt, traceId: row.trace_id, externalId: row.external_id,
    targetFingerprint: row.target_fingerprint, createdAt: iso(row.created_at) };
}
