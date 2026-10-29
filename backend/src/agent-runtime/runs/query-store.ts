import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../postgres/database.js";
import { RunControlError, requireRunPermission, runNotFound, type RunPrincipal } from "./control-contracts.js";
import { publicEventPayload } from "./events.js";

export interface RunSnapshot {
  id: string;
  status: string;
  version: number;
  runType: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  outcomeCode: string | null;
  errorCode: string | null;
  parentRunId: string | null;
  cancelRequested: boolean;
  publicationStatus: string | null;
  contentPurgedAt: string | null;
  artifactAvailable: boolean;
  analysisStatus: string | null;
  coverageStatus: string | null;
  publicationMode: string | null;
  wait?: Record<string, unknown>;
}
export interface RunEventPage {
  events: Array<{ id: string; sequence: number; type: string; schemaVersion: number;
    payload: Record<string, unknown>; createdAt: string }>;
  cursor: string;
  highWater: string;
  snapshot: RunSnapshot;
}

export class RunQueryStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async snapshot(principal: RunPrincipal, runId: string): Promise<RunSnapshot> {
    requireRunPermission(principal, "runs:read");
    return this.db.transaction(principal.tenantId, async (client) => mapSnapshot(await selectScopedRun(client, principal, runId)));
  }

  async originalInput(principal: RunPrincipal, runId: string): Promise<Record<string, unknown>> {
    requireRunPermission(principal, "runs:rerun");
    return this.db.transaction(principal.tenantId, async (client) => {
      const run = await selectScopedRun(client, principal, runId, true);
      if (run.content_purged_at) {
        throw new RunControlError("RUN_CONTENT_EXPIRED", 410, "Run content expired; create a new review from its source");
      }
      const result = await client.query<{ input_json: Record<string, unknown> }>(
        "SELECT input_json FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2",
        [principal.tenantId, runId],
      );
      return result.rows[0]!.input_json;
    });
  }

  async events(principal: RunPrincipal, runId: string, after?: string, limit = 100): Promise<RunEventPage> {
    requireRunPermission(principal, "runs:read");
    const sequence = parseRunCursor(runId, after);
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db.transaction(principal.tenantId, async (client) => {
      const run = await selectScopedRun(client, principal, runId, true);
      const snapshot = mapSnapshot(run);
      const highWater = Number(run.next_event_seq) - 1;
      if (sequence < Number(run.event_retention_floor) - 1) {
        throw new RunCursorExpiredError(snapshot, runCursor(runId, highWater));
      }
      if (sequence > highWater) throw new RunControlError("INVALID_CURSOR", 400, "Cursor is ahead of the durable event history");
      const rows = await client.query<{ sequence: string; event_type: string; schema_version: number;
        visibility: string; payload_json: Record<string, unknown>; created_at: Date }>(
        `SELECT sequence,event_type,schema_version,visibility,payload_json,created_at
         FROM pr_agent_harness.run_events WHERE tenant_id=$1 AND run_id=$2 AND sequence>$3 AND sequence<=$4
         ORDER BY sequence LIMIT $5`,
        [principal.tenantId, runId, sequence, highWater, size],
      );
      // The scan cursor also advances over internal events, without disclosing their payload.
      const last = rows.rows.at(-1);
      const cursor = last ? Number(last.sequence) : highWater;
      return { snapshot, cursor: runCursor(runId, cursor), highWater: runCursor(runId, highWater),
        events: rows.rows.filter((row) => row.visibility === "public").map((row) => ({
          id: runCursor(runId, Number(row.sequence)), sequence: Number(row.sequence), type: row.event_type,
          schemaVersion: row.schema_version, payload: publicEventPayload(row.payload_json), createdAt: row.created_at.toISOString(),
        })) };
    });
  }

  async trace(principal: RunPrincipal, runId: string, after?: string): Promise<Record<string, unknown>> {
    requireRunPermission(principal, "runs:trace");
    const cursor = parseTraceCursor(runId, after);
    return this.db.transaction(principal.tenantId, async (client) => {
      const run = await selectScopedRun(client, principal, runId);
      const union = TRACE_SOURCES.map((source) =>
        `SELECT '${source.kind}' AS kind,${source.id ?? "id"} AS id,${source.time} AS recorded_at,
           jsonb_build_object(${source.fields.map(([key, column]) => `'${key}',${column}`).join(",")}) AS metadata
         FROM pr_agent_harness.${source.table} WHERE tenant_id=$1 AND run_id=$2`).join(" UNION ALL ");
      const result = await client.query<{ kind: string; id: string; recorded_at: Date; cursor_time: string; metadata: Record<string, unknown> }>(
        `SELECT *,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM (${union}) AS trace
         WHERE $3::timestamptz IS NULL OR (recorded_at,id,kind)>($3::timestamptz,$4::uuid,$5::text)
         ORDER BY recorded_at,id,kind LIMIT 201`,
        [principal.tenantId, runId, cursor?.time ?? null, cursor?.id ?? null, cursor?.kind ?? null],
      );
      const entries = result.rows.slice(0, 200);
      const last = entries.at(-1);
      return { run: mapSnapshot(run), entries: entries.map((row) => ({ kind: row.kind, id: row.id,
        recordedAt: row.recorded_at.toISOString(), metadata: row.metadata })),
        nextCursor: result.rows.length > 200 && last
          ? Buffer.from(JSON.stringify({ runId, time: last.cursor_time, id: last.id, kind: last.kind })).toString("base64url")
          : null };
    });
  }
}

