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

test("App-wide installation discovery supports private Apps without an administrator allowlist", async () => {
  const scopes: string[] = [];
  const factory: GitHubOnboardingProviderFactory = {
    async appClient() {
      return { request: async (route, parameters = {}) => {
        scopes.push(`app:${route}:${String(parameters.page ?? "")}`);
        if (route === "GET /app") {
          return { data: { id: 7, slug: "private-review-app", name: "Private Review App", public: false } };
        }
        assert.equal(route, "GET /app/installations");
        return { data: Number(parameters.page) === 1 ? [
          installation(31, 501),
          { ...installation(32, 777), suspended_at: "2026-01-01T00:00:00Z" },
        ] : [] };
      } };
    },
    async installationClient() {
      throw new Error("discovery must not mint an installation client");
    },
  };

  const result = await new GitHubOnboardingProvider(factory).discoverInstallations("https://api.github.com/");
  assert.equal(result.app.id, 7);
  assert.deepEqual(result.installations.map(({ id, account, status }) => ({ id, accountId: account.id, status })), [
    { id: 31, accountId: 501, status: "active" },
    { id: 32, accountId: 777, status: "suspended" },
  ]);
  assert.deepEqual(scopes, ["app:GET /app:", "app:GET /app/installations:1"]);
});

test("installation snapshot never converts a partial paginated failure into an empty complete inventory", async () => {
  const factory = snapshotFactory(async (page) => {
    if (page === 1) return Array.from({ length: 100 }, (_unused, index) => repository(index));
    throw Object.assign(new Error("rate limited"), { status: 429 });
  });

  await assert.rejects(
    new GitHubOnboardingProvider(factory).installationSnapshot("https://api.github.com", 31, {
      maxAttempts: 1,
    }),
    (error: unknown) => error instanceof Error && /GitHub inventory request failed/u.test(error.message),
  );
});

test("installation snapshot accepts exactly 10,000 repositories only after an explicit terminal page", async () => {
  const requestedPages: number[] = [];
  const factory = snapshotFactory(async (page) => {
    requestedPages.push(page);
    if (page === 101) return [];
    return Array.from({ length: 100 }, (_unused, index) => repository((page - 1) * 100 + index));
  });

  const snapshot = await new GitHubOnboardingProvider(factory).installationSnapshot(
    "https://api.github.com/", 31,
  );
  assert.equal(snapshot.status, "active");
  assert.equal(snapshot.complete, true);
  if (snapshot.status !== "active") assert.fail("expected active snapshot");
  assert.equal(snapshot.repositories.length, 10_000);
  assert.equal(snapshot.repositories[9_999]!.identity.repositoryId, 19_999);
  assert.deepEqual(requestedPages, Array.from({ length: 101 }, (_unused, index) => index + 1));
});

test("installation snapshot keeps App and installation authentication scopes separated", async () => {
  const calls: string[] = [];
  const factory: GitHubOnboardingProviderFactory = {
    async appClient() {
      return { request: async (route) => {
        calls.push(`app:${route}`);
        if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
        if (route === "GET /app/installations/{installation_id}") return { data: installation(31, 501) };
        throw new Error(`Unexpected App request ${route}`);
      } };
    },
    async installationClient(_origin, installationId) {
      assert.equal(installationId, 31);
      return { request: async (route, parameters = {}) => {
        calls.push(`installation:${route}`);
        if (route === "GET /installation/repositories") {
          return { data: { repositories: Number(parameters.page) === 1 ? [repository(0)] : [] } };
        }
        if (route === "GET /users/{username}") {
          return { data: { id: 81, login: "review-app[bot]", type: "Bot" } };
        }
        throw new Error(`Unexpected installation request ${route}`);
      } };
    },
  };

  const snapshot = await new GitHubOnboardingProvider(factory).installationSnapshot("https://api.github.com", 31);
  assert.equal(snapshot.status, "active");
  if (snapshot.status !== "active") assert.fail("expected active snapshot");
  assert.deepEqual({
    appId: snapshot.app.id,
    installationId: snapshot.installation.id,
    accountId: snapshot.account.id,
    botId: snapshot.bot.id,
    repositoryId: snapshot.repositories[0]!.identity.repositoryId,
    fullName: snapshot.repositories[0]!.fullName,
  }, {
    appId: 7, installationId: 31, accountId: 501, botId: 81,
    repositoryId: 10_000, fullName: "Example/repo-0",
  });
  assert.deepEqual(calls, [
    "app:GET /app",
    "app:GET /app/installations/{installation_id}",
    "installation:GET /installation/repositories",
    "installation:GET /users/{username}",
  ]);
});

