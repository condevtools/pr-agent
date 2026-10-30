import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubOnboardingAccessError,
  GitHubOnboardingProvider,
  assertGitHubBindingAccess,
  type GitHubOnboardingProviderFactory,
} from "../../../src/integrations/github/onboarding/provider.js";

const permissions = {
  checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write",
};

test("repository discovery is account-scoped and follows every GitHub pagination page", async () => {
  const requests: string[] = [];
  const repositories = Array.from({ length: 101 }, (_unused, index) => ({
    id: 10_000 + index, full_name: `Example/repo-${index}`,
  }));
  const factory: GitHubOnboardingProviderFactory = {
    async appClient() {
      return { request: async (route, parameters = {}) => {
        requests.push(`${route}:${String(parameters.page ?? "")}`);
        if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
        if (route === "GET /app/installations") return { data: [
          installation(31, 501), { ...installation(32, 999), permissions: {} },
          { ...installation(33, 501), suspended_at: "2026-01-01" },
        ] };
        assert.notEqual(route, "GET /users/{username}", "App JWT must not call user endpoints");
        throw new Error(`Unexpected app request ${route}`);
      } };
    },
    async installationClient(_origin, installationId) {
      assert.equal(installationId, 31, "disallowed accounts must never receive an installation client");
      return { request: async (route, parameters = {}) => {
        if (route === "GET /users/{username}") {
          return { data: { id: 81, login: "review-app[bot]", type: "Bot" } };
        }
        assert.equal(route, "GET /installation/repositories");
        const page = Number(parameters.page);
        return { data: { repositories: page === 1 ? repositories.slice(0, 100) : repositories.slice(100) } };
      } };
    },
  };

  const result = await new GitHubOnboardingProvider(factory).discover("https://api.github.com/", [501]);
  assert.equal(result.repositories.length, 101);
  assert.deepEqual([...result.suspendedInstallationIds], [33]);
  assert.deepEqual(result.repositories[100]!.identity, {
    origin: "https://api.github.com", repository: "example/repo-100", appId: 7,
    installationId: 31, accountId: 501, repositoryId: 10_100, actorId: 81,
  });
  assert.deepEqual(requests.filter((request) => request.startsWith("GET /app/installations")),
    ["GET /app/installations:1"]);
});

test("verification rejects a repository outside the administrator account allowlist", async () => {
  const provider = new GitHubOnboardingProvider(singleRepositoryFactory({ accountId: 501 }));
  await assert.rejects(provider.verifyRepository("https://api.github.com", "Example/project", [777]),
    (error: unknown) => error instanceof GitHubOnboardingAccessError && error.status === 403);
});

test("live binding access verifies installation and repository numeric identity", async () => {
  const factory = singleRepositoryFactory({ accountId: 501, repositoryId: 90 });
  const binding = {
    platform: "github", origin: "https://api.github.com", repository: "example/project",
    credentialRef: "github-app:31", providerRepositoryId: 90, providerActorId: 81,
    githubAppId: 7, githubAccountId: 501,
  } as Parameters<typeof assertGitHubBindingAccess>[0];
  await assert.doesNotReject(assertGitHubBindingAccess(binding, factory));
  await assert.rejects(assertGitHubBindingAccess({ ...binding, providerRepositoryId: 91 }, factory),
    GitHubOnboardingAccessError);
  await assert.rejects(assertGitHubBindingAccess(binding, singleRepositoryFactory({
    accountId: 501, repositoryId: 90, repositoryName: "Example/renamed",
  })), GitHubOnboardingAccessError);
  await assert.rejects(assertGitHubBindingAccess(binding, singleRepositoryFactory({
    accountId: 501, repositoryId: 90, installationPermissions: { ...permissions, contents: "read" },
  })), (error: unknown) => error instanceof GitHubOnboardingAccessError
    && /permissions/u.test(error.message));
});

function installation(id: number, accountId: number) {
  return { id, app_id: 7, account: { id: accountId, login: `account-${accountId}` },
    permissions, suspended_at: null };
}

function singleRepositoryFactory(options: { accountId: number; repositoryId?: number;
  repositoryName?: string; installationPermissions?: Record<string, unknown> }): GitHubOnboardingProviderFactory {
  return {
    async appClient() {
      return { request: async (route) => {
        if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
        if (route === "GET /repos/{owner}/{repo}/installation") return { data: {
          ...installation(31, options.accountId), permissions: options.installationPermissions ?? permissions,
        } };
        assert.notEqual(route, "GET /users/{username}", "App JWT must not call user endpoints");
        throw new Error(`Unexpected app request ${route}`);
      } };
    },
    async installationClient() {
      return { request: async (route) => {
        if (route === "GET /users/{username}") {
          return { data: { id: 81, login: "review-app[bot]", type: "Bot" } };
        }
        assert.equal(route, "GET /repos/{owner}/{repo}");
        return { data: { id: options.repositoryId ?? 90,
          full_name: options.repositoryName ?? "Example/project" } };
      } };
    },
  };
}