interface SnapshotRow {
  id: string; status: string; version: string; run_type: string; base_sha: string; head_sha: string;
  created_at: Date; updated_at: Date; finished_at: Date | null; deadline_at: Date;
  outcome_code: string | null; error_code: string | null; parent_run_id: string | null;
  cancel_requested_at: Date | null; next_event_seq: string; event_retention_floor: string;
  publication_status: string | null; wait: Record<string, unknown> | null;
  content_purged_at: Date | null;
  artifact_available: boolean; analysis_status: string | null; coverage_status: string | null; publication_mode: string | null;
}

async function selectScopedRun(client: PoolClient, principal: RunPrincipal, runId: string, lock = false): Promise<SnapshotRow> {
  const result = await client.query<SnapshotRow>(
    `SELECT r.id,r.status,r.version,r.run_type,r.base_sha,r.head_sha,r.created_at,r.updated_at,r.finished_at,
            r.deadline_at,r.outcome_code,r.error_code,r.parent_run_id,r.cancel_requested_at,r.next_event_seq,r.event_retention_floor,r.content_purged_at,
            pb.status AS publication_status,
            (ra.run_id IS NOT NULL AND ra.content_purged_at IS NULL) AS artifact_available,
            ra.artifact_json->>'analysisStatus' AS analysis_status,
            ra.artifact_json->'sourceCoverage'->>'status' AS coverage_status,
            ra.artifact_json->>'publicationMode' AS publication_mode,
            (SELECT jsonb_build_object('id',w.id,'version',w.version,'batchId',w.batch_id,
              'operationId',w.business_operation_id,'operationVersion',w.operation_version,
              'intentHash',w.intent_hash,'allowedDecisions',w.allowed_decisions)
             FROM pr_agent_harness.run_waits w WHERE w.tenant_id=r.tenant_id AND w.run_id=r.id AND w.status='open') AS wait
     FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.integration_bindings ib ON ib.tenant_id=r.tenant_id AND ib.id=r.integration_id AND ib.active
     LEFT JOIN pr_agent_harness.review_artifacts ra ON ra.tenant_id=r.tenant_id AND ra.run_id=r.id
     LEFT JOIN LATERAL (
       SELECT CASE WHEN count(*)=1 THEN max(b.status) END AS status
       FROM pr_agent_harness.run_publication_batches link
       JOIN pr_agent_harness.publication_batches b ON b.tenant_id=link.tenant_id AND b.id=link.batch_id
       WHERE link.tenant_id=r.tenant_id AND link.run_id=r.id
         AND (r.waiting_batch_id IS NULL OR b.id=r.waiting_batch_id)
     ) pb ON true
     WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3 ${lock ? "FOR SHARE OF r" : ""}`,
    [principal.tenantId, principal.integrationId, runId],
  );
  if (!result.rows[0]) throw runNotFound();
  return result.rows[0];
}

function mapSnapshot(row: SnapshotRow): RunSnapshot {
  return { artifactAvailable: row.artifact_available, analysisStatus: row.analysis_status,
    coverageStatus: row.coverage_status, publicationMode: row.publication_mode,
    id: row.id, status: row.status, version: Number(row.version), runType: row.run_type,
    baseSha: row.base_sha, headSha: row.head_sha, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
    deadlineAt: row.deadline_at.toISOString(), outcomeCode: row.outcome_code, errorCode: row.error_code,
    parentRunId: row.parent_run_id, cancelRequested: row.cancel_requested_at !== null,
    publicationStatus: row.publication_status, contentPurgedAt: row.content_purged_at?.toISOString() ?? null,
    ...(row.wait ? { wait: row.wait } : {}) };
}

