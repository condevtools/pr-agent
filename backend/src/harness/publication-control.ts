import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { HarnessDatabase } from "./postgres/database.js";
import type { PublicationOperationStatus } from "./publication.js";

export type PublicationControlDecision =
  | "confirm_occurred"
  | "confirm_not_occurred"
  | "authorize_retry"
  | "abandon_publication";

export interface PublicationControlEvidence {
  kind: "provider_confirmation";
  reference: string;
  actualRevision?: string;
  [key: string]: unknown;
}

export interface PublicationControlInput {
  tenantId: string;
  businessOperationId: string;
  expectedVersion: number;
  commandKey: string;
  decision: PublicationControlDecision;
  actor: {
    type: "user" | "service";
    id: string;
  };
  evidence: PublicationControlEvidence;
  remoteId?: string;
}

export interface PublicationControlReceipt {
  id: string;
  tenantId: string;
  businessOperationId: string;
  commandKey: string;
  decision: PublicationControlDecision;
  previousStatus: PublicationOperationStatus;
  resultingStatus: PublicationOperationStatus;
  previousVersion: number;
  resultingVersion: number;
  createdAt: string;
}

const MAX_DISPATCH_ATTEMPTS = 3;

export class PublicationControlStore {
  constructor(private readonly db: HarnessDatabase) {}

  async apply(input: PublicationControlInput): Promise<PublicationControlReceipt> {
    const normalized = normalizeInput(input);
    const requestHash = sha256(stableJson({
      actor: normalized.actor,
      businessOperationId: normalized.businessOperationId,
      decision: normalized.decision,
      evidence: normalized.evidence,
      expectedVersion: normalized.expectedVersion,
      remoteId: normalized.remoteId ?? null,
      tenantId: normalized.tenantId,
    }));

    return this.db.transaction(normalized.tenantId, async (client) => {
      const operation = await selectControlledOperation(
        client,
        normalized.tenantId,
        normalized.businessOperationId,
      );
      if (!operation) throw new PublicationControlOperationNotFoundError(normalized.businessOperationId);
      await assertAuthorizedBinding(client, operation);

      const duplicate = await selectReceipt(client, normalized.tenantId, normalized.commandKey);
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) {
          throw new PublicationControlCommandConflictError(normalized.commandKey);
        }
        return mapReceipt(duplicate);
      }

      if (operation.reconcile_claim_active) {
        throw new PublicationControlRecoveryClaimError(normalized.businessOperationId);
      }

      if (Number(operation.version) !== normalized.expectedVersion) {
        throw new PublicationControlVersionConflictError(
          normalized.businessOperationId,
          normalized.expectedVersion,
          Number(operation.version),
        );
      }
      const transition = decideTransition(normalized, operation);
      const updated = await client.query<{
        status: PublicationOperationStatus;
        version: string;
      }>(
        `
          UPDATE pr_agent_harness.repository_operations
          SET status = $4,
              outcome_code = $5,
              remote_id = $6,
              last_error_code = $7,
              evidence_json = $8::jsonb,
              command_receipt_json = $9::jsonb,
              resolved_at = CASE WHEN $10::boolean THEN now() ELSE NULL END,
              version = version + 1,
              updated_at = now()
          WHERE tenant_id = $1 AND business_operation_id = $2 AND version = $3
          RETURNING status, version
        `,
        [
          normalized.tenantId,
          normalized.businessOperationId,
          normalized.expectedVersion,
          transition.status,
          transition.outcomeCode,
          transition.remoteId,
          transition.errorCode,
          stableJson(normalized.evidence),
          stableJson({ commandKey: normalized.commandKey, decision: normalized.decision }),
          transition.resolved,
        ],
      );
      const result = updated.rows[0];
      if (!result) {
        throw new PublicationControlVersionConflictError(
          normalized.businessOperationId,
          normalized.expectedVersion,
          Number(operation.version),
        );
      }

      const inserted = await client.query<ReceiptRow>(
        `
          INSERT INTO pr_agent_harness.publication_command_receipts (
            tenant_id, business_operation_id, command_key, request_hash, decision,
            actor_type, actor_id, evidence_json, remote_id, previous_status,
            resulting_status, previous_version, resulting_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
          RETURNING *
        `,
        [
          normalized.tenantId,
          normalized.businessOperationId,
          normalized.commandKey,
          requestHash,
          normalized.decision,
          normalized.actor.type,
          normalized.actor.id,
          stableJson(normalized.evidence),
          normalized.remoteId ?? null,
          operation.status,
          result.status,
          Number(operation.version),
          Number(result.version),
        ],
      );
      const receipt = inserted.rows[0];
      if (!receipt) throw new Error("publication control receipt was not persisted");
      await auditControl(client, normalized, receipt);
      return mapReceipt(receipt);
    });
  }
}

