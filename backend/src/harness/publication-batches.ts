import type { PoolClient } from "pg";

import { HarnessDatabase } from "./postgres/database.js";
import {
  buildPublicationIdentity,
  InactiveIntegrationBindingError,
  PendingPublicationError,
  preparePublicationInTransaction,
  PublicationDefiniteFailureError,
  PublicationSlotConflictError,
  StalePublicationError,
  type PublicationAdapter,
  type PublicationOperation,
  type PublicationRequest,
  type PublicationScope,
  type PublicationService,
} from "./publication.js";

export type PublicationBatchStatus =
  | "pending"
  | "waiting_reconciliation"
  | "succeeded"
  | "failed_definite";

export interface FrozenPublicationBatch {
  id: string;
  scope: PublicationScope;
  sourceKey: string;
  sourceHash: string;
  status: PublicationBatchStatus;
  operations: readonly {
    ordinal: number;
    businessOperationId: string;
    request: PublicationRequest;
    skipped: boolean;
  }[];
}

export interface FreezePublicationBatchInput {
  scope: PublicationScope;
  sourceKey: string;
  sourceHash: string;
  operations: readonly {
    slot: string;
    payload: Record<string, unknown>;
  }[];
}

export type PublicationAdapterFactory = (
  operation: PublicationOperation,
) => Promise<PublicationAdapter>;

export class PublicationBatchStore {
  constructor(private readonly db: HarnessDatabase) {}

  async findBySource(
    scope: PublicationScope,
    sourceKey: string,
    sourceHash: string,
  ): Promise<FrozenPublicationBatch | undefined> {
    const canonicalScope = canonicalizeScope(scope);
    const normalizedSourceKey = requiredText(sourceKey, "source key");
    const normalizedSourceHash = requiredHash(sourceHash, "source hash");
    return this.db.transaction(canonicalScope.tenantId, async (client) => {
      await assertReadableAuthority(client, canonicalScope);
      const batch = await selectBatchBySource(
        client,
        canonicalScope,
        normalizedSourceKey,
      );
      if (!batch) return undefined;
      if (!sameSourceScope(batch.scope, canonicalScope)) {
        throw new PublicationBatchScopeConflictError(normalizedSourceKey, batch.id);
      }
      if (batch.sourceHash !== normalizedSourceHash) {
        throw new PublicationBatchSourceConflictError(normalizedSourceKey, batch.id);
      }
      return batch;
    });
  }

