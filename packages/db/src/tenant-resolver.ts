import type { PrismaClient } from "@prisma/client";
import { decryptApiKey } from "./crypto";

/** Resolved organization context used throughout the request lifecycle. */
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
 *   installation_id  ->  installations row  ->  organization  ->  active ai_config
 *
 * If the installation is not found, the organization does not exist, or there is
 * no active AI configuration, the function returns `null` so that callers
 * can fall back to the legacy env-var-based behaviour.
 *
 * @param db             - Prisma database client.
 * @param installationId - GitHub App installation ID (numeric).
 */
export async function resolveTenantFromInstallation(
  db: PrismaClient,
  installationId: number,
): Promise<TenantConfig | null> {
  const installation = await db.installation.findUnique({
    where: {
      githubInstallationId: installationId,
    },
    include: {
      organization: {
        include: {
          aiConfigs: {
            where: { isActive: true },
            take: 1,
          },
        },
      },
    },
  });

  if (!installation || installation.status !== "active") return null;

  const { organization } = installation;
  const aiConfig = organization.aiConfigs[0];

  if (!aiConfig) return null;

  return {
    tenantId: organization.id,
    plan: organization.plan,
    ai: {
      provider: aiConfig.provider,
      model: aiConfig.model,
      apiKey: decryptApiKey(
        Buffer.from(aiConfig.apiKeyEncrypted),
        Buffer.from(aiConfig.apiKeyIv),
      ),
      baseUrl: aiConfig.baseUrl ?? undefined,
    },
  };
}
