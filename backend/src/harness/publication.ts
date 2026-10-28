import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { HarnessDatabase } from "./postgres/database.js";
import { normalizeIntegrationTarget } from "./postgres/run-store.js";
import { withPublicationWriteAuthority } from "./write-boundary.js";

export type PublicationPlatform = "github" | "gitlab";
export type PublicationOperationStatus =
  | "prepared"
  | "in_flight"
  | "succeeded"
  | "unknown"
  | "manual_review"
  | "failed_definite"
  | "cancelled";
export type PublicationOutcomeCode =
  | "current"
  | "stale"
  | "rejected"
  | "no_effect"
  | "not_occurred_confirmed"
  | "publication_abandoned";

export type PublicationPayload = Readonly<Record<string, unknown>>;

export interface PublicationScope {
  tenantId: string;
  integrationId: string;
  platform: PublicationPlatform;
  origin: string;
  repository: string;
  target: string;
  revision: string;
  /** Required for enrolled durable-publication bindings; omitted only by blocked generation-0 prototypes. */
  authorityGeneration?: number;
}

export interface PublicationRequest {
  scope: PublicationScope;
  slot: string;
  payload: Record<string, unknown>;
}

export interface PublicationOperation {
  businessOperationId: string;
  scope: PublicationScope;
  slot: string;
  payloadHash: string;
  /** Undefined only for operations created before frozen payload persistence existed. */
  payload?: PublicationPayload;
  marker: string;
  status: PublicationOperationStatus;
  outcomeCode?: PublicationOutcomeCode;
  remoteId?: string;
  attemptCount: number;
  version: number;
  lastErrorCode?: string;
}

export interface PublicationResult {
  businessOperationId: string;
  marker: string;
  remoteId: string;
  reused: boolean;
  reconciled: boolean;
}

export interface PublicationRemoteResult {
  id: string | number;
  /** Verified provider facts only. Never include credentials or remote body content. */
  evidence?: Record<string, unknown>;
}

export interface PublicationAdapter {
  /** Optional read-only work that must finish before a dispatch claim is authorized. */
  preflight?(marker: string, payload: PublicationPayload): Promise<void>;
  /** Performs exactly one platform dispatch attempt with the frozen payload. */
  dispatch(
    marker: string,
    payload: PublicationPayload,
    operation: PublicationOperation,
  ): Promise<PublicationRemoteResult>;
  /** Read-only lookup. Null is not proof that an external effect did not occur. */
  find(
    marker: string,
    payload: PublicationPayload,
    operation: PublicationOperation,
  ): Promise<PublicationRemoteResult | null>;
  currentRevision?(): Promise<string>;
}

export interface PreparedOperationInput {
  businessOperationId: string;
  marker: string;
  payloadHash: string;
  payload: PublicationPayload;
  scope: PublicationScope;
  slot: string;
}

export type PreparedPublication =
  | { action: "dispatch"; operation: PublicationOperation }
  | { action: "reconcile"; operation: PublicationOperation }
  | { action: "reuse"; operation: PublicationOperation };

export interface PublicationStore {
  prepareAndClaim(input: PreparedOperationInput): Promise<PreparedPublication>;
  get(tenantId: string, businessOperationId: string): Promise<PublicationOperation | undefined>;
  getForReconciliation?(
    tenantId: string,
    businessOperationId: string,
  ): Promise<PublicationOperation | undefined>;
  listUnresolved?(
    tenantId: string,
    integrationId: string,
    limit: number,
  ): Promise<PublicationOperation[]>;
  resolve(
    tenantId: string,
    businessOperationId: string,
    expectedVersion: number,
    result: {
      status: "succeeded" | "unknown" | "manual_review" | "failed_definite";
      outcomeCode?: PublicationOutcomeCode;
      remoteId?: string;
      errorCode?: string;
      evidenceJson?: Record<string, unknown>;
      commandReceiptJson?: Record<string, unknown>;
    },
  ): Promise<PublicationOperation | undefined>;
}

export class PublicationService {
  constructor(private readonly store: PublicationStore) {}