interface ControlledOperationRow {
  business_operation_id: string;
  tenant_id: string;
  integration_id: string;
  revision: string;
  status: PublicationOperationStatus;
  outcome_code: string | null;
  attempt_count: number;
  version: string;
  dispatched_at: Date | null;
  retry_cooldown_elapsed: boolean;
  active: boolean;
  publication_state: "blocked" | "active" | "draining";
  publication_generation: string;
  authority_generation: string | null;
  reconcile_claim_owner: string | null;
  reconcile_claim_expires_at: Date | null;
  reconcile_claim_active: boolean;
}

interface ReceiptRow {
  id: string;
  tenant_id: string;
  business_operation_id: string;
  command_key: string;
  request_hash: string;
  decision: PublicationControlDecision;
  previous_status: PublicationOperationStatus;
  resulting_status: PublicationOperationStatus;
  previous_version: string;
  resulting_version: string;
  created_at: Date;
}

interface NormalizedControlInput extends PublicationControlInput {
  remoteId?: string;
}

async function selectControlledOperation(
  client: PoolClient,
  tenantId: string,
  operationId: string,
): Promise<ControlledOperationRow | undefined> {
  const result = await client.query<ControlledOperationRow>(
    `
      SELECT ro.business_operation_id, ro.tenant_id, ro.integration_id, ro.revision,
             ro.status, ro.outcome_code, ro.attempt_count, ro.version, ro.dispatched_at,
             (ro.dispatched_at IS NOT NULL
               AND ro.dispatched_at <= now() - interval '2 minutes') AS retry_cooldown_elapsed,
             ib.active, ib.publication_state, ib.publication_generation,
             ro.authority_generation, ro.reconcile_claim_owner,
             ro.reconcile_claim_expires_at,
             (ro.reconcile_claim_owner IS NOT NULL
               AND ro.reconcile_claim_expires_at > now()) AS reconcile_claim_active
      FROM pr_agent_harness.repository_operations ro
      JOIN pr_agent_harness.integration_bindings ib
        ON ib.tenant_id = ro.tenant_id AND ib.id = ro.integration_id
      WHERE ro.tenant_id = $1 AND ro.business_operation_id = $2
      FOR UPDATE OF ro
    `,
    [tenantId, operationId],
  );
  return result.rows[0];
}

async function selectReceipt(
  client: PoolClient,
  tenantId: string,
  commandKey: string,
): Promise<ReceiptRow | undefined> {
  const result = await client.query<ReceiptRow>(
    `
      SELECT *
      FROM pr_agent_harness.publication_command_receipts
      WHERE tenant_id = $1 AND command_key = $2
    `,
    [tenantId, commandKey],
  );
  return result.rows[0];
}

async function assertAuthorizedBinding(
  client: PoolClient,
  operation: ControlledOperationRow,
): Promise<void> {
  const generationMatches = operation.authority_generation !== null &&
    Number(operation.authority_generation) === Number(operation.publication_generation);
  if (
    operation.active !== true ||
    !generationMatches ||
    (operation.publication_state !== "active" && operation.publication_state !== "draining")
  ) {
    throw new PublicationControlAuthorityError();
  }
  const locked = await client.query<{ allowed: boolean }>(
    `
      SELECT pr_agent_harness.lock_resolvable_publication_authority(
        $1::uuid, $2::uuid, $3::bigint
      ) AS allowed
    `,
    [operation.tenant_id, operation.integration_id, operation.authority_generation],
  );
  if (locked.rows[0]?.allowed !== true) throw new PublicationControlAuthorityError();
}

function decideTransition(
  input: NormalizedControlInput,
  operation: ControlledOperationRow,
): {
  status: PublicationOperationStatus;
  outcomeCode: string | null;
  remoteId: string | null;
  errorCode: string | null;
  resolved: boolean;
} {
  if (operation.status === "in_flight") {
    throw new PublicationControlStateError("in_flight operations cannot be manually resolved");
  }

  if (input.decision === "confirm_occurred") {
    requireUnresolved(operation);
    if (!input.remoteId) throw new PublicationControlEvidenceError("remote ID is required");
    const actualRevision = requiredText(input.evidence.actualRevision, "actual revision evidence");
    return {
      status: "succeeded",
      outcomeCode: actualRevision === operation.revision ? "current" : "stale",
      remoteId: input.remoteId,
      errorCode: null,
      resolved: true,
    };
  }

  if (input.decision === "confirm_not_occurred") {
    requireUnresolved(operation);
    return {
      status: "manual_review",
      outcomeCode: "not_occurred_confirmed",
      remoteId: null,
      errorCode: "operator_confirmed_not_occurred",
      resolved: false,
    };
  }

  if (input.decision === "authorize_retry") {
    if (
      operation.status !== "manual_review" ||
      operation.outcome_code !== "not_occurred_confirmed"
    ) {
      throw new PublicationControlStateError("retry requires a prior not-occurred confirmation");
    }
    if (operation.attempt_count >= MAX_DISPATCH_ATTEMPTS) {
      throw new PublicationControlStateError("publication dispatch attempt limit reached");
    }
    const requiresCooldown = operation.attempt_count > 0 || operation.dispatched_at !== null;
    if (requiresCooldown && !operation.retry_cooldown_elapsed) {
      throw new PublicationControlStateError("publication retry cooldown has not elapsed");
    }
    return {
      status: "prepared",
      outcomeCode: null,
      remoteId: null,
      errorCode: null,
      resolved: false,
    };
  }

  if (
    operation.status !== "prepared" &&
    operation.status !== "unknown" &&
    operation.status !== "manual_review"
  ) {
    throw new PublicationControlStateError("publication cannot be abandoned from its current state");
  }
  return {
    status: "failed_definite",
    outcomeCode: "publication_abandoned",
    remoteId: null,
    errorCode: "operator_abandoned_publication",
    resolved: true,
  };
}