test("installation snapshot represents suspension, permission loss, and deletion restrictively", async (context) => {
  for (const scenario of [
    { name: "suspended", data: { ...installation(31, 501), suspended_at: "2026-01-01T00:00:00Z" },
      expected: "suspended" },
    { name: "permissions", data: { ...installation(31, 501), permissions: { ...permissions, contents: "read" } },
      expected: "permissions_incomplete" },
  ] as const) {
    await context.test(scenario.name, async () => {
      const factory: GitHubOnboardingProviderFactory = {
        async appClient() {
          return { request: async (route) => {
            if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
            if (route === "GET /app/installations/{installation_id}") return { data: scenario.data };
            throw new Error(`Unexpected app request ${route}`);
          } };
        },
        async installationClient() {
          throw new Error("restrictive installations must not mint an installation token");
        },
      };
      const snapshot = await new GitHubOnboardingProvider(factory).installationSnapshot("https://api.github.com", 31);
      assert.equal(snapshot.status, scenario.expected);
      assert.equal(snapshot.complete, true);
      assert.deepEqual(snapshot.repositories, []);
    });
  }

  await context.test("deleted", async () => {
    const factory: GitHubOnboardingProviderFactory = {
      async appClient() {
        return { request: async (route) => {
          if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
          if (route === "GET /app/installations/{installation_id}") {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          throw new Error(`Unexpected app request ${route}`);
        } };
      },
      async installationClient() {
        throw new Error("deleted installations must not mint an installation token");
      },
    };
    const snapshot = await new GitHubOnboardingProvider(factory).installationSnapshot("https://api.github.com", 31);
    assert.equal(snapshot.status, "deleted");
    assert.deepEqual(snapshot.installation, { id: 31, status: "deleted" });
  });
});

test("installation inventory retries only temporary API failures and honors cancellation", async () => {
  let attempts = 0;
  const retryingFactory: GitHubOnboardingProviderFactory = {
    async appClient() {
      return { request: async (route) => {
        if (route === "GET /app" && attempts++ === 0) throw Object.assign(new Error("unavailable"), { status: 503 });
        if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
        if (route === "GET /app/installations") return { data: [] };
        throw new Error(`Unexpected app request ${route}`);
      } };
    },
    async installationClient() { throw new Error("unused"); },
  };
  const discovered = await new GitHubOnboardingProvider(retryingFactory).discoverInstallations(
    "https://api.github.com", { backoffMs: 0 },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(discovered.installations, []);

  const controller = new AbortController();
  const hangingFactory: GitHubOnboardingProviderFactory = {
    async appClient() {
      return { request: async () => await new Promise(() => undefined) };
    },
    async installationClient() { throw new Error("unused"); },
  };
  const pending = new GitHubOnboardingProvider(hangingFactory).discoverInstallations(
    "https://api.github.com", { signal: controller.signal },
  );
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
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

function repository(index: number) {
  return { id: 10_000 + index, full_name: `Example/repo-${index}` };
}

function snapshotFactory(loadPage: (page: number) => Promise<unknown[]>): GitHubOnboardingProviderFactory {
  return {
    async appClient() {
      return { request: async (route) => {
        if (route === "GET /app") return { data: { id: 7, slug: "review-app", name: "Review App" } };
        if (route === "GET /app/installations/{installation_id}") return { data: installation(31, 501) };
        throw new Error(`Unexpected app request ${route}`);
      } };
    },
    async installationClient() {
      return { request: async (route, parameters = {}) => {
        if (route === "GET /installation/repositories") {
          return { data: { repositories: await loadPage(Number(parameters.page)) } };
        }
        if (route === "GET /users/{username}") {
          return { data: { id: 81, login: "review-app[bot]", type: "Bot" } };
        }
        throw new Error(`Unexpected installation request ${route}`);
      } };
    },
  };
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