  async publish(request: PublicationRequest, adapter: PublicationAdapter): Promise<PublicationResult> {
    const input = buildPublicationIdentity(request);
    const existing = await this.store.get(input.scope.tenantId, input.businessOperationId);
    if (existing && isPossiblyDispatched(existing.status)) {
      const prepared = await this.store.prepareAndClaim(input);
      if (prepared.action !== "reconcile") {
        throw new Error("possibly dispatched publication did not enter reconciliation");
      }
      return this.reconcile(prepared.operation, adapter);
    }
    if (existing?.status === "manual_review") {
      throw new PendingPublicationError(existing.businessOperationId);
    }
    if (existing?.status === "failed_definite" || existing?.status === "cancelled") {
      await this.store.prepareAndClaim(input);
      throw terminalFailure(existing);
    }
    try {
      await this.preflight(input, adapter);
    } catch (error) {
      if (existing?.status === "prepared") {
        if (error instanceof StalePublicationError) {
          await this.resolvePreparedFailure(existing, "stale", "stale_before_dispatch");
        } else if (error instanceof PublicationDefiniteFailureError) {
          await this.resolvePreparedFailure(existing, "no_effect", error.code);
        }
      }
      throw error;
    }
    const prepared = await this.store.prepareAndClaim(input);
    if (prepared.action === "reuse") {
      return toCurrentResult(prepared.operation, true, false);
    }
    if (prepared.action === "reconcile") {
      return this.reconcile(prepared.operation, adapter);
    }

    const payload = prepared.operation.payload;
    if (!payload) {
      const error = new PublicationDefiniteFailureError(
        prepared.operation.businessOperationId,
        "frozen_payload_unavailable",
      );
      await this.resolveDefiniteFailure(prepared.operation, error, "no_effect");
      throw error;
    }
    let remote: PublicationRemoteResult;
    try {
      remote = await withPublicationWriteAuthority(prepared.operation, () =>
        adapter.dispatch(prepared.operation.marker, payload, prepared.operation));
    } catch (error) {
      if (error instanceof PublicationDefiniteFailureError) {
        await this.resolveDefiniteFailure(prepared.operation, error);
        throw error;
      }
      await this.bestEffortUnknown(prepared.operation, "dispatch_result_unknown");
      throw new PendingPublicationError(prepared.operation.businessOperationId, { cause: error });
    }
    let remoteId: string;
    try {
      remoteId = normalizeRemoteId(remote.id);
    } catch (error) {
      await this.bestEffortUnknown(prepared.operation, "dispatch_remote_id_invalid");
      throw new PendingPublicationError(prepared.operation.businessOperationId, { cause: error });
    }
    const outcomeCode = await this.resolveRevisionAfterDispatch(prepared.operation, adapter);
    let resolved: PublicationOperation | undefined;
    try {
      resolved = await this.store.resolve(
        prepared.operation.scope.tenantId,
        prepared.operation.businessOperationId,
        prepared.operation.version,
        { status: "succeeded", outcomeCode, remoteId, evidenceJson: remote.evidence },
      );
    } catch (error) {
      throw new PendingPublicationError(prepared.operation.businessOperationId, { cause: error });
    }
    const finalOperation = resolved ?? (await this.readRequired(prepared.operation));
    return toCurrentResult(finalOperation, false, false);
  }

  async reconcileOperation(
    tenantId: string,
    operationId: string,
    adapter: PublicationAdapter,
    expectedVersion?: number,
  ): Promise<PublicationResult> {
    const operation = this.store.getForReconciliation
      ? await this.store.getForReconciliation(tenantId, operationId)
      : await this.store.get(tenantId, operationId);
    if (!operation) throw new PublicationOperationNotFoundError(operationId);
    if (expectedVersion !== undefined && operation.version !== expectedVersion) {
      throw new PublicationOperationVersionConflictError(
        operationId,
        expectedVersion,
        operation.version,
      );
    }
    if (operation.status === "succeeded") return toCurrentResult(operation, true, true);
    if (operation.status === "failed_definite" || operation.status === "cancelled") {
      throw terminalFailure(operation);
    }
    if (operation.status === "prepared") {
      throw new PublicationPreflightError(
        operation.businessOperationId,
        "operation_not_dispatched",
      );
    }
    return this.reconcile(operation, adapter);
  }

