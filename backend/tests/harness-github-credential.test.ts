import assert from "node:assert/strict";
import test from "node:test";

import { verifyGitHubCredentialIdentity, type GitHubAppIdentity } from "../src/integrations/github/auth/credential-identity.js";
import type { MinimalGitHubOctokit } from "../src/integrations/github/api/types.js";

function client() {
  const reads: string[] = [];
  const users = {
    getAuthenticated: async () => { reads.push("/user"); return { data: { id: 18, login: "reviewer" } }; },
    getByUsername: async ({ username }: { username: string }) => {
      reads.push(`/users/${username}`);
      return { data: { id: 91, login: username, type: "Bot" } };
    },
  };
  return { reads, users, octokit: { users } as MinimalGitHubOctokit };
}

test("GitHub user credential verifies the authenticated numeric principal", async () => {
  const fixture = client();
  assert.deepEqual(await verifyGitHubCredentialIdentity({ credentialRef: "env:GITHUB_TOKEN", octokit: fixture.octokit }), {
    kind: "user-token", actorId: 18,
  });
  assert.deepEqual(fixture.reads, ["/user"]);
  fixture.users.getAuthenticated = async () => ({ data: { id: 0, login: "reviewer" } });
  await assert.rejects(verifyGitHubCredentialIdentity({ credentialRef: "env:GITHUB_TOKEN", octokit: fixture.octokit }), /Invalid/);
});

test("GitHub App verifies app, installation and bot without treating app ID as actor ID", async () => {
  const fixture = client();
  const lookups: number[] = [];
  const identity = await verifyGitHubCredentialIdentity({
    credentialRef: "github-app:42", octokit: fixture.octokit,
    loadAppIdentity: async (installationId) => {
      lookups.push(installationId);
      return { app: { id: 7, slug: "reviewer-app" }, installation: { id: 42, app_id: 7, suspended_at: null } };
    },
  });
  assert.deepEqual(identity, { kind: "github-app-installation", actorId: 91, appId: 7, installationId: 42 });
  assert.deepEqual(lookups, [42]);
  assert.deepEqual(fixture.reads, ["/users/reviewer-app[bot]"]);
});

test("GitHub App rejects wrong or suspended installations before looking up a bot", async () => {
  const invalid: GitHubAppIdentity[] = [
    { app: { id: 7, slug: "app" }, installation: { id: 43, app_id: 7 } },
    { app: { id: 7, slug: "app" }, installation: { id: 42, app_id: 8 } },
    { app: { id: 7, slug: "app" }, installation: { id: 42, app_id: 7, suspended_at: "2026-10-28" } },
    { app: { id: 7, slug: "../app" }, installation: { id: 42, app_id: 7 } },
  ];
  for (const identity of invalid) {
    const fixture = client();
    await assert.rejects(verifyGitHubCredentialIdentity({ credentialRef: "github-app:42", octokit: fixture.octokit,
      loadAppIdentity: async () => identity }));
    assert.deepEqual(fixture.reads, []);
  }
});

test("GitHub App cannot substitute a user account or a different bot", async () => {
  for (const actor of [{ id: 91, login: "app[bot]", type: "User" }, { id: 91, login: "other[bot]", type: "Bot" }]) {
    const fixture = client();
    fixture.users.getByUsername = async () => ({ data: actor });
    await assert.rejects(verifyGitHubCredentialIdentity({ credentialRef: "github-app:42", octokit: fixture.octokit,
      loadAppIdentity: async () => ({ app: { id: 7, slug: "app" }, installation: { id: 42, app_id: 7 } }),
    }), /bot identity does not match/);
  }
});
