import { eq, and } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { decryptApiKey } from "./crypto.js";
import { installations, tenants, aiConfigs } from "./schema.js";

/** Resolved tenant context used throughout the request lifecycle. */
export interface TenantConfig {
  tenantId: string;
  plan: "free" | "pro" | "enterprise";
  ai: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  };
}

/**
 * Resolve a full {@link TenantConfig} from a GitHub App installation ID.
 *
 * This is the primary entry point for multi-tenant request routing:
 *   installation_id  ->  installations row  ->  tenant  ->  active ai_config
 *
 * If the installation is not found, the tenant does not exist, or there is
 * no active AI configuration, the function returns `null` so that callers
 * can fall back to the legacy env-var-based behaviour.
 *
 * @param db             - Drizzle database instance.
 * @param installationId - GitHub App installation ID (numeric).
 */
export async function resolveTenantFromInstallation(
  db: DrizzleDb,
  installationId: number,
): Promise<TenantConfig | null> {
  // 1. Look up the installation row
  const installationRow = await db
    .select({
      tenantId: installations.tenantId,
    })
    .from(installations)
    .where(
      and(
        eq(installations.githubInstallationId, installationId),
        eq(installations.status, "active"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!installationRow) {
    return null;
  }

  const { tenantId } = installationRow;

  // 2. Fetch tenant details
  const tenantRow = await db
    .select({
      plan: tenants.plan,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!tenantRow) {
    return null;
  }

  // 3. Fetch the active AI config for this tenant
  const aiConfigRow = await db
    .select({
      provider: aiConfigs.provider,
      model: aiConfigs.model,
      apiKeyEncrypted: aiConfigs.apiKeyEncrypted,
      apiKeyIv: aiConfigs.apiKeyIv,
      baseUrl: aiConfigs.baseUrl,
    })
    .from(aiConfigs)
    .where(
      and(
        eq(aiConfigs.tenantId, tenantId),
        eq(aiConfigs.isActive, true),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!aiConfigRow) {
    return null;
  }

  // 4. Decrypt the API key
  const apiKey = decryptApiKey(
    aiConfigRow.apiKeyEncrypted,
    aiConfigRow.apiKeyIv,
  );

  return {
    tenantId,
    plan: tenantRow.plan,
    ai: {
      provider: aiConfigRow.provider,
      model: aiConfigRow.model,
      apiKey,
      baseUrl: aiConfigRow.baseUrl ?? undefined,
    },
  };
}