  private async reconcile(
    operation: PublicationOperation,
    adapter: PublicationAdapter,
  ): Promise<PublicationResult> {
    const payload = operation.payload;
    if (!payload) {
      const cause = new PublicationDefiniteFailureError(
        operation.businessOperationId,
        "frozen_payload_unavailable",
      );
      await this.bestEffortManualReview(operation, cause.code);
      throw new PendingPublicationError(operation.businessOperationId, { cause });
    }
    let remote: PublicationRemoteResult | null;
    try {
      remote = await adapter.find(operation.marker, payload, operation);
    } catch (error) {
      if (error instanceof PublicationLookupIndeterminateError) {
        await this.bestEffortManualReview(operation, error.code);
        throw new PendingPublicationError(operation.businessOperationId, { cause: error });
      }
      await this.bestEffortUnknown(operation, "reconcile_query_failed");
      throw new PendingPublicationError(operation.businessOperationId, { cause: error });
    }
    if (!remote) {
      await this.bestEffortUnknown(operation, "remote_effect_not_yet_confirmed");
      throw new PendingPublicationError(operation.businessOperationId);
    }
    const outcomeCode = await this.resolveRevisionAfterDispatch(operation, adapter);
    let remoteId: string;
    try {
      remoteId = normalizeRemoteId(remote.id);
    } catch (error) {
      await this.bestEffortUnknown(operation, "reconcile_remote_id_invalid");
      throw new PendingPublicationError(operation.businessOperationId, { cause: error });
    }
    let resolved: PublicationOperation | undefined;
    try {
      resolved = await this.store.resolve(
        operation.scope.tenantId,
        operation.businessOperationId,
        operation.version,
        { status: "succeeded", outcomeCode, remoteId, evidenceJson: remote.evidence },
      );
    } catch (error) {
      throw new PendingPublicationError(operation.businessOperationId, { cause: error });
    }
    const finalOperation = resolved ?? (await this.readRequired(operation));
    return toCurrentResult(finalOperation, false, true);
  }

  private async preflight(
    input: PreparedOperationInput,
    adapter: PublicationAdapter,
  ): Promise<void> {
    try {
      await adapter.preflight?.(input.marker, input.payload);
    } catch (error) {
      if (
        error instanceof PublicationPreflightError ||
        error instanceof PublicationDefiniteFailureError
      ) {
        throw error;
      }
      throw new PublicationPreflightError(input.businessOperationId, "preflight_failed", { cause: error });
    }
    if (!adapter.currentRevision) return;
    let currentRevision: string;
    try {
      currentRevision = await adapter.currentRevision();
    } catch (error) {
      throw new PublicationPreflightError(
        input.businessOperationId,
        "pre_dispatch_revision_unknown",
        { cause: error },
      );
    }
    if (currentRevision !== input.scope.revision) {
      throw new StalePublicationError(input.businessOperationId);
    }
  }

  private async resolvePreparedFailure(
    operation: PublicationOperation,
    outcomeCode: "stale" | "no_effect",
    errorCode: string,
  ): Promise<void> {
    const resolved = await this.store.resolve(
      operation.scope.tenantId,
      operation.businessOperationId,
      operation.version,
      { status: "failed_definite", outcomeCode, errorCode },
    );
    if (!resolved) {
      const current = await this.readRequired(operation);
      if (current.status !== "failed_definite") {
        throw new PendingPublicationError(operation.businessOperationId);
      }
    }
  }

  private async resolveDefiniteFailure(
    operation: PublicationOperation,
    error: PublicationDefiniteFailureError,
    outcomeCode: "rejected" | "no_effect" = "rejected",
  ): Promise<void> {
    try {
      const resolved = await this.store.resolve(
        operation.scope.tenantId,
        operation.businessOperationId,
        operation.version,
        {
          status: "failed_definite",
          outcomeCode,
          errorCode: error.code,
          evidenceJson: error.status === undefined ? undefined : { status: error.status },
        },
      );
      if (!resolved) {
        const current = await this.readRequired(operation);
        if (current.status !== "failed_definite") {
          throw new Error("definite publication failure was not persisted");
        }
      }
    } catch (cause) {
      throw new PendingPublicationError(operation.businessOperationId, { cause });
    }
  }

