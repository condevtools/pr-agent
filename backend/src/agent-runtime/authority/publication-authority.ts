import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../postgres/database.js";
import { normalizeIntegrationTarget, type IntegrationPlatform } from "../postgres/run-store.js";
import type { BindingCapabilities, ReviewWorkflow } from "../runtime/capabilities.js";

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
  reviewExecutionMode: "harness_async";
  executionModeGeneration?: number;
  reviewExecutionState?: "active" | "draining";
  capabilities: BindingCapabilities;
  providerAccessState?: "verified" | "revoked" | "unknown";
  providerAccessVersion?: number;
  providerAccessReason?: string;
  githubAppId?: number;
  githubAccountId?: number;
}

export interface PublicationBindingRow {
  id: string; tenant_id: string; platform: IntegrationPlatform; origin: string; repository: string;
  provider_repository_id: string | null; provider_actor_id: string | null; credential_ref: string | null;
  publication_generation: string; authority_version: string; publication_state: PublicationBinding["state"];
  review_execution_mode?: string;
  execution_mode_generation?: string;
  review_execution_state?: "active" | "draining";
  review_deep_enabled?: boolean;
  issue_triage_enabled?: boolean;
  fix_enabled?: boolean;
  evolution_enabled?: boolean;
  default_review_workflow?: string;
  provider_access_state?: "verified" | "revoked" | "unknown";
  provider_access_version?: string;
  provider_access_reason?: string | null;
  github_app_id?: string | null;
  github_account_id?: string | null;
}

export class PublicationBindingNotFoundError extends Error {
  constructor(readonly platform: IntegrationPlatform, readonly repository: string) {
    super("Trusted publication binding not found");
    this.name = "PublicationBindingNotFoundError";
  }
}

export class PublicationBindingBlockedError extends Error {
  constructor(readonly platform: IntegrationPlatform, readonly repository: string) {
    super("Repository publication is blocked pending administrative cutover");
    this.name = "PublicationBindingBlockedError";
  }
}

