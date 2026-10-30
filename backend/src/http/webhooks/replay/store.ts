import { createHash } from "node:crypto";

import { BadWebhookRequestError } from "#core";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import { PublicationBindingNotFoundError } from "../../../agent-runtime/authority/publication-authority.js";
import type { RunPrincipal } from "../../../agent-runtime/runs/control-contracts.js";
import { readHeaderValue, safeJsonStringify } from "../../common/webhook-utils.js";

export type ReplayPlatform = "github" | "gitlab";
export type WebhookOutcome = "succeeded" | "failed";
export interface WebhookReplayScope { tenantId: string; integrationId: string; platform: ReplayPlatform }
export interface StoredWebhookEvent {
  id: string; tenantId: string; integrationId: string; platform: ReplayPlatform; deliveryId: string;
  eventName: string; receivedAt: string; outcome: WebhookOutcome; outcomeCode: string;
  headers: Record<string, string>; payload: unknown; payloadHash: string; rawBodyHash: string;
}
export interface StoredWebhookEventSummary {
  id: string; platform: ReplayPlatform; deliveryId: string; eventName: string; receivedAt: string;
  outcome: WebhookOutcome; outcomeCode: string; payloadSizeBytes: number;
}

export async function resolveWebhookReplayScope(platform: ReplayPlatform, payload: unknown): Promise<WebhookReplayScope | undefined> {
  const target = replayTarget(platform, payload);
  if (!target) return undefined;
  try {
    const runtime = await resolvePublicationRuntime(target);
    return { tenantId: runtime.binding.tenantId, integrationId: runtime.binding.id, platform };
  } catch (error) {
    if (error instanceof PublicationBindingNotFoundError) return undefined;
    throw error;
  }
}

export async function recordWebhookEvent(params: {
  scope: WebhookReplayScope; eventName: string;
  headers: Record<string, string | string[] | undefined>; payload: unknown; rawBody?: string;
  outcome: WebhookOutcome; outcomeCode: string; normalizedPayloadText?: string;
}): Promise<string> {
  const services = await getAgentRuntimeServices();
  const payloadText = params.normalizedPayloadText ?? canonicalizeWebhookPayload(params.payload);
  const payloadHash = sha256(payloadText);
  const rawBodyHash = sha256(params.rawBody ?? payloadText);
  const deliveryId = deliveryIdentity(params.scope.platform, params.headers, payloadHash);
  const result = await services.db.transaction(params.scope.tenantId, (client) => client.query<{ id: string }>(`
    INSERT INTO pr_agent_harness.webhook_replay_events
      (tenant_id,integration_id,platform,delivery_id,event_name,outcome,outcome_code,
       headers_json,payload_json,payload_hash,raw_body_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
    ON CONFLICT (tenant_id,integration_id,platform,delivery_id,payload_hash,outcome,outcome_code)
      DO UPDATE SET received_at=webhook_replay_events.received_at
    RETURNING id`, [params.scope.tenantId, params.scope.integrationId, params.scope.platform, deliveryId,
    normalizeEventName(params.eventName), params.outcome, normalizeOutcomeCode(params.outcomeCode),
    JSON.stringify(sanitizeHeaders(params.headers)), payloadText, payloadHash, rawBodyHash]));
  if (!result.rows[0]) throw new Error("Webhook replay event was not stored");
  return result.rows[0].id;
}

export async function listStoredWebhookEvents(params: {
  principal: RunPrincipal; platform?: ReplayPlatform; deliveryId?: string; limit?: number;
}): Promise<StoredWebhookEventSummary[]> {
  const deliveryId = normalizeWebhookDeliveryId(params.deliveryId);
  const services = await getAgentRuntimeServices();
  const result = await services.db.transaction(params.principal.tenantId, (client) => client.query<{
    id: string; platform: ReplayPlatform; delivery_id: string; event_name: string; received_at: Date; outcome: WebhookOutcome;
    outcome_code: string; payload_size: number;
  }>(`SELECT id,platform,delivery_id,event_name,received_at,outcome,outcome_code,
      octet_length(payload_json::text)::int AS payload_size FROM pr_agent_harness.webhook_replay_events
    WHERE tenant_id=$1 AND integration_id=$2 AND ($3::text IS NULL OR platform=$3)
      AND ($4::text IS NULL OR delivery_id=$4) AND content_purged_at IS NULL
    ORDER BY received_at DESC,id DESC LIMIT $5`, [params.principal.tenantId, params.principal.integrationId,
    params.platform ?? null, deliveryId, resolveWebhookEventListLimit(params.limit)]));
  return result.rows.map((row) => ({ id: row.id, platform: row.platform, deliveryId: row.delivery_id,
    eventName: row.event_name,
    receivedAt: row.received_at.toISOString(), outcome: row.outcome, outcomeCode: row.outcome_code,
    payloadSizeBytes: row.payload_size }));
}

