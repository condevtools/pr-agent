import { HttpException, Inject, Injectable, NotFoundException, type OnModuleDestroy } from "@nestjs/common";

import type { PublicationBinding } from "../../../agent-runtime/authority/publication-authority.js";
import { closeGitHubOnboardingStore, getGitHubOnboardingStore } from "../../../agent-runtime/runtime/github-onboarding.js";
import { githubOnboardingEnabled } from "../../../agent-runtime/runtime/config.js";
import { GitHubOnboardingAccessError, GitHubOnboardingProvider,
  type GitHubOnboardingApp, type GitHubOnboardingRepository } from "../../../integrations/github/onboarding/provider.js";
import type { RepositoryAdminPrincipal } from "../../common/run-auth.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";
import type { EnrollGitHubRepositoryInput, RevalidateGitHubRepositoryInput } from "./input.js";

export interface GitHubRepositoryAdminView {
  repository: string;
  repositoryId: number;
  installationId: number;
  accountId: number;
  account: string;
  status: "not_connected" | "active" | "blocked" | "draining" | "revoked" | "unknown" | "suspended";
  binding: null | ReturnType<typeof bindingView>;
}

@Injectable()
export class GitHubAdminService implements OnModuleDestroy {
  private readonly provider = new GitHubOnboardingProvider();

  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  async onModuleDestroy(): Promise<void> { await closeGitHubOnboardingStore(); }

  assertEnabled(): void {
    if (!githubOnboardingEnabled()) throw new NotFoundException();
  }

  async repositories(principal: RepositoryAdminPrincipal): Promise<{
    app: GitHubOnboardingApp;
    repositories: GitHubRepositoryAdminView[];
  }> {
    this.assertEnabled();
    const origin = githubOrigin();
    try {
      const discovered = await this.provider.discover(origin, principal.githubAccountIds);
      this.context.assertCurrentPrincipal(principal);
      const store = await getGitHubOnboardingStore();
      const bindings = await store.list(principal.tenantId, []);
      this.context.assertCurrentPrincipal(principal);
      return { app: discovered.app, repositories: mergeGitHubRepositoryInventory(
        discovered.repositories, bindings, discovered.suspendedInstallationIds,
        principal.githubAccountIds, discovered.app.id,
      ) };
    } catch (error) {
      throw safeAdminError(error, "GitHub repository inventory is unavailable");
    }
  }

  async enroll(principal: RepositoryAdminPrincipal, input: EnrollGitHubRepositoryInput): Promise<{
    binding: ReturnType<typeof bindingView>;
  }> {
    this.assertEnabled();
    try {
      const verified = await this.provider.verifyRepository(githubOrigin(), input.repository, principal.githubAccountIds);
      this.context.assertCurrentPrincipal(principal);
      const store = await getGitHubOnboardingStore();
      const binding = await store.enroll({
        tenantId: principal.tenantId, actor: principal.subjectId, actorType: principal.actorType,
        identity: verified.repository.identity,
        confirmation: `Administrator confirmed previous publishers stopped before onboarding ${verified.repository.identity.repository}`,
      });
      this.context.assertCurrentPrincipal(principal);
      return { binding: bindingView(binding) };
    } catch (error) {
      throw safeAdminError(error, "GitHub repository could not be onboarded");
    }
  }

  async revalidate(principal: RepositoryAdminPrincipal, input: RevalidateGitHubRepositoryInput): Promise<{
    binding: ReturnType<typeof bindingView>;
  }> {
    this.assertEnabled();
    try {
      const verified = await this.provider.verifyRepository(githubOrigin(), input.repository, principal.githubAccountIds);
      this.context.assertCurrentPrincipal(principal);
      const store = await getGitHubOnboardingStore();
      const binding = await store.revalidate({
        tenantId: principal.tenantId, actor: principal.subjectId, actorType: principal.actorType,
        identity: verified.repository.identity, expectedAccessVersion: input.expectedAccessVersion,
        confirmation: `Administrator confirmed previous publishers stopped before revalidating ${verified.repository.identity.repository}`,
      });
      this.context.assertCurrentPrincipal(principal);
      return { binding: bindingView(binding) };
    } catch (error) {
      throw safeAdminError(error, "GitHub repository access could not be revalidated");
    }
  }
}