function requireUnresolved(operation: ControlledOperationRow): void {
  if (operation.status !== "unknown" && operation.status !== "manual_review") {
    throw new PublicationControlStateError("decision requires an unknown or manual-review operation");
  }
}

async function auditControl(
  client: PoolClient,
  input: NormalizedControlInput,
  receipt: ReceiptRow,
): Promise<void> {
  await client.query(
    `
      INSERT INTO pr_agent_harness.audit_logs (
        tenant_id, actor_type, actor_id, action, decision, reason_code,
        resource_type, resource_ref, details_json
      ) VALUES ($1, $2, $3, 'publication.manual_control', 'allowed', $4,
                'repository_operation', $5, $6::jsonb)
    `,
    [
      input.tenantId,
      input.actor.type,
      input.actor.id,
      input.decision,
      input.businessOperationId,
      stableJson({
        commandKey: input.commandKey,
        evidenceReference: input.evidence.reference,
        receiptId: receipt.id,
        resultingVersion: Number(receipt.resulting_version),
      }),
    ],
  );
}

function normalizeInput(input: PublicationControlInput): NormalizedControlInput {
  if (!input || typeof input !== "object") throw new Error("publication control input is required");
  if (![
    "confirm_occurred",
    "confirm_not_occurred",
    "authorize_retry",
    "abandon_publication",
  ].includes(input.decision)) {
    throw new Error("invalid publication control decision");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error("expected publication version must be a non-negative safe integer");
  }
  if (!input.actor || (input.actor.type !== "user" && input.actor.type !== "service")) {
    throw new Error("publication control actor type must be user or service");
  }
  if (!input.evidence || input.evidence.kind !== "provider_confirmation") {
    throw new PublicationControlEvidenceError("provider confirmation evidence is required");
  }
  if (input.decision !== "confirm_occurred" && input.remoteId !== undefined) {
    throw new PublicationControlEvidenceError("remote ID is only valid when confirming occurrence");
  }
  const normalized: NormalizedControlInput = {
    ...input,
    tenantId: requiredText(input.tenantId, "tenant ID"),
    businessOperationId: requiredText(input.businessOperationId, "business operation ID"),
    commandKey: requiredText(input.commandKey, "command key"),
    actor: { ...input.actor, id: requiredText(input.actor.id, "actor ID") },
    evidence: {
      ...structuredClone(input.evidence),
      reference: requiredText(input.evidence.reference, "provider evidence reference"),
    },
    remoteId: input.remoteId === undefined ? undefined : requiredText(input.remoteId, "remote ID"),
  };
  return normalized;
}

function mapReceipt(row: ReceiptRow): PublicationControlReceipt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    businessOperationId: row.business_operation_id,
    commandKey: row.command_key,
    decision: row.decision,
    previousStatus: row.previous_status,
    resultingStatus: row.resulting_status,
    previousVersion: Number(row.previous_version),
    resultingVersion: Number(row.resulting_version),
    createdAt: row.created_at.toISOString(),
  };
}

export class PublicationControlCommandConflictError extends Error {
  constructor(readonly commandKey: string) {
    super(`publication control command key conflict: ${commandKey}`);
    this.name = "PublicationControlCommandConflictError";
  }
}

export class PublicationControlRecoveryClaimError extends Error {
  constructor(readonly businessOperationId: string) {
    super(`publication operation has an active recovery claim: ${businessOperationId}`);
    this.name = "PublicationControlRecoveryClaimError";
  }
}

export class PublicationControlVersionConflictError extends Error {
  constructor(
    readonly businessOperationId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`publication operation version conflict: expected ${expectedVersion}, found ${actualVersion}`);
    this.name = "PublicationControlVersionConflictError";
  }
}

export class PublicationControlStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationControlStateError";
  }
}

export class PublicationControlEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationControlEvidenceError";
  }
}

export class PublicationControlAuthorityError extends Error {
  constructor() {
    super("publication control authority is inactive or generation-mismatched");
    this.name = "PublicationControlAuthorityError";
  }
}

export class PublicationControlOperationNotFoundError extends Error {
  constructor(readonly businessOperationId: string) {
    super(`publication operation was not found: ${businessOperationId}`);
    this.name = "PublicationControlOperationNotFoundError";
  }
}

function requiredText(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} must be non-empty`);
  }
  return value.trim();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("control input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  throw new Error("control input must be JSON serializable");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