  async freeze(input: FreezePublicationBatchInput): Promise<FrozenPublicationBatch> {
    if (input.scope.authorityGeneration === undefined) {
      throw new InactiveIntegrationBindingError();
    }
    if (input.operations.length === 0) {
      throw new Error("publication batch must contain at least one operation");
    }
    const sourceKey = requiredText(input.sourceKey, "source key");
    const sourceHash = requiredHash(input.sourceHash, "source hash");
    const identities = input.operations.map((operation) =>
      buildPublicationIdentity({
        scope: input.scope,
        slot: operation.slot,
        payload: operation.payload,
      }),
    );
    const scope = identities[0]!.scope;

    return this.db.transaction(scope.tenantId, async (client) => {
      await lockActiveAuthority(client, scope);
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO pr_agent_harness.publication_batches (
            tenant_id, integration_id, platform, origin, repository, target,
            revision, authority_generation, source_key, source_hash
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (tenant_id, integration_id, source_key) DO NOTHING
          RETURNING id
        `,
        [
          scope.tenantId,
          scope.integrationId,
          scope.platform,
          identities[0]!.scope.origin,
          identities[0]!.scope.repository,
          identities[0]!.scope.target,
          identities[0]!.scope.revision,
          scope.authorityGeneration,
          sourceKey,
          sourceHash,
        ],
      );

      if (!inserted.rows[0]) {
        const existing = await selectBatchBySource(client, scope, sourceKey);
        if (!existing || existing.sourceHash !== sourceHash || !sameScope(existing.scope, scope)) {
          throw new PublicationBatchSourceConflictError(sourceKey, existing?.id ?? "unknown");
        }
        return existing;
      }

      const batchId = inserted.rows[0].id;
      for (const identity of [...identities].sort((left, right) =>
        left.slot.localeCompare(right.slot) ||
        left.businessOperationId.localeCompare(right.businessOperationId)
      )) {
        await preparePublicationInTransaction(client, identity);
      }
      for (const identity of [...identities].sort((left, right) =>
        left.businessOperationId.localeCompare(right.businessOperationId)
      )) {
        await lockAndReviveBatchOperation(client, scope.tenantId, identity.businessOperationId);
      }
      for (let ordinal = 0; ordinal < identities.length; ordinal += 1) {
        const identity = identities[ordinal]!;
        await client.query(
          `
            INSERT INTO pr_agent_harness.publication_batch_operations (
              tenant_id, batch_id, ordinal, business_operation_id
            ) VALUES ($1, $2, $3, $4)
          `,
          [scope.tenantId, batchId, ordinal, identity.businessOperationId],
        );
      }
      await sealBatch(client, scope.tenantId, batchId);
      const frozen = await selectBatch(client, scope.tenantId, batchId);
      if (!frozen) throw new Error("frozen publication batch disappeared");
      return frozen;
    });
  }

  async load(tenantId: string, batchId: string): Promise<FrozenPublicationBatch | undefined> {
    return this.db.transaction(tenantId, (client) => selectBatch(client, tenantId, batchId));
  }

  async loadOperation(
    tenantId: string,
    businessOperationId: string,
  ): Promise<PublicationOperation | undefined> {
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<OperationRow>(OPERATION_SELECT, [
        tenantId,
        businessOperationId,
      ]);
      return result.rows[0] ? mapOperation(result.rows[0]) : undefined;
    });
  }

  async listRecoverable(
    tenantId: string,
    integrationId: string,
    limit: number,
  ): Promise<FrozenPublicationBatch[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `
          SELECT id
          FROM pr_agent_harness.publication_batches
          WHERE tenant_id = $1 AND integration_id = $2
            AND status IN ('pending', 'waiting_reconciliation')
            AND seal_state = 'sealed'
          ORDER BY updated_at ASC, id ASC
          LIMIT $3
        `,
        [tenantId, integrationId, boundedLimit],
      );
      const batches = await Promise.all(
        result.rows.map(({ id }) => selectBatch(client, tenantId, id)),
      );
      return batches.filter((batch): batch is FrozenPublicationBatch => batch !== undefined);
    });
  }

  async refreshOutcome(
    tenantId: string,
    batchId: string,
  ): Promise<FrozenPublicationBatch | undefined> {
    return this.db.transaction(tenantId, async (client) => {
      await skipPreparedSuccessors(client, tenantId, batchId);
      const result = await client.query<{ status: PublicationBatchStatus }>(
        `
          WITH operation_states AS (
            SELECT ro.status, ro.outcome_code, pbo.action_state
            FROM pr_agent_harness.publication_batch_operations pbo
            JOIN pr_agent_harness.repository_operations ro
              ON ro.tenant_id = pbo.tenant_id
             AND ro.business_operation_id = pbo.business_operation_id
            WHERE pbo.tenant_id = $1 AND pbo.batch_id = $2
          ), aggregate_state AS (
            SELECT count(*) AS total,
                   count(*) FILTER (
                     WHERE action_state = 'active'
                       AND status = 'succeeded' AND outcome_code = 'current'
                   ) AS succeeded_current,
                   bool_or(
                     action_state = 'skipped'
                     OR (action_state = 'active' AND (
                       status IN ('failed_definite', 'cancelled')
                       OR (status = 'succeeded' AND outcome_code = 'stale')
                     ))
                   ) AS failed,
                   bool_or(
                     action_state = 'active'
                     AND status IN ('in_flight', 'unknown', 'manual_review')
                   ) AS possible_effect
            FROM operation_states
          )
          UPDATE pr_agent_harness.publication_batches pb
          SET status = CASE
                WHEN aggregate_state.total > 0
                 AND aggregate_state.succeeded_current = aggregate_state.total THEN 'succeeded'
                WHEN aggregate_state.possible_effect THEN 'waiting_reconciliation'
                WHEN aggregate_state.failed THEN 'failed_definite'
                ELSE 'pending'
              END,
              updated_at = now()
          FROM aggregate_state
          WHERE pb.tenant_id = $1 AND pb.id = $2 AND pb.seal_state = 'sealed'
          RETURNING pb.status
        `,
        [tenantId, batchId],
      );
      if (!result.rows[0]) return undefined;
      return selectBatch(client, tenantId, batchId);
    });
  }
}

export class PublicationBatchCoordinator {
  constructor(
    private readonly store: PublicationBatchStore,
    private readonly service: PublicationService,
  ) {}

  async execute(
    tenantId: string,
    batchId: string,
    adapterFactory: PublicationAdapterFactory,
  ): Promise<FrozenPublicationBatch> {
    const batch = await this.store.load(tenantId, batchId);
    if (!batch) throw new PublicationBatchNotFoundError(batchId);

    for (const frozen of batch.operations) {
      if (frozen.skipped) continue;
      const operation = await this.store.loadOperation(tenantId, frozen.businessOperationId);
      if (!operation) throw new Error("publication batch references a missing operation");
      if (operation.status === "succeeded") {
        if (operation.outcomeCode === "current") continue;
        break;
      }
      if (operation.status === "failed_definite" || operation.status === "cancelled") break;
      try {
        const adapter = await adapterFactory(operation);
        await this.service.publish(frozen.request, adapter);
      } catch (error) {
        if (
          error instanceof PendingPublicationError ||
          error instanceof PublicationDefiniteFailureError ||
          error instanceof StalePublicationError
        ) {
          break;
        }
        throw error;
      }
    }

    const refreshed = await this.store.refreshOutcome(tenantId, batchId);
    if (!refreshed) throw new PublicationBatchNotFoundError(batchId);
    return refreshed;
  }
}

export class PublicationBatchSourceConflictError extends Error {
  constructor(readonly sourceKey: string, readonly existingBatchId: string) {
    super(`publication batch source key was reused with different content: ${sourceKey}`);
    this.name = "PublicationBatchSourceConflictError";
  }
}

export class PublicationBatchScopeConflictError extends Error {
  constructor(readonly sourceKey: string, readonly existingBatchId: string) {
    super(`publication batch source belongs to a different trusted target: ${sourceKey}`);
    this.name = "PublicationBatchScopeConflictError";
  }
}

export class PublicationBatchNotFoundError extends Error {
  constructor(readonly batchId: string) {
    super(`publication batch was not found: ${batchId}`);
    this.name = "PublicationBatchNotFoundError";
  }
}

export class PublicationBatchPayloadUnavailableError extends Error {
  constructor(readonly batchId: string) {
    super(`sealed publication batch has unavailable frozen payload: ${batchId}`);
    this.name = "PublicationBatchPayloadUnavailableError";
  }
}

interface BatchRow {
  id: string;
  tenant_id: string;
  integration_id: string;
  platform: "github" | "gitlab";
  origin: string;
  repository: string;
  target: string;
  revision: string;
  authority_generation: string;
  source_key: string;
  source_hash: string;
  status: PublicationBatchStatus;
  operation_count: number;
}

interface BatchOperationRow extends BatchRow {
  ordinal: number | null;
  business_operation_id: string | null;
  publication_slot: string | null;
  payload_json: Record<string, unknown> | null;
  action_state: "active" | "skipped" | null;
}

async function sealBatch(client: PoolClient, tenantId: string, batchId: string): Promise<void> {
  const result = await client.query(
    `
      WITH frozen_set AS (
        SELECT count(*)::integer AS operation_count,
               encode(
                 public.digest(
                   string_agg(
                     ordinal::text || ':' || business_operation_id,
                     E'\n' ORDER BY ordinal
                   ),
                   'sha256'
                 ),
                 'hex'
               ) AS operation_set_hash
        FROM pr_agent_harness.publication_batch_operations
        WHERE tenant_id = $1 AND batch_id = $2
      )
      UPDATE pr_agent_harness.publication_batches pb
      SET seal_state = 'sealed', sealed_at = now(),
          operation_count = frozen_set.operation_count,
          operation_set_hash = frozen_set.operation_set_hash,
          updated_at = now()
      FROM frozen_set
      WHERE pb.tenant_id = $1 AND pb.id = $2 AND pb.seal_state = 'building'
    `,
    [tenantId, batchId],
  );
  if (result.rowCount !== 1) throw new Error("publication batch could not be sealed");
}

async function lockAndReviveBatchOperation(
  client: PoolClient,
  tenantId: string,
  businessOperationId: string,
): Promise<void> {
  const result = await client.query<{ status: PublicationOperation["status"] }>(
    `
      SELECT status
      FROM pr_agent_harness.repository_operations
      WHERE tenant_id = $1 AND business_operation_id = $2
      FOR UPDATE
    `,
    [tenantId, businessOperationId],
  );
  const operation = result.rows[0];
  if (!operation) throw new Error("prepared batch operation disappeared before linking");
  if (operation.status === "cancelled") {
    const revived = await client.query(
      `
        UPDATE pr_agent_harness.repository_operations
        SET status = 'prepared', outcome_code = NULL, remote_id = NULL,
            last_error_code = NULL, resolved_at = NULL,
            version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND business_operation_id = $2
          AND status = 'cancelled'
          AND outcome_code = 'publication_abandoned'
          AND last_error_code = 'batch_predecessor_failed'
      `,
      [tenantId, businessOperationId],
    );
    if (revived.rowCount !== 1) {
      throw new PublicationSlotConflictError(businessOperationId, operation.status);
    }
  }
}

async function skipPreparedSuccessors(
  client: PoolClient,
  tenantId: string,
  batchId: string,
): Promise<void> {
  await client.query(
    "SELECT pr_agent_harness.skip_failed_batch_successors($1::uuid, $2::uuid)",
    [tenantId, batchId],
  );
}

async function selectBatchBySource(
  client: PoolClient,
  scope: PublicationScope,
  sourceKey: string,
): Promise<FrozenPublicationBatch | undefined> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM pr_agent_harness.publication_batches
      WHERE tenant_id = $1 AND integration_id = $2 AND source_key = $3
    `,
    [scope.tenantId, scope.integrationId, sourceKey],
  );
  return result.rows[0] ? selectBatch(client, scope.tenantId, result.rows[0].id) : undefined;
}

async function selectBatch(
  client: PoolClient,
  tenantId: string,
  batchId: string,
): Promise<FrozenPublicationBatch | undefined> {
  const result = await client.query<BatchOperationRow>(
    `
      SELECT pb.id, pb.tenant_id, pb.integration_id, pb.platform, pb.origin,
             pb.repository, pb.target, pb.revision, pb.authority_generation,
             pb.source_key, pb.source_hash, pb.status, pb.operation_count,
             pbo.ordinal, pbo.business_operation_id, pbo.action_state,
             ro.publication_slot, ro.payload_json
      FROM pr_agent_harness.publication_batches pb
      LEFT JOIN pr_agent_harness.publication_batch_operations pbo
        ON pbo.tenant_id = pb.tenant_id AND pbo.batch_id = pb.id
      LEFT JOIN pr_agent_harness.repository_operations ro
        ON ro.tenant_id = pbo.tenant_id
       AND ro.business_operation_id = pbo.business_operation_id
      WHERE pb.tenant_id = $1 AND pb.id = $2 AND pb.seal_state = 'sealed'
      ORDER BY pbo.ordinal ASC
    `,
    [tenantId, batchId],
  );
  const first = result.rows[0];
  if (!first) return undefined;
  if (
    result.rows.length !== Number(first.operation_count) ||
    result.rows.some((row) => row.business_operation_id === null || row.payload_json === null)
  ) {
    throw new PublicationBatchPayloadUnavailableError(batchId);
  }
  const scope: PublicationScope = {
    tenantId: first.tenant_id,
    integrationId: first.integration_id,
    platform: first.platform,
    origin: first.origin,
    repository: first.repository,
    target: first.target,
    revision: first.revision,
    authorityGeneration: Number(first.authority_generation),
  };
  return {
    id: first.id,
    scope,
    sourceKey: first.source_key,
    sourceHash: first.source_hash,
    status: first.status,
    operations: result.rows.flatMap((row) => {
      if (
        row.ordinal === null ||
        row.business_operation_id === null ||
        row.publication_slot === null ||
        row.payload_json === null
      ) return [];
      return [{
        ordinal: Number(row.ordinal),
        businessOperationId: row.business_operation_id,
        skipped: row.action_state === "skipped",
        request: deepFreeze({
          scope: { ...scope },
          slot: row.publication_slot,
          payload: structuredClone(row.payload_json),
        }),
      }];
    }),
  };
}

async function lockActiveAuthority(client: PoolClient, scope: PublicationScope): Promise<void> {
  const result = await client.query<{ allowed: boolean }>(
    `
      SELECT pr_agent_harness.lock_active_publication_authority(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint
      ) AS allowed
    `,
    [
      scope.tenantId,
      scope.integrationId,
      scope.platform,
      scope.origin,
      scope.repository,
      scope.authorityGeneration,
    ],
  );
  if (result.rows[0]?.allowed !== true) throw new InactiveIntegrationBindingError();
}

async function assertReadableAuthority(client: PoolClient, scope: PublicationScope): Promise<void> {
  const result = await client.query(
    `
      SELECT 1
      FROM pr_agent_harness.integration_bindings
      WHERE tenant_id = $1 AND id = $2 AND platform = $3
        AND origin = $4 AND repository = $5 AND active
        AND publication_state IN ('active', 'draining')
        AND publication_generation = $6
    `,
    [
      scope.tenantId,
      scope.integrationId,
      scope.platform,
      scope.origin,
      scope.repository,
      scope.authorityGeneration ?? -1,
    ],
  );
  if (result.rowCount !== 1) throw new InactiveIntegrationBindingError();
}

const OPERATION_SELECT = `
  SELECT business_operation_id, tenant_id, integration_id, platform, origin,
         repository, target, revision, authority_generation, publication_slot,
         payload_hash, payload_json, marker, status, outcome_code, remote_id,
         attempt_count, version, last_error_code
  FROM pr_agent_harness.repository_operations
  WHERE tenant_id = $1 AND business_operation_id = $2
`;

interface OperationRow {
  business_operation_id: string;
  tenant_id: string;
  integration_id: string;
  platform: "github" | "gitlab";
  origin: string;
  repository: string;
  target: string;
  revision: string;
  authority_generation: string | null;
  publication_slot: string;
  payload_hash: string;
  payload_json: Record<string, unknown> | null;
  marker: string;
  status: PublicationOperation["status"];
  outcome_code: PublicationOperation["outcomeCode"] | null;
  remote_id: string | null;
  attempt_count: number;
  version: string;
  last_error_code: string | null;
}

function mapOperation(row: OperationRow): PublicationOperation {
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

function requiredText(value: string, description: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${description} must be non-empty`);
  return normalized;
}

function requiredHash(value: string, description: string): string {
  const normalized = requiredText(value, description);
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${description} must be a lowercase SHA-256 hash`);
  }
  return normalized;
}

function canonicalizeScope(scope: PublicationScope): PublicationScope {
  return buildPublicationIdentity({ scope, slot: "batch-scope", payload: {} }).scope;
}

function sameScope(left: PublicationScope, right: PublicationScope): boolean {
  return left.tenantId === right.tenantId &&
    left.integrationId === right.integrationId &&
    left.platform === right.platform &&
    left.origin === right.origin &&
    left.repository === right.repository &&
    left.target === right.target &&
    left.revision === right.revision &&
    left.authorityGeneration === right.authorityGeneration;
}

function sameSourceScope(left: PublicationScope, right: PublicationScope): boolean {
  return left.tenantId === right.tenantId &&
    left.integrationId === right.integrationId &&
    left.platform === right.platform &&
    left.origin === right.origin &&
    left.repository === right.repository &&
    left.target === right.target &&
    left.authorityGeneration === right.authorityGeneration;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