export function runCursor(runId: string, sequence: number): string {
  return `${runId}:${sequence}`;
}

export function parseRunCursor(runId: string, cursor?: string): number {
  if (cursor === undefined || cursor === "") return 0;
  const prefix = `${runId}:`;
  if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length))) {
    throw new RunControlError("INVALID_CURSOR", 400, "Cursor does not belong to this Run");
  }
  const sequence = Number(cursor.slice(prefix.length));
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RunControlError("INVALID_CURSOR", 400, "Invalid cursor sequence");
  }
  return sequence;
}

export class RunCursorExpiredError extends RunControlError {
  constructor(readonly snapshot: RunSnapshot, readonly resumeCursor: string) {
    super("CURSOR_EXPIRED", 410, "Event history expired; reload the supplied snapshot before resuming");
  }
}

const TRACE_SOURCES: Array<{ kind: string; table: string; id?: string; time: string; fields: Array<[string, string]> }> = [
  {
    kind: "release_selection",
    table: "evolution_run_assignments",
    id: "run_id",
    time: "created_at",
    fields: [["assignmentVersion", "assignment_version"], ["routing", "routing"], ["selection", "selection"],
      ["candidateId", "candidate_id"], ["qualificationId", "qualification_id"], ["releaseReceiptId", "release_receipt_id"],
      ["reviewTextHash", "review_text_hash"], ["promptHash", "prompt_hash"], ["toolHash", "tool_hash"],
      ["selectionHash", "selection_hash"]],
  },
  {
    kind: "step",
    table: "agent_steps",
    time: "created_at",
    fields: [["stepKey", "step_key"], ["kind", "step_kind"], ["status", "status"],
      ["inputHash", "input_hash"], ["outputHash", "output_hash"]],
  },
  {
    kind: "attempt",
    table: "step_attempts",
    time: "started_at",
    fields: [["stepId", "step_id"], ["attempt", "attempt_number"], ["epoch", "lease_epoch"],
      ["status", "status"], ["errorCode", "error_code"]],
  },
  {
    kind: "model",
    table: "model_calls",
    time: "created_at",
    fields: [["stepId", "step_id"], ["provider", "provider"], ["model", "model"],
      ["requestHash", "request_hash"], ["status", "status"],
      ["providerRequestId", "provider_request_id"]],
  },
  {
    kind: "tool",
    table: "tool_calls",
    time: "started_at",
    fields: [["stepId", "step_id"], ["name", "tool_name"], ["kind", "tool_kind"],
      ["requestHash", "request_hash"], ["resultHash", "result_hash"], ["status", "status"]],
  },
  {
    kind: "checkpoint",
    table: "checkpoints",
    time: "created_at",
    fields: [["sequence", "sequence"], ["schemaVersion", "schema_version"],
      ["runtimeVersionHash", "runtime_version_hash"], ["stateHash", "state_hash"],
      ["kind", "checkpoint_kind"]],
  },
  {
    kind: "usage",
    table: "usage_records",
    time: "measured_at",
    fields: [["modelCallId", "model_call_id"], ["inputTokens", "input_tokens"],
      ["outputTokens", "output_tokens"], ["costMicros", "cost_micros"],
      ["currency", "currency"], ["measurement", "measurement_status"]],
  },
  {
    kind: "audit",
    table: "audit_logs",
    time: "created_at",
    fields: [["action", "action"], ["decision", "decision"], ["reasonCode", "reason_code"]],
  },
  {
    kind: "command",
    table: "run_command_receipts",
    time: "created_at",
    fields: [["kind", "command_kind"], ["status", "status"], ["requestHash", "request_hash"],
      ["resultingVersion", "resulting_version"]],
  },
];

function parseTraceCursor(runId: string, value?: string): { time: string; id: string; kind: string } | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Invalid encoding");
    }
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      cursor.runId !== runId ||
      typeof cursor.time !== "string" ||
      !Number.isFinite(Date.parse(cursor.time)) ||
      typeof cursor.id !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(cursor.id) ||
      typeof cursor.kind !== "string" ||
      !TRACE_SOURCES.some((source) => source.kind === cursor.kind)
    ) {
      throw new Error("Invalid cursor");
    }
    return { time: cursor.time, id: cursor.id, kind: cursor.kind };
  } catch {
    throw new RunControlError("INVALID_CURSOR", 400, "Trace cursor does not belong to this Run");
  }
}