  private async resolveRevisionAfterDispatch(
    operation: PublicationOperation,
    adapter: PublicationAdapter,
  ): Promise<"current" | "stale"> {
    if (!adapter.currentRevision) return "current";
    try {
      return (await adapter.currentRevision()) === operation.scope.revision ? "current" : "stale";
    } catch (error) {
      await this.bestEffortUnknown(operation, "post_dispatch_revision_unknown");
      throw new PendingPublicationError(operation.businessOperationId, { cause: error });
    }
  }

  private async bestEffortUnknown(operation: PublicationOperation, errorCode: string): Promise<void> {
    try {
      await this.store.resolve(
        operation.scope.tenantId,
        operation.businessOperationId,
        operation.version,
        { status: "unknown", errorCode },
      );
    } catch {
      // Persistence loss cannot authorize another external dispatch.
    }
  }

  private async readRequired(operation: PublicationOperation): Promise<PublicationOperation> {
    let current: PublicationOperation | undefined;
    try {
      current = await this.store.get(
        operation.scope.tenantId,
        operation.businessOperationId,
      );
    } catch (error) {
      throw new PendingPublicationError(operation.businessOperationId, { cause: error });
    }
    if (!current) throw new PendingPublicationError(operation.businessOperationId);
    return current;
  }

  private async bestEffortManualReview(
    operation: PublicationOperation,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.store.resolve(
        operation.scope.tenantId,
        operation.businessOperationId,
        operation.version,
        { status: "manual_review", errorCode },
      );
    } catch {
      // Persistence loss cannot authorize another external dispatch.
    }
  }
}

export class PgPublicationStore implements PublicationStore {
  constructor(private readonly db: HarnessDatabase) {}

  async prepareAndClaim(input: PreparedOperationInput): Promise<PreparedPublication> {
    return this.db.transaction(input.scope.tenantId, async (client) => {
      await preparePublicationInTransaction(client, input);

      const claimed = await client.query<PublicationRow>(
        `
          UPDATE pr_agent_harness.repository_operations
          SET status = 'in_flight', attempt_count = attempt_count + 1,
              version = version + 1, dispatched_at = now(), updated_at = now(),
              last_error_code = NULL
          WHERE tenant_id = $1 AND business_operation_id = $2 AND status = 'prepared'
          RETURNING *
        `,
        [input.scope.tenantId, input.businessOperationId],
      );
      if (claimed.rows[0]) {
        const operation = mapOperation(claimed.rows[0]);
        await auditPublication(client, operation, "publication.dispatch_claimed", "allowed");
        return { action: "dispatch", operation };
      }

      const operation = await selectOperation(client, input.scope.tenantId, input.businessOperationId);
      if (!operation) throw new Error("prepared publication operation disappeared");
      if (operation.status === "succeeded") {
        return { action: "reuse", operation };
      }
      if (isUnresolved(operation.status)) {
        return { action: "reconcile", operation };
      }
      if (operation.status === "failed_definite" || operation.status === "cancelled") {
        throw terminalFailure(operation);
      }
      throw new PublicationSlotConflictError(operation.businessOperationId, operation.status);
    });
  }

  async get(
    tenantId: string,
    businessOperationId: string,
  ): Promise<PublicationOperation | undefined> {
    return this.db.transaction(tenantId, (client) =>
      selectOperation(client, tenantId, businessOperationId),
    );
  }

  async getForReconciliation(
    tenantId: string,
    businessOperationId: string,
  ): Promise<PublicationOperation | undefined> {
    return this.db.transaction(tenantId, async (client) => {
      const operation = await selectOperation(client, tenantId, businessOperationId);
      if (operation) await assertActiveIntegrationBinding(client, operation.scope);
      return operation;
    });
  }

