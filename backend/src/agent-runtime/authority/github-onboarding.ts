import { RuntimeDatabase } from "../postgres/database.js";
import { normalizeIntegrationTarget } from "../postgres/run-store.js";
import {
  mapPublicationBinding,
  type PublicationBinding,
  type PublicationBindingRow,
} from "./publication-authority.js";

export interface GitHubOnboardingIdentity {
  origin: string;
  repository: string;
  appId: number;
  installationId: number;
  accountId: number;
  repositoryId: number;
  actorId: number;
}

interface AdministrativeInput {
  tenantId: string;
  actor: string;
  actorType: "user" | "service";
  identity: GitHubOnboardingIdentity;
  confirmation: string;
}

export class GitHubOnboardingStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async enroll(input: AdministrativeInput): Promise<PublicationBinding> {
    const normalized = validateAdministrativeInput(input);
    return this.db.transaction(input.tenantId, async (client) => {
      const result = await client.query<PublicationBindingRow>(
        `SELECT * FROM pr_agent_harness.github_onboarding_enroll(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.tenantId, input.actorType, input.actor.trim(), normalized.origin,
          normalized.repository, input.identity.appId, input.identity.installationId,
          input.identity.accountId, input.identity.repositoryId, input.identity.actorId,
          input.confirmation.trim()],
      );
      return oneBinding(result.rows, "GitHub repository enrollment did not return a binding");
    });
  }

  async revalidate(input: AdministrativeInput & { expectedAccessVersion: number }): Promise<PublicationBinding> {
    const normalized = validateAdministrativeInput(input);
    if (!Number.isSafeInteger(input.expectedAccessVersion) || input.expectedAccessVersion < 0) {
      throw new Error("Provider access version must be a nonnegative safe integer");
    }
    return this.db.transaction(input.tenantId, async (client) => {
      const result = await client.query<PublicationBindingRow>(
        `SELECT * FROM pr_agent_harness.github_onboarding_revalidate(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [input.tenantId, input.actorType, input.actor.trim(), normalized.origin,
          normalized.repository, input.identity.appId, input.identity.installationId,
          input.identity.accountId, input.identity.repositoryId, input.identity.actorId,
          input.confirmation.trim(), input.expectedAccessVersion],
      );
      return oneBinding(result.rows, "GitHub repository revalidation did not return a binding");
    });
  }

  async list(tenantId: string, installationIds: number[]): Promise<PublicationBinding[]> {
    const uniqueInstallations = [...new Set(installationIds.map((id) => positiveId(id, "Installation identity")))];
    return this.db.transaction(tenantId, async (client) => {
      const result = await client.query<PublicationBindingRow>(
        "SELECT * FROM pr_agent_harness.github_onboarding_list($1,$2::bigint[])",
        [tenantId, uniqueInstallations.map(String)],
      );
      return result.rows.map(mapPublicationBinding);
    });
  }

  async invalidate(input: {
    appId: number;
    installationId: number;
    repositoryIds?: number[];
    state: "revoked" | "unknown";
    reason: string;
    deliveryId: string;
  }): Promise<number> {
    const appId = positiveId(input.appId, "GitHub App identity");
    const installationId = positiveId(input.installationId, "Installation identity");
    const repositoryIds = input.repositoryIds?.map((id) => positiveId(id, "Repository identity"));
    const reason = requiredText(input.reason, "Provider lifecycle reason", 200);
    const deliveryId = requiredText(input.deliveryId, "Provider delivery identity", 200);
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<{ changed: number }>(
        `SELECT pr_agent_harness.github_onboarding_invalidate(
          $1,$2,$3::bigint[],$4,$5,$6) AS changed`,
        [appId, installationId, repositoryIds?.map(String) ?? null,
          input.state, reason, deliveryId],
      );
      return Number(result.rows[0]?.changed ?? 0);
    });
  }
}

function validateAdministrativeInput(input: AdministrativeInput): { origin: string; repository: string } {
  requiredText(input.actor, "Administrative actor", 200);
  requiredText(input.confirmation, "Publisher confirmation", 2_000);
  for (const [name, value] of [
    ["GitHub App identity", input.identity.appId],
    ["Installation identity", input.identity.installationId],
    ["GitHub account identity", input.identity.accountId],
    ["Repository identity", input.identity.repositoryId],
    ["Provider actor identity", input.identity.actorId],
  ] as const) positiveId(value, name);
  const normalized = normalizeIntegrationTarget("github", input.identity.origin, input.identity.repository);
  if (normalized.origin !== "https://api.github.com") {
    throw new Error("GitHub App onboarding requires the public GitHub API origin");
  }
  return normalized;
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`);
  return normalized;
}

function oneBinding(rows: PublicationBindingRow[], message: string): PublicationBinding {
  if (rows.length !== 1) throw new Error(message);
  return mapPublicationBinding(rows[0]!);
}