/** Administrative enrollment and cutover; runtime credentials have SELECT permission only. */
export class PublicationAuthorityStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async get(tenantId: string, integrationId: string): Promise<PublicationBinding> {
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<PublicationBindingRow>(
        "SELECT * FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2 AND active",
        [tenantId, integrationId],
      );
      if (!result.rows[0]) throw new Error("Trusted publication binding not found");
      return mapPublicationBinding(result.rows[0]);
    });
  }

  async configure(input: {
    tenantId: string; integrationId: string; providerRepositoryId: number;
    providerActorId: number; credentialRef: string; expectedVersion: number;
    reviewDeepEnabled?: boolean; issueTriageEnabled?: boolean; fixEnabled?: boolean; evolutionEnabled?: boolean;
    defaultReviewWorkflow?: ReviewWorkflow;
  }): Promise<void> {
    positiveId(input.providerRepositoryId);
    positiveId(input.providerActorId);
    validateCredentialRef(input.credentialRef);
    if (input.defaultReviewWorkflow === "review.deep.v1" && input.reviewDeepEnabled === false) {
      throw new Error("Deep review cannot be the default when its binding capability is disabled");
    }
    await this.db.transaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE pr_agent_harness.integration_bindings
         SET provider_repository_id=$3, provider_actor_id=$4, credential_ref=$5,
             review_deep_enabled=COALESCE($7,review_deep_enabled),
             issue_triage_enabled=COALESCE($8,issue_triage_enabled),
             fix_enabled=COALESCE($9,fix_enabled),
             evolution_enabled=COALESCE($10,evolution_enabled),
             default_review_workflow=COALESCE($11,default_review_workflow),
             authority_version=authority_version+1, updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND active AND publication_state='blocked'
           AND authority_version=$6 AND publication_generation=0 RETURNING id`,
        [input.tenantId, input.integrationId, String(input.providerRepositoryId), String(input.providerActorId),
          input.credentialRef, input.expectedVersion, input.reviewDeepEnabled, input.issueTriageEnabled,
          input.fixEnabled, input.evolutionEnabled, input.defaultReviewWorkflow],
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
      const selected = await client.query<PublicationBindingRow>(
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
      const updated = await client.query<PublicationBindingRow>(
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
      return mapPublicationBinding(updated.rows[0]!);
    });
  }

  async configureCapabilities(input: {
    tenantId: string;
    integrationId: string;
    expectedVersion: number;
    reviewDeep: boolean;
    issueTriage?: boolean;
    fix: boolean;
    evolution: boolean;
    defaultReviewWorkflow: ReviewWorkflow;
    actor: string;
    actorType?: "user" | "service";
  }): Promise<PublicationBinding> {
    if (!input.actor.trim()) throw new Error("An administrative actor is required");
    if (input.defaultReviewWorkflow === "review.deep.v1" && !input.reviewDeep) {
      throw new Error("Deep review cannot be the default when its binding capability is disabled");
    }
    return this.db.transaction(input.tenantId, async (client) => {
      const updated = await client.query<PublicationBindingRow>(
        `UPDATE pr_agent_harness.integration_bindings
         SET review_deep_enabled=$3,issue_triage_enabled=COALESCE($4,issue_triage_enabled),fix_enabled=$5,evolution_enabled=$6,
             default_review_workflow=$7,authority_version=authority_version+1,
             updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND active AND authority_version=$8
         RETURNING *`,
        [input.tenantId, input.integrationId, input.reviewDeep, input.issueTriage,
          input.fix, input.evolution, input.defaultReviewWorkflow, input.expectedVersion],
      );
      if (!updated.rows[0]) throw new Error("Binding capability configuration version conflict");
      await client.query(
        `INSERT INTO pr_agent_harness.audit_logs
           (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
         VALUES ($1,$2,$3,'binding.capabilities.configure','allowed',
           'integration_binding',$4,$5::jsonb)`,
        [input.tenantId, input.actorType ?? "user", input.actor, input.integrationId,
          JSON.stringify({ reviewDeep: input.reviewDeep,
            ...(input.issueTriage === undefined ? {} : { issueTriage: input.issueTriage }), fix: input.fix,
            evolution: input.evolution, defaultReviewWorkflow: input.defaultReviewWorkflow,
            priorVersion: input.expectedVersion })],
      );
      return mapPublicationBinding(updated.rows[0]);
    });
  }

  async drainExecution(input: {
    tenantId: string; integrationId: string; expectedVersion: number;
    actor: string; actorType?: "user" | "service"; evidence: string;
  }): Promise<PublicationBinding> {
    requiredAdministrativeEvidence(input.actor, input.evidence);
    return this.db.transaction(input.tenantId, async (client) => {
      const selected = await client.query<PublicationBindingRow>(
        `SELECT * FROM pr_agent_harness.integration_bindings
         WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE`,
        [input.tenantId, input.integrationId],
      );
      const row = selected.rows[0];
      if (!row || Number(row.authority_version) !== input.expectedVersion) {
        throw new Error("Review execution authority version conflict");
      }
      if ((row.review_execution_state ?? "active") !== "active") {
        throw new Error("Review execution is already draining");
      }
      const receipt = {
        actor: input.actor,
        evidence: input.evidence,
        fromMode: requireAsyncExecutionMode(row.review_execution_mode),
        generation: Number(row.execution_mode_generation ?? 0),
      };
      const updated = await client.query<PublicationBindingRow>(
        `UPDATE pr_agent_harness.integration_bindings
         SET review_execution_state='draining',execution_drain_receipt=$3::jsonb,
             authority_version=authority_version+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [input.tenantId, input.integrationId, JSON.stringify(receipt)],
      );
      await appendExecutionAudit(client, input, "execution.drain", {
        mode: receipt.fromMode, generation: receipt.generation,
        priorVersion: input.expectedVersion,
      });
      return mapPublicationBinding(updated.rows[0]!);
    });
  }

  async resumeExecution(input: {
    tenantId: string; integrationId: string; expectedVersion: number;
    actor: string; actorType?: "user" | "service"; evidence: string;
  }): Promise<PublicationBinding> {
    requiredAdministrativeEvidence(input.actor, input.evidence);
    return this.db.transaction(input.tenantId, async (client) => {
      const selected = await client.query<PublicationBindingRow>(
        `SELECT * FROM pr_agent_harness.integration_bindings
         WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE`,
        [input.tenantId, input.integrationId],
      );
      const row = selected.rows[0];
      if (!row || Number(row.authority_version) !== input.expectedVersion) {
        throw new Error("Review execution authority version conflict");
      }
      if ((row.review_execution_state ?? "active") !== "draining") {
        throw new Error("Only draining review execution can resume admission");
      }
      const mode = requireAsyncExecutionMode(row.review_execution_mode);
      const generation = Number(row.execution_mode_generation ?? 0);
      const receipt = { actor: input.actor, evidence: input.evidence, mode, generation };
      const updated = await client.query<PublicationBindingRow>(
        `UPDATE pr_agent_harness.integration_bindings
         SET review_execution_state='active',execution_resume_receipt=$3::jsonb,
             authority_version=authority_version+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [input.tenantId, input.integrationId, JSON.stringify(receipt)],
      );
      await appendExecutionAudit(client, input, "execution.resume", {
        mode, generation, priorVersion: input.expectedVersion,
      });
      return mapPublicationBinding(updated.rows[0]!);
    });
  }

  async resolve(platform: IntegrationPlatform, origin: string, repository: string): Promise<PublicationBinding> {
    const normalized = normalizeIntegrationTarget(platform, origin, repository);
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<PublicationBindingRow>(
        `SELECT * FROM pr_agent_harness.integration_bindings
         WHERE platform=$1 AND origin=$2 AND repository=$3 AND active`,
        [platform, normalized.origin, normalized.repository],
      );
      if (!result.rows[0]) throw new PublicationBindingNotFoundError(platform, normalized.repository);
      const binding = mapPublicationBinding(result.rows[0]);
      if (binding.providerAccessState !== "verified") throw new PublicationBindingBlockedError(platform, normalized.repository);
      if (binding.state === "blocked") throw new PublicationBindingBlockedError(platform, normalized.repository);
      return binding;
    });
  }

  /** Resolve deferred events by immutable provider identity, including operator-disabled bindings. */
  async findByProviderRepository(platform: IntegrationPlatform, origin: string, repositoryId: number):
  Promise<{ binding: PublicationBinding; active: boolean } | undefined> {
    positiveId(repositoryId);
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<PublicationBindingRow & { active: boolean }>(
        `SELECT * FROM pr_agent_harness.integration_bindings
         WHERE platform=$1 AND origin=$2 AND provider_repository_id=$3`,
        [platform, origin, repositoryId],
      );
      if (result.rows.length > 1) throw new Error("Ambiguous provider repository binding");
      const row = result.rows[0];
      return row ? { binding: mapPublicationBinding(row), active: row.active } : undefined;
    });
  }

  async listRecoverable(): Promise<PublicationBinding[]> {
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<PublicationBindingRow>(
        "SELECT * FROM pr_agent_harness.integration_bindings WHERE active AND publication_state IN ('active','draining') ORDER BY tenant_id,id LIMIT 1000",
      );
      return result.rows.map(mapPublicationBinding);
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

export function mapPublicationBinding(row: PublicationBindingRow): PublicationBinding {
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
    reviewExecutionMode: requireAsyncExecutionMode(row.review_execution_mode),
    executionModeGeneration: Number(row.execution_mode_generation ?? 0),
    reviewExecutionState: row.review_execution_state ?? "active",
    providerAccessState: row.provider_access_state ?? "verified",
    providerAccessVersion: Number(row.provider_access_version ?? 0),
    ...(row.provider_access_reason ? { providerAccessReason: row.provider_access_reason } : {}),
    ...(row.github_app_id ? { githubAppId: Number(row.github_app_id) } : {}),
    ...(row.github_account_id ? { githubAccountId: Number(row.github_account_id) } : {}),
    capabilities: {
      reviewSingle: true,
      reviewDeep: row.review_deep_enabled ?? true,
      issueTriage: row.platform === "github" && (row.issue_triage_enabled ?? true),
      fix: row.fix_enabled ?? false,
      evolution: row.evolution_enabled ?? false,
      defaultReviewWorkflow: requireReviewWorkflow(row.default_review_workflow),
    },
  };
}

function requireReviewWorkflow(value: string | undefined): ReviewWorkflow {
  if (value === undefined || value === "review.single.v1") return "review.single.v1";
  if (value === "review.deep.v1") return value;
  throw new Error("Binding has an invalid default review workflow");
}

function requireAsyncExecutionMode(value: string | undefined): "harness_async" {
  if (value !== "harness_async") {
    throw new Error("PostgreSQL asynchronous review execution authority is required");
  }
  return value;
}

function requiredAdministrativeEvidence(actor: string, evidence: string): void {
  if (!actor.trim()) throw new Error("An administrative actor is required");
  if (!evidence.trim()) throw new Error("Review execution transition evidence is required");
}

async function appendExecutionAudit(
  client: PoolClient,
  input: { tenantId: string; integrationId: string; actor: string; actorType?: "user" | "service" },
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO pr_agent_harness.audit_logs
       (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
     VALUES ($1,$2,$3,$4,'allowed','integration_binding',$5,$6::jsonb)`,
    [input.tenantId, input.actorType ?? "user", input.actor, action, input.integrationId,
      JSON.stringify(details)],
  );
}