  async listUnresolved(
    tenantId: string,
    integrationId: string,
    limit: number,
  ): Promise<PublicationOperation[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("unresolved publication limit must be a positive safe integer");
    }
    const boundedLimit = Math.min(500, limit);
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<PublicationRow>(
        `
          SELECT business_operation_id, tenant_id, integration_id, platform, origin,
                 repository, target, revision, authority_generation, publication_slot,
                 payload_hash, payload_json,
                 marker, status, outcome_code, remote_id, attempt_count, version,
                 last_error_code
          FROM pr_agent_harness.repository_operations
          WHERE tenant_id = $1 AND integration_id = $2
            AND status IN ('in_flight', 'unknown', 'manual_review')
          ORDER BY updated_at ASC, business_operation_id ASC
          LIMIT $3
        `,
        [tenantId, integrationId, boundedLimit],
      );
      return result.rows.map(mapOperation);
    });
  }

  async resolve(
    tenantId: string,
    businessOperationId: string,
    expectedVersion: number,
    result: {
      status: "succeeded" | "unknown" | "manual_review" | "failed_definite";
      outcomeCode?: PublicationOutcomeCode;
      remoteId?: string;
      errorCode?: string;
      evidenceJson?: Record<string, unknown>;
      commandReceiptJson?: Record<string, unknown>;
    },
  ): Promise<PublicationOperation | undefined> {
    validateResolution(result);
    return this.db.transaction(tenantId, async (client) => {
      const updated = await client.query<PublicationRow>(
        `
          UPDATE pr_agent_harness.repository_operations
          SET status = $4,
              outcome_code = $5,
              remote_id = $6,
              last_error_code = $7,
              evidence_json = COALESCE($8::jsonb, evidence_json),
              command_receipt_json = COALESCE($9::jsonb, command_receipt_json),
              resolved_at = CASE WHEN $4 IN ('succeeded', 'failed_definite') THEN now() ELSE NULL END,
              version = version + 1,
              updated_at = now()
          WHERE tenant_id = $1 AND business_operation_id = $2 AND version = $3
            AND (
              status IN ('in_flight', 'unknown', 'manual_review')
              OR (
                status = 'prepared' AND $4 = 'failed_definite'
                AND $5 IN ('stale', 'no_effect')
              )
            )
          RETURNING *
        `,
        [
          tenantId,
          businessOperationId,
          expectedVersion,
          result.status,
          result.outcomeCode ?? null,
          result.remoteId ?? null,
          result.errorCode ?? null,
          result.evidenceJson ? stableJson(result.evidenceJson) : null,
          result.commandReceiptJson ? stableJson(result.commandReceiptJson) : null,
        ],
      );
      if (!updated.rows[0]) return undefined;
      const operation = mapOperation(updated.rows[0]);
      await auditPublication(
        client,
        operation,
        "publication.resolved",
        result.status === "unknown" || result.status === "manual_review" ? "error" : "allowed",
      );
      return operation;
    });
  }

}

export async function preparePublicationInTransaction(
  client: PoolClient,
  input: PreparedOperationInput,
): Promise<PublicationOperation> {
  await assertActiveIntegrationBinding(client, input.scope);
  await insertOperation(client, input);
  await lockPublicationSlot(client, input);
  const operation = await selectOperation(client, input.scope.tenantId, input.businessOperationId);
  if (!operation) throw new Error("prepared publication operation disappeared");
  return operation;
}

async function insertOperation(client: PoolClient, input: PreparedOperationInput): Promise<void> {
  await client.query(
    `
      INSERT INTO pr_agent_harness.repository_operations (
        tenant_id, integration_id, business_operation_id, platform, origin,
        repository, target, revision, authority_generation, publication_slot,
        payload_hash, payload_json, marker
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
      ON CONFLICT (tenant_id, business_operation_id) DO NOTHING
    `,
    [
      input.scope.tenantId,
      input.scope.integrationId,
      input.businessOperationId,
      input.scope.platform,
      input.scope.origin,
      input.scope.repository,
      input.scope.target,
      input.scope.revision,
      input.scope.authorityGeneration ?? null,
      input.slot,
      input.payloadHash,
      stableJson(input.payload),
      input.marker,
    ],
  );
  const existing = await selectOperation(client, input.scope.tenantId, input.businessOperationId);
  if (!existing || !sameIntent(existing, input)) {
    throw new PublicationIdentityConflictError(input.businessOperationId);
  }
}