export function mergeGitHubRepositoryInventory(
  discovered: GitHubOnboardingRepository[], bindings: PublicationBinding[],
  suspendedInstallationIds: ReadonlySet<number>, allowedAccountIds: readonly number[], appId: number,
): GitHubRepositoryAdminView[] {
  const allowedAccounts = new Set(allowedAccountIds);
  const bindingsByRepositoryId = new Map(bindings
    .filter((binding) => binding.githubAccountId !== undefined
      && allowedAccounts.has(binding.githubAccountId) && binding.githubAppId === appId)
    .map((binding) => [binding.providerRepositoryId, binding]));
  const legacyBindingsByRepositoryId = new Map(bindings
    .filter((binding) => binding.githubAccountId === undefined && binding.githubAppId === undefined)
    .map((binding) => [binding.providerRepositoryId, binding]));
  const repositories = discovered.map((repository): GitHubRepositoryAdminView => {
    const current = bindingsByRepositoryId.get(repository.identity.repositoryId);
    const legacy = legacyBindingsByRepositoryId.get(repository.identity.repositoryId);
    const binding = current ?? (legacy?.providerActorId === repository.identity.actorId ? legacy : undefined);
    if (binding) bindingsByRepositoryId.delete(repository.identity.repositoryId);
    const identityMatches = binding ? liveInventoryIdentityMatches(binding, repository) : false;
    return {
      repository: repository.identity.repository, repositoryId: repository.identity.repositoryId,
      installationId: repository.identity.installationId, accountId: repository.identity.accountId,
      account: repository.account,
      status: binding ? (identityMatches ? bindingStatus(binding) : "unknown") : "not_connected",
      binding: binding ? bindingView(binding, identityMatches
        ? binding.providerAccessState ?? "verified" : "unknown") : null,
    };
  });
  for (const binding of bindingsByRepositoryId.values()) {
    const installationId = Number(binding.credentialRef.slice("github-app:".length));
    const suspended = suspendedInstallationIds.has(installationId);
    const providerAccessState = binding.providerAccessState === "revoked" ? "revoked" : "unknown";
    repositories.push({
      repository: binding.repository, repositoryId: binding.providerRepositoryId,
      installationId: Number.isSafeInteger(installationId) ? installationId : 0,
      accountId: binding.githubAccountId ?? 0, account: "Access unavailable",
      status: suspended ? "suspended" : providerAccessState,
      binding: bindingView(binding, providerAccessState),
    });
  }
  return repositories.sort((left, right) => left.repository.localeCompare(right.repository));
}

function liveInventoryIdentityMatches(
  binding: PublicationBinding, repository: GitHubOnboardingRepository,
): boolean {
  const installationId = Number(binding.credentialRef.slice("github-app:".length));
  return binding.githubAppId !== undefined && binding.githubAccountId !== undefined
    && binding.githubAppId === repository.identity.appId
    && binding.githubAccountId === repository.identity.accountId
    && binding.providerRepositoryId === repository.identity.repositoryId
    && binding.providerActorId === repository.identity.actorId
    && Number.isSafeInteger(installationId)
    && installationId === repository.identity.installationId
    && binding.repository.toLowerCase() === repository.identity.repository.toLowerCase();
}

function bindingStatus(binding: PublicationBinding): GitHubRepositoryAdminView["status"] {
  if (binding.providerAccessState === "revoked") return "revoked";
  if (binding.providerAccessState === "unknown") return "unknown";
  return binding.state;
}

function bindingView(binding: PublicationBinding, providerAccessState = binding.providerAccessState ?? "verified") {
  return {
    id: binding.id, state: binding.state, version: binding.version, generation: binding.generation,
    providerAccessState,
    providerAccessVersion: binding.providerAccessVersion ?? 0,
  };
}

function safeAdminError(error: unknown, message: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof GitHubOnboardingAccessError) return new HttpException(message, error.status);
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "23505") return new HttpException("Repository is already managed by another scope", 409);
  if (code === "40001" || code === "40P01") return new HttpException("Repository state changed; retry the request", 409);
  if (code === "55000") {
    return new HttpException("Resolve unconfirmed publication results before changing repository access", 409);
  }
  return new HttpException(message, 502);
}

function githubOrigin(): string { return process.env.GITHUB_API_URL?.trim().replace(/\/$/u, "") || "https://api.github.com"; }
