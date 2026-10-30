import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { GitHubAdminService,
  mergeGitHubRepositoryInventory } from "../../src/http/admin/github/github-admin.service.js";

test("repository inventory never leaks bindings outside the administrator account and app scope", () => {
  const visible = binding({ id: "visible", repository: "allowed/missing", repositoryId: 101,
    accountId: 501, appId: 7 });
  const otherAccount = binding({ id: "other-account", repository: "other/private", repositoryId: 102,
    accountId: 999, appId: 7 });
  const otherApp = binding({ id: "other-app", repository: "allowed/other-app", repositoryId: 103,
    accountId: 501, appId: 8 });
  const legacy = { ...binding({ id: "legacy", repository: "legacy/private", repositoryId: 104,
    accountId: 501, appId: 7 }), githubAccountId: undefined, githubAppId: undefined };

  const result = mergeGitHubRepositoryInventory([], [visible, otherAccount, otherApp, legacy],
    new Set(), [501], 7);
  assert.deepEqual(result.map((repository) => repository.repository), ["allowed/missing"]);
});

test("bindings absent from the complete provider inventory are fail-closed instead of reported active", () => {
  const missing = binding({ id: "missing", repository: "allowed/missing", repositoryId: 101,
    accountId: 501, appId: 7 });
  const revoked = { ...binding({ id: "revoked", repository: "allowed/revoked", repositoryId: 102,
    accountId: 501, appId: 7 }), providerAccessState: "revoked" as const };
  const suspended = binding({ id: "suspended", repository: "allowed/suspended", repositoryId: 103,
    accountId: 501, appId: 7, installationId: 33 });

  const result = mergeGitHubRepositoryInventory([], [missing, revoked, suspended], new Set([33]), [501], 7);
  assert.deepEqual(result.map(({ repository, status, binding: view }) => ({
    repository, status, providerAccessState: view?.providerAccessState,
  })), [
    { repository: "allowed/missing", status: "unknown", providerAccessState: "unknown" },
    { repository: "allowed/revoked", status: "revoked", providerAccessState: "revoked" },
    { repository: "allowed/suspended", status: "suspended", providerAccessState: "unknown" },
  ]);
});

test("a binding present in the authorized live inventory keeps its verified active status", () => {
  const current = binding({ id: "current", repository: "allowed/current", repositoryId: 101,
    accountId: 501, appId: 7 });
  const result = mergeGitHubRepositoryInventory([{
    identity: { origin: "https://api.github.com", repository: "allowed/current", appId: 7,
      installationId: 31, accountId: 501, repositoryId: 101, actorId: 81 },
    account: "allowed", suspended: false,
  }], [current], new Set(), [501], 7);
  assert.equal(result[0]?.status, "active");
  assert.equal(result[0]?.binding?.providerAccessState, "verified");
});

test("a repository rename or installation replacement is unknown until explicit revalidation", () => {
  const renamed = binding({ id: "renamed", repository: "allowed/old-name", repositoryId: 101,
    accountId: 501, appId: 7 });
  const reinstalled = binding({ id: "reinstalled", repository: "allowed/reinstalled", repositoryId: 102,
    accountId: 501, appId: 7, installationId: 30 });
  const result = mergeGitHubRepositoryInventory([repository("allowed/new-name", 101, 31),
    repository("allowed/reinstalled", 102, 31)], [renamed, reinstalled], new Set(), [501], 7);
  assert.deepEqual(result.map(({ repository: name, status, binding: view }) => ({
    name, status, providerAccessState: view?.providerAccessState,
  })), [
    { name: "allowed/new-name", status: "unknown", providerAccessState: "unknown" },
    { name: "allowed/reinstalled", status: "unknown", providerAccessState: "unknown" },
  ]);
});

test("an authorized live identity exposes a legacy binding only for explicit revalidation", () => {
  const legacy = { ...binding({ id: "legacy", repository: "allowed/current", repositoryId: 101,
    accountId: 501, appId: 7 }), githubAccountId: undefined, githubAppId: undefined };
  const result = mergeGitHubRepositoryInventory([repository("allowed/current", 101, 31)],
    [legacy], new Set(), [501], 7);
  assert.equal(result[0]?.binding?.id, "legacy");
  assert.equal(result[0]?.status, "unknown");
  assert.equal(result[0]?.binding?.providerAccessState, "unknown");
});

test("legacy binding discovery fails closed on actor mismatch", () => {
  const legacy = { ...binding({ id: "legacy", repository: "allowed/current", repositoryId: 101,
    accountId: 501, appId: 7 }), githubAccountId: undefined, githubAppId: undefined,
    providerActorId: 82 };
  const result = mergeGitHubRepositoryInventory([repository("allowed/current", 101, 31)],
    [legacy], new Set(), [501], 7);
  assert.equal(result[0]?.binding, null);
  assert.equal(result[0]?.status, "not_connected");
});

test("a binding from another account cannot attach to the authorized repository inventory", () => {
  const otherAccount = binding({ id: "other-account", repository: "allowed/current", repositoryId: 101,
    accountId: 999, appId: 7 });
  const result = mergeGitHubRepositoryInventory([repository("allowed/current", 101, 31)],
    [otherAccount], new Set(), [501], 7);
  assert.equal(result[0]?.binding, null);
  assert.equal(result[0]?.status, "not_connected");
});

test("an unresolved publication conflict is a safe actionable admin conflict", async () => {
  const previous = process.env.FEATURE_GITHUB_ONBOARDING;
  process.env.FEATURE_GITHUB_ONBOARDING = "on";
  try {
    const service = new GitHubAdminService({} as never);
    Reflect.set(service, "provider", { discover: async () => {
      throw Object.assign(new Error("database detail must not escape"), { code: "55000" });
    } });
    await assert.rejects(service.repositories({
      principalType: "repository_admin", subjectId: "admin", actorType: "user",
      tenantId: randomUUID(), githubAccountIds: [501], permissions: ["repositories:manage"],
    }), (error: unknown) => error instanceof HttpException && error.getStatus() === 409
      && /unconfirmed publication results/u.test(String(error.getResponse()))
      && !String(error.getResponse()).includes("database detail"));
  } finally {
    if (previous === undefined) delete process.env.FEATURE_GITHUB_ONBOARDING;
    else process.env.FEATURE_GITHUB_ONBOARDING = previous;
  }
});

function binding(input: { id: string; repository: string; repositoryId: number;
  accountId: number; appId: number; installationId?: number }): PublicationBinding {
  return {
    id: input.id, tenantId: "00000000-0000-4000-8000-000000000001", platform: "github",
    origin: "https://api.github.com", repository: input.repository,
    providerRepositoryId: input.repositoryId, providerActorId: 81,
    credentialRef: `github-app:${input.installationId ?? 31}`, generation: 1, version: 2,
    state: "active", reviewExecutionMode: "harness_async", capabilities: {
      reviewSingle: true, reviewDeep: true, fix: false, evolution: false,
      defaultReviewWorkflow: "review.single.v1",
    },
    providerAccessState: "verified", providerAccessVersion: 4,
    githubAppId: input.appId, githubAccountId: input.accountId,
  };
}

function repository(name: string, repositoryId: number, installationId: number) {
  return {
    identity: { origin: "https://api.github.com", repository: name, appId: 7,
      installationId, accountId: 501, repositoryId, actorId: 81 },
    account: "allowed", suspended: false,
  };
}