async function lockPublicationSlot(
  client: PoolClient,
  input: PreparedOperationInput,
): Promise<void> {
  await client.query(
    `
      INSERT INTO pr_agent_harness.publication_slots (
        tenant_id, integration_id, target, publication_slot, active_business_operation_id
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, integration_id, target, publication_slot) DO NOTHING
    `,
    [
      input.scope.tenantId,
      input.scope.integrationId,
      input.scope.target,
      input.slot,
      input.businessOperationId,
    ],
  );
  const slot = await client.query<{ active_business_operation_id: string }>(
    `
      SELECT active_business_operation_id
      FROM pr_agent_harness.publication_slots
      WHERE tenant_id = $1 AND integration_id = $2 AND target = $3 AND publication_slot = $4
      FOR UPDATE
    `,
    [input.scope.tenantId, input.scope.integrationId, input.scope.target, input.slot],
  );
  const activeOperationId = slot.rows[0]?.active_business_operation_id;
  if (!activeOperationId) throw new Error("publication slot disappeared while preparing operation");
  if (activeOperationId === input.businessOperationId) return;

  const active = await selectOperation(client, input.scope.tenantId, activeOperationId);
  if (!active) throw new Error("publication slot references a missing operation");
  if (isUnresolved(active.status)) {
    throw new PublicationSlotConflictError(active.businessOperationId, active.status);
  }
  await client.query(
    `
      UPDATE pr_agent_harness.publication_slots
      SET active_business_operation_id = $5, generation = generation + 1, updated_at = now()
      WHERE tenant_id = $1 AND integration_id = $2 AND target = $3 AND publication_slot = $4
    `,
    [
      input.scope.tenantId,
      input.scope.integrationId,
      input.scope.target,
      input.slot,
      input.businessOperationId,
    ],
  );
}

export class PendingPublicationError extends Error {
  constructor(
    readonly businessOperationId: string,
    options?: ErrorOptions,
  ) {
    super("publication result is unknown and requires reconciliation", options);
    this.name = "PendingPublicationError";
  }
}

export class PublicationPreflightError extends Error {
  readonly retryable = true;
  readonly noExternalEffect = true;

  constructor(
    readonly businessOperationId: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(`publication preflight failed before dispatch: ${code}`, options);
    this.name = "PublicationPreflightError";
  }
}

export class PublicationDefiniteFailureError extends Error {
  readonly retryable = false;
  readonly noExternalEffect = true;

  constructor(
    readonly businessOperationId: string,
    readonly code: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(`publication was definitely rejected: ${code}`, options);
    this.name = "PublicationDefiniteFailureError";
  }
}

export class PublicationLookupIndeterminateError extends Error {
  constructor(readonly code = "lookup_indeterminate", options?: ErrorOptions) {
    super("publication lookup ended before absence could be established", options);
    this.name = "PublicationLookupIndeterminateError";
  }
}

export class PublicationOperationNotFoundError extends Error {
  constructor(readonly businessOperationId: string) {
    super(`publication operation was not found: ${businessOperationId}`);
    this.name = "PublicationOperationNotFoundError";
  }
}