export async function getStoredWebhookEventById(params: {
  principal: RunPrincipal; id: string; platform?: ReplayPlatform;
}): Promise<StoredWebhookEvent | undefined> {
  const services = await getAgentRuntimeServices();
  const result = await services.db.transaction(params.principal.tenantId, (client) => client.query<{
    id: string; tenant_id: string; integration_id: string; platform: ReplayPlatform; delivery_id: string;
    event_name: string; received_at: Date; outcome: WebhookOutcome; outcome_code: string;
    headers_json: Record<string,string>; payload_json: unknown; payload_hash: string; raw_body_hash: string;
  }>(`UPDATE pr_agent_harness.webhook_replay_events SET replay_count=replay_count+1,last_replayed_at=clock_timestamp()
    WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND ($4::text IS NULL OR platform=$4)
      AND content_purged_at IS NULL
    RETURNING id,tenant_id,integration_id,platform,delivery_id,event_name,received_at,outcome,outcome_code,
      headers_json,payload_json,payload_hash,raw_body_hash`, [params.principal.tenantId,
    params.principal.integrationId, params.id, params.platform ?? null]));
  const row = result.rows[0];
  return row ? { id: row.id, tenantId: row.tenant_id, integrationId: row.integration_id,
    platform: row.platform, deliveryId: row.delivery_id, eventName: row.event_name,
    receivedAt: row.received_at.toISOString(), outcome: row.outcome, outcomeCode: row.outcome_code,
    headers: row.headers_json, payload: row.payload_json, payloadHash: row.payload_hash,
    rawBodyHash: row.raw_body_hash } : undefined;
}

export function resolveStoredWebhookReplayPayload(event: StoredWebhookEvent): unknown { return event.payload; }
export function resolveWebhookEventListLimit(raw: number | string | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.floor(parsed))) : 20;
}

export function normalizeWebhookDeliveryId(value: string | undefined): string | undefined {
  if (typeof value === "undefined") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new BadWebhookRequestError("invalid webhook delivery id");
  }
  return normalized;
}

export function canonicalizeWebhookPayload(payload: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (value: unknown, inArray = false): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
      return inArray ? null : undefined;
    }
    if (typeof value !== "object") throw new BadWebhookRequestError("webhook payload is not JSON serializable");
    if (seen.has(value)) throw new BadWebhookRequestError("webhook payload is not JSON serializable");
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => normalize(entry, true));
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
        const normalized = normalize((value as Record<string, unknown>)[key]);
        return typeof normalized === "undefined" ? [] : [[key, normalized]];
      }));
    } finally {
      seen.delete(value);
    }
  };
  const serialized = safeJsonStringify(normalize(payload), "");
  if (!serialized) throw new BadWebhookRequestError("webhook payload is not JSON serializable");
  return serialized;
}

function replayTarget(platform: ReplayPlatform, payload: unknown): { platform: ReplayPlatform; origin: string; repository: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const repository = (payload as { repository?: { name?: unknown; owner?: { login?: unknown; name?: unknown } } }).repository;
  if (platform === "github" && typeof repository?.name === "string") {
    const owner = typeof repository.owner?.login === "string" ? repository.owner.login
      : typeof repository.owner?.name === "string" ? repository.owner.name : undefined;
    if (owner) return { platform, origin: process.env.GITHUB_API_URL?.trim() || "https://api.github.com",
      repository: `${owner}/${repository.name}` };
  }
  const project = (payload as { project?: { path_with_namespace?: unknown; id?: unknown; web_url?: unknown } }).project;
  if (platform === "gitlab" && project && typeof project.web_url === "string") {
    const name = typeof project.path_with_namespace === "string" ? project.path_with_namespace
      : typeof project.id === "number" ? String(project.id) : undefined;
    if (name) return { platform, origin: new URL(project.web_url).origin, repository: name };
  }
  return undefined;
}
function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string,string> {
  const allowed = ["x-github-event","x-github-delivery","x-gitlab-event","x-gitlab-delivery",
    "x-gitlab-event-uuid","x-gitlab-webhook-uuid","content-type"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = readHeaderValue(headers, key)?.trim(); return value ? [[key, value]] : [];
  }));
}
function deliveryIdentity(platform: ReplayPlatform, headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const keys = platform === "github" ? ["x-github-delivery"]
    : ["x-gitlab-event-uuid","x-gitlab-webhook-uuid","x-gitlab-delivery"];
  return keys.map((key) => readHeaderValue(headers, key)?.trim()).find(Boolean)?.slice(0, 256)
    ?? `${platform}:payload:${fallback}`;
}
function normalizeEventName(value: string): string { return value.trim().toLowerCase().slice(0,128) || "unknown"; }
function normalizeOutcomeCode(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]/g,"_").slice(0,128) || "unknown";
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class VerifiedWebhookHandlingError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "Verified webhook failed"); this.name = "VerifiedWebhookHandlingError";
  }
}
export function replayNotFound(id: string): BadWebhookRequestError {
  return new BadWebhookRequestError(`webhook replay event not found: ${id}`);
}
