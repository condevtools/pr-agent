import { HarnessDatabase } from "./postgres/database.js";
import { normalizeIntegrationTarget, type IntegrationPlatform } from "./postgres/run-store.js";

export interface PublicationBinding {
  id: string;
  tenantId: string;
  platform: IntegrationPlatform;
  origin: string;
  repository: string;
  providerRepositoryId: number;
  providerActorId: number;
  credentialRef: string;
  generation: number;
  version: number;
  state: "blocked" | "active" | "draining";
  reviewExecutionMode?: "legacy_sync" | "harness_async";
  executionModeGeneration?: number;
}

interface BindingRow {
  id: string; tenant_id: string; platform: IntegrationPlatform; origin: string; repository: string;
  provider_repository_id: string | null; provider_actor_id: string | null; credential_ref: string | null;
  publication_generation: string; authority_version: string; publication_state: PublicationBinding["state"];
  review_execution_mode?: "legacy_sync" | "harness_async";
  execution_mode_generation?: string;
}

/** Administrative enrollment and cutover; runtime credentials have SELECT permission only. */
export class PublicationAuthorityStore {
  constructor(private readonly db: HarnessDatabase) {}

  async get(tenantId: string, integrationId: string): Promise<PublicationBinding> {
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<BindingRow>(
        "SELECT * FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2 AND active",
        [tenantId, integrationId],
      );
      if (!result.rows[0]) throw new Error("Trusted publication binding not found");
      return mapBinding(result.rows[0]);
    });
  }

  async configure(input: {
    tenantId: string; integrationId: string; providerRepositoryId: number;
    providerActorId: number; credentialRef: string; expectedVersion: number;
  }): Promise<void> {
    positiveId(input.providerRepositoryId);
    positiveId(input.providerActorId);
    validateCredentialRef(input.credentialRef);
    await this.db.transaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE pr_agent_harness.integration_bindings
         SET provider_repository_id=$3, provider_actor_id=$4, credential_ref=$5,
             authority_version=authority_version+1, updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND active AND publication_state='blocked'
           AND authority_version=$6 AND publication_generation=0 RETURNING id`,
        [input.tenantId, input.integrationId, String(input.providerRepositoryId), String(input.providerActorId), input.credentialRef, input.expectedVersion],
      );
      if (result.rowCount !== 1) throw new Error("Binding configuration requires an unactivated, blocked binding and current version");
    });
  }

  async transition(input: {
    tenantId: string; integrationId: string; expectedVersion: number;
    action: "activate" | "drain" | "block";
    actor: string; actorType?: "user" | "service"; quiescenceEvidence?: string;
  }): Promise<PublicationBinding> {
    if (!input.actor.trim()) throw new Error("An administrative actor is required");
    return this.db.transaction(input.tenantId, async (client) => {
      const selected = await client.query<BindingRow>(
        "SELECT * FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE",
        [input.tenantId, input.integrationId],
      );
      const row = selected.rows[0];
      if (!row || Number(row.authority_version) !== input.expectedVersion) throw new Error("Publication authority version conflict");
      let next: PublicationBinding["state"];
      let increment = 0;
      if (input.action === "drain") {
        if (row.publication_state !== "active") throw new Error("Only active publication authority can drain");
        next = "draining";
      } else {
        if (row.publication_state === "active") throw new Error("Drain publication before changing its authority");
        const unsettled = await client.query(
          `SELECT 1 FROM pr_agent_harness.repository_operations
           WHERE tenant_id=$1 AND integration_id=$2 AND status IN ('prepared','in_flight','unknown','manual_review') LIMIT 1`,
          [input.tenantId, input.integrationId],
        );
        if (unsettled.rowCount) throw new Error("Unresolved publication operations prevent authority transition");
        if (input.action === "activate") {
          if (!input.quiescenceEvidence?.trim()) throw new Error("Activation requires evidence that all previous publishers were stopped and drained");
          if (!row.provider_repository_id || !row.provider_actor_id || !row.credential_ref) throw new Error("Configure immutable provider identity and server credentials before activation");
          validateCredentialRef(row.credential_ref);
          if ((row.platform === "gitlab") !== (row.credential_ref === "env:GITLAB_TOKEN")) {
            throw new Error("Credential reference belongs to a different provider");
          }
          next = "active";
          increment = 1;
        } else {
          next = "blocked";
        }
      }
      const receipt = input.action === "activate"
        ? JSON.stringify({ actor: input.actor, evidence: input.quiescenceEvidence, protocol: "ledger_v1" })
        : null;
      const updated = await client.query<BindingRow>(
        `UPDATE pr_agent_harness.integration_bindings
         SET publication_state=$3, publication_generation=publication_generation+$4,
             authority_version=authority_version+1,
             quiescence_receipt=COALESCE($5::jsonb,quiescence_receipt), updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [input.tenantId, input.integrationId, next, increment, receipt],
      );
      await client.query(
        `INSERT INTO pr_agent_harness.audit_logs
         (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
         VALUES ($1,$6,$2,$3,'allowed','integration_binding',$4,$5::jsonb)`,
        [input.tenantId, input.actor, `publication.authority.${input.action}`, input.integrationId,
          JSON.stringify({ from: row.publication_state, to: next, priorVersion: input.expectedVersion }), input.actorType ?? "user"],
      );
      return mapBinding(updated.rows[0]!);
    });
  }

  async resolve(platform: IntegrationPlatform, origin: string, repository: string): Promise<PublicationBinding> {
    const normalized = normalizeIntegrationTarget(platform, origin, repository);
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<BindingRow>(
        `SELECT * FROM pr_agent_harness.integration_bindings
         WHERE platform=$1 AND origin=$2 AND repository=$3 AND active`,
        [platform, normalized.origin, normalized.repository],
      );
      if (!result.rows[0]) throw new Error("Trusted publication binding not found");
      const binding = mapBinding(result.rows[0]);
      if (binding.state === "blocked") throw new Error("Repository publication is blocked pending administrative cutover");
      return binding;
    });
  }

  async listRecoverable(): Promise<PublicationBinding[]> {
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<BindingRow>(
        "SELECT * FROM pr_agent_harness.integration_bindings WHERE active AND publication_state IN ('active','draining') ORDER BY tenant_id,id LIMIT 1000",
      );
      return result.rows.map(mapBinding);
    });
  }
}

export function validateCredentialRef(reference: string): void {
  if (!/^env:(GITHUB_TOKEN|GITHUB_WEBHOOK_TOKEN|GITLAB_TOKEN)$/.test(reference)
      && !/^github-app:[1-9][0-9]*$/.test(reference)) {
    throw new Error("Credential reference must name a supported server token or GitHub installation");
  }
}

function positiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Provider identity must be a positive safe integer");
}

function mapBinding(row: BindingRow): PublicationBinding {
  const providerRepositoryId = Number(row.provider_repository_id);
  const providerActorId = Number(row.provider_actor_id);
  if (row.publication_state !== "blocked") {
    positiveId(providerRepositoryId);
    positiveId(providerActorId);
  }
  return {
    id: row.id, tenantId: row.tenant_id, platform: row.platform, origin: row.origin, repository: row.repository,
    providerRepositoryId, providerActorId, credentialRef: row.credential_ref ?? "",
    generation: Number(row.publication_generation), version: Number(row.authority_version), state: row.publication_state,
    reviewExecutionMode: row.review_execution_mode ?? "legacy_sync",
    executionModeGeneration: Number(row.execution_mode_generation ?? 0),
  };
}