export class PublicationOperationVersionConflictError extends Error {
  constructor(
    readonly businessOperationId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`publication operation version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = "PublicationOperationVersionConflictError";
  }
}

export class StalePublicationError extends Error {
  constructor(
    readonly businessOperationId: string,
    readonly remoteId?: string,
  ) {
    super("publication does not apply to the current revision");
    this.name = "StalePublicationError";
  }
}

export class PublicationSlotConflictError extends Error {
  constructor(
    readonly businessOperationId: string,
    readonly operationStatus: PublicationOperationStatus,
  ) {
    super(`publication slot is occupied by ${operationStatus} operation ${businessOperationId}`);
    this.name = "PublicationSlotConflictError";
  }
}

export class PublicationIdentityConflictError extends Error {
  constructor(readonly businessOperationId: string) {
    super(`publication operation identity conflict: ${businessOperationId}`);
    this.name = "PublicationIdentityConflictError";
  }
}

export class InactiveIntegrationBindingError extends Error {
  constructor() {
    super("publication integration binding is missing, inactive, or outside its trusted scope");
    this.name = "InactiveIntegrationBindingError";
  }
}

export function buildPublicationIdentity(request: PublicationRequest): PreparedOperationInput {
  const scope = normalizeScope(request.scope);
  const slot = requiredText(request.slot, "publication slot");
  const canonicalPayload = stableJson(request.payload);
  const payload = deepFreeze(JSON.parse(canonicalPayload) as Record<string, unknown>);
  const payloadHash = sha256(canonicalPayload);
  const businessOperationId = sha256(
    stableJson({
      ...(scope.authorityGeneration === undefined
        ? {}
        : { authorityGeneration: scope.authorityGeneration }),
      integrationId: scope.integrationId,
      origin: scope.origin,
      platform: scope.platform,
      repository: scope.repository,
      revision: scope.revision,
      slot,
      target: scope.target,
      tenantId: scope.tenantId,
      payloadHash,
    }),
  );
  return {
    businessOperationId,
    marker: `<!-- pr-agent-operation:${businessOperationId} -->`,
    payloadHash,
    payload,
    scope,
    slot,
  };
}

function normalizeScope(scope: PublicationScope): PublicationScope {
  if (scope.platform !== "github" && scope.platform !== "gitlab") {
    throw new Error("publication platform must be github or gitlab");
  }
  const target = normalizeIntegrationTarget(scope.platform, scope.origin, scope.repository);
  if (
    scope.authorityGeneration !== undefined &&
    (!Number.isSafeInteger(scope.authorityGeneration) || scope.authorityGeneration < 0)
  ) {
    throw new Error("publication authority generation must be a non-negative safe integer");
  }
  return {
    tenantId: requiredText(scope.tenantId, "tenant ID"),
    integrationId: requiredText(scope.integrationId, "integration ID"),
    platform: scope.platform,
    origin: target.origin,
    repository: target.repository,
    target: requiredText(scope.target, "publication target"),
    revision: requiredText(scope.revision, "publication revision"),
    authorityGeneration: scope.authorityGeneration,
  };
}

function sameIntent(operation: PublicationOperation, input: PreparedOperationInput): boolean {
  return (
    operation.businessOperationId === input.businessOperationId &&
    operation.scope.tenantId === input.scope.tenantId &&
    operation.scope.integrationId === input.scope.integrationId &&
    operation.scope.platform === input.scope.platform &&
    operation.scope.origin === input.scope.origin &&
    operation.scope.repository === input.scope.repository &&
    operation.scope.target === input.scope.target &&
    operation.scope.revision === input.scope.revision &&
    operation.scope.authorityGeneration === input.scope.authorityGeneration &&
    operation.slot === input.slot &&
    operation.payloadHash === input.payloadHash &&
    (operation.payload === undefined || stableJson(operation.payload) === stableJson(input.payload)) &&
    operation.marker === input.marker
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function terminalFailure(operation: PublicationOperation): PublicationDefiniteFailureError {
  return new PublicationDefiniteFailureError(
    operation.businessOperationId,
    operation.lastErrorCode ?? operation.outcomeCode ?? operation.status,
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("publication payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("publication payload must be JSON serializable");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value: string, description: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${description} must be non-empty`);
  return normalized;
}

function normalizeRemoteId(value: string | number): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("publication adapter returned an invalid remote ID type");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("publication adapter returned a non-finite remote ID");
  }
  const normalized = String(value).trim();
  if (!normalized) throw new Error("publication adapter returned an empty remote ID");
  return normalized;
}

function isUnresolved(status: PublicationOperationStatus): boolean {
  return (
    status === "prepared" ||
    status === "in_flight" ||
    status === "unknown" ||
    status === "manual_review"
  );
}

function isPossiblyDispatched(status: PublicationOperationStatus): boolean {
  return status === "in_flight" || status === "unknown";
}

function validateResolution(result: {
  status: "succeeded" | "unknown" | "manual_review" | "failed_definite";
  outcomeCode?: PublicationOutcomeCode;
  remoteId?: string;
}): void {
  if (result.status === "succeeded" && (!result.outcomeCode || !result.remoteId)) {
    throw new Error("successful publication requires outcome code and remote ID");
  }
  if (
    (result.status === "unknown" || result.status === "manual_review") &&
    (result.outcomeCode || result.remoteId)
  ) {
    throw new Error("unresolved publication cannot claim a remote outcome");
  }
  if (result.status === "failed_definite" && result.remoteId) {
    throw new Error("definite publication failure cannot claim a remote ID");
  }
}

function toCurrentResult(
  operation: PublicationOperation,
  reused: boolean,
  reconciled: boolean,
): PublicationResult {
  if (operation.status !== "succeeded" || operation.outcomeCode !== "current" || !operation.remoteId) {
    if (operation.outcomeCode === "stale") {
      throw new StalePublicationError(operation.businessOperationId, operation.remoteId);
    }
    throw new PendingPublicationError(operation.businessOperationId);
  }
  return {
    businessOperationId: operation.businessOperationId,
    marker: operation.marker,
    remoteId: operation.remoteId,
    reused,
    reconciled,
  };
}

