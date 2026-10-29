import type { PoolClient } from "pg";

export interface RunFactInput {
  tenantId: string;
  runId: string;
  eventType: string;
  actorType: "user" | "service" | "system" | "worker";
  actorId: string;
  payload?: Record<string, unknown>;
  eventKey?: string;
  visibility?: "public" | "internal";
}

/** Caller owns the surrounding state transition transaction. */
export async function appendRunFact(client: PoolClient, input: RunFactInput): Promise<void> {
  if (!/^[a-z][a-z0-9_.]{1,100}$/.test(input.eventType)) throw new Error("Invalid Run event type");
  const payload = JSON.stringify(input.payload ?? {});
  if (Buffer.byteLength(payload) > 16_384) throw new Error("Run event payload exceeds its limit");
  const locked = await client.query(
    "SELECT 1 FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [input.tenantId, input.runId],
  );
  if (locked.rowCount !== 1) throw new Error("Run event target does not exist");
  if (input.eventKey) {
    const previous = await client.query(
      "SELECT 1 FROM pr_agent_harness.run_events WHERE tenant_id=$1 AND run_id=$2 AND event_key=$3",
      [input.tenantId, input.runId, input.eventKey],
    );
    if (previous.rowCount) return;
  }
  const next = await client.query<{ sequence: string }>(
    `UPDATE pr_agent_harness.agent_runs SET next_event_seq=next_event_seq+1
     WHERE tenant_id=$1 AND id=$2 RETURNING next_event_seq-1 AS sequence`,
    [input.tenantId, input.runId],
  );
  await client.query(
    `INSERT INTO pr_agent_harness.run_events
       (tenant_id,run_id,sequence,event_type,schema_version,visibility,actor_type,actor_id,payload_json,event_key)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8::jsonb,$9)`,
    [input.tenantId, input.runId, next.rows[0]!.sequence, input.eventType,
      input.visibility ?? "public", input.actorType, input.actorId, payload, input.eventKey ?? null],
  );
}

const PUBLIC_FIELDS = new Set(["runType", "baseSha", "headSha", "status", "version", "epoch",
  "jobAttempt", "stepId", "attemptId", "batchId", "operationSetHash", "checkpointSequence",
  "reasonCode", "outcomeCode", "commandKind", "receiptId", "waitId", "waitVersion", "newRunId",
  "analysisStatus", "coverageStatus", "publicationMode", "artifactHash",
  "publicationStatus", "outcomeGeneration", "businessOperationId", "operationVersion"]);

/** Public events contain lifecycle facts, never raw prompts, output, or error bodies. */
export function publicEventPayload(payload: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!PUBLIC_FIELDS.has(key)) continue;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
    else if (typeof value === "string") result[key] = value.slice(0, 512);
  }
  return result;
}
