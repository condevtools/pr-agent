import { createFixPublicationAdapter } from "../../fix/publication/provider-adapter.js";
import { verifyGitHubCredentialIdentity } from "../../integrations/github/auth/credential-identity.js";
import { createRestBackedOctokit } from "../../integrations/github/api/http-client.js";
import { createGitHubPublicationAdapter } from "../../integrations/github/publication/adapter.js";
import { createGitLabPublicationAdapter } from "../../integrations/gitlab/publication/adapter.js";
import type { PublicationBinding } from "../authority/publication-authority.js";
import type { IntegrationPlatform } from "../postgres/run-store.js";
import type { PublicationAdapter, PublicationOperation, PublicationScope, PublicationService } from "../publication/publication.js";
import type { PublicationBatchCoordinator, PublicationBatchStore } from "../publication/batches.js";
import { getSharedGitHubProbot, resolvePublicationCredential } from "./credentials.js";
import { getAgentRuntimeServices, type AgentRuntimeServices } from "./services.js";
import { assertGitHubBindingAccess, GitHubOnboardingAccessError } from "../../integrations/github/onboarding/provider.js";
import { guardPublicationAccess } from "../publication/access-guard.js";

export interface PublicationRuntime {
  service: PublicationService;
  scope: Omit<PublicationScope, "target" | "revision">;
  binding: PublicationBinding;
  batchStore: PublicationBatchStore;
  batchCoordinator: PublicationBatchCoordinator;
  createAdapter(operation: PublicationOperation): Promise<PublicationAdapter>;
  resolveCredential(): Promise<string>;
}

export async function resolvePublicationRuntime(input: {
  platform: IntegrationPlatform; origin: string; repository: string;
}): Promise<PublicationRuntime> {
  const services = await getAgentRuntimeServices();
  const binding = await services.authority.resolve(input.platform, input.origin, input.repository);
  await assertGitHubBindingAccess(binding);
  return publicationRuntimeForBinding(binding, services);
}

export async function publicationRuntimeForBinding(
  binding: PublicationBinding,
  services?: AgentRuntimeServices,
): Promise<PublicationRuntime> {
  const current = services ?? await getAgentRuntimeServices();
  return {
    service: current.service,
    scope: { tenantId: binding.tenantId, integrationId: binding.id, platform: binding.platform,
      origin: binding.origin, repository: binding.repository, authorityGeneration: binding.generation },
    binding, batchStore: current.batchStore, batchCoordinator: current.batchCoordinator,
    resolveCredential: () => resolvePublicationCredential(binding),
    createAdapter: async (operation) => {
      if (operation.scope.tenantId !== binding.tenantId || operation.scope.integrationId !== binding.id
          || operation.scope.authorityGeneration !== binding.generation) throw new Error("Publication gateway scope mismatch");
      const credential = await resolvePublicationCredential(binding);
      if (binding.platform === "gitlab") {
        if (operation.operationType && operation.operationType !== "publication") {
          return createFixPublicationAdapter({ binding, token: credential, operation });
        }
        return createGitLabPublicationAdapter({ binding: { ...binding, platform: "gitlab" }, token: credential, operation });
      }
      const octokit = createRestBackedOctokit({ token: credential, baseUrl: binding.origin });
      const verifyCredentialIdentity = () => verifyGitHubCredentialIdentity({
        credentialRef: binding.credentialRef, octokit,
        loadAppIdentity: async (installationId: number) => {
          const appClient = await getSharedGitHubProbot(binding.origin).auth();
          const { data: app } = await appClient.request("GET /app");
          if (!app) throw new Error("GitHub App identity is unavailable");
          const { data: installation } = await appClient.request("GET /app/installations/{installation_id}", {
            installation_id: installationId,
          });
          return { app, installation };
        },
      });
      const checkAccess = async () => {
        await assertGitHubBindingAccess(binding);
        // Re-read after the provider lookup: a lifecycle event can commit while
        // that lookup is in flight. Never use the adapter's captured access state.
        const latest = await current.authority.get(binding.tenantId, binding.id);
        if (latest.generation !== binding.generation || !["active", "draining"].includes(latest.state)
            || latest.providerAccessState !== "verified") {
          throw new GitHubOnboardingAccessError("GitHub publication access is no longer active");
        }
      };
      if (operation.operationType && operation.operationType !== "publication") {
        return guardPublicationAccess(createFixPublicationAdapter({ binding, token: credential,
          operation, verifyCredentialIdentity }), checkAccess,
        { isAccessDenied: (cause) => cause instanceof GitHubOnboardingAccessError });
      }
      return guardPublicationAccess(createGitHubPublicationAdapter({ binding: { ...binding, platform: "github" }, octokit, operation,
        verifyCredentialIdentity }), checkAccess,
      { isAccessDenied: (cause) => cause instanceof GitHubOnboardingAccessError });
    },
  };
}