interface PublicationRow {
  business_operation_id: string;
  tenant_id: string;
  integration_id: string;
  platform: PublicationPlatform;
  origin: string;
  repository: string;
  target: string;
  revision: string;
  authority_generation: string | null;
  publication_slot: string;
  payload_hash: string;
  payload_json: Record<string, unknown> | null;
  marker: string;
  status: PublicationOperationStatus;
  outcome_code: PublicationOutcomeCode | null;
  remote_id: string | null;
  attempt_count: number;
  version: string;
  last_error_code: string | null;
}

async function selectOperation(
  client: PoolClient,
  tenantId: string,
  businessOperationId: string,
): Promise<PublicationOperation | undefined> {
  const result = await client.query<PublicationRow>(
    `
      SELECT business_operation_id, tenant_id, integration_id, platform, origin,
             repository, target, revision, authority_generation, publication_slot,
             payload_hash, payload_json, marker,
             status, outcome_code, remote_id, attempt_count, version, last_error_code
      FROM pr_agent_harness.repository_operations
      WHERE tenant_id = $1 AND business_operation_id = $2
    `,
    [tenantId, businessOperationId],
  );
  return result.rows[0] ? mapOperation(result.rows[0]) : undefined;
}

async function assertActiveIntegrationBinding(
  client: PoolClient,
  scope: PublicationScope,
): Promise<void> {
  const binding = await client.query<{
    active: boolean;
    publication_generation: string;
    publication_state: "blocked" | "active" | "draining";
  }>(
    `
      SELECT active, publication_generation, publication_state
      FROM pr_agent_harness.integration_bindings
      WHERE tenant_id = $1 AND id = $2 AND platform = $3
        AND origin = $4 AND repository = $5
    `,
    [
      scope.tenantId,
      scope.integrationId,
      scope.platform,
      scope.origin,
      scope.repository,
    ],
  );
  const row = binding.rows[0];
  const authorityMatches = scope.authorityGeneration === undefined
    ? row?.publication_state === "blocked" && Number(row.publication_generation) === 0
    : (row?.publication_state === "active" || row?.publication_state === "draining") &&
      Number(row.publication_generation) === scope.authorityGeneration;
  if (row?.active !== true || !authorityMatches) {
    throw new InactiveIntegrationBindingError();
  }
}

async function auditPublication(
  client: PoolClient,
  operation: PublicationOperation,
  action: "publication.dispatch_claimed" | "publication.resolved",
  decision: "allowed" | "error",
): Promise<void> {
  await client.query(
    `
      INSERT INTO pr_agent_harness.audit_logs (
        tenant_id, actor_type, actor_id, action, decision,
        reason_code, resource_type, resource_ref, details_json
      ) VALUES ($1, 'system', 'publication-service', $2, $3, $4,
                'repository_operation', $5, $6::jsonb)
    `,
    [
      operation.scope.tenantId,
      action,
      decision,
      operation.lastErrorCode ?? null,
      operation.businessOperationId,
      JSON.stringify({
        attemptCount: operation.attemptCount,
        outcomeCode: operation.outcomeCode ?? null,
        status: operation.status,
        version: operation.version,
      }),
    ],
  );
}

function mapOperation(row: PublicationRow): PublicationOperation {
  return {
    businessOperationId: row.business_operation_id,
    scope: {
      tenantId: row.tenant_id,
      integrationId: row.integration_id,
      platform: row.platform,
      origin: row.origin,
      repository: row.repository,
      target: row.target,
      revision: row.revision,
      authorityGeneration: row.authority_generation === null
        ? undefined
        : Number(row.authority_generation),
    },
    slot: row.publication_slot,
    payloadHash: row.payload_hash,
    payload: row.payload_json
      ? deepFreeze(structuredClone(row.payload_json))
      : undefined,
    marker: row.marker,
    status: row.status,
    outcomeCode: row.outcome_code ?? undefined,
    remoteId: row.remote_id ?? undefined,
    attemptCount: Number(row.attempt_count),
    version: Number(row.version),
    lastErrorCode: row.last_error_code ?? undefined,
  };
}
