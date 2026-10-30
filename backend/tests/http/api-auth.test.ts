import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { RunApiAuthenticator } from "../../src/http/common/run-auth.js";
import { RunControlError } from "../../src/agent-runtime/runs/control-contracts.js";

const tenantId = randomUUID();
const integrationId = randomUUID();
const token = "test-token._~+/-=";
const adminToken = "repository-admin-token";

test("strict principal configuration rejects unknown fields and duplicate permissions", () => {
  assert.throws(() => new RunApiAuthenticator(JSON.stringify([{ ...record(), unexpected: true }])), /strict scoped principals/);
  assert.throws(() => new RunApiAuthenticator(JSON.stringify([{ ...record(), permissions: ["runs:read", "runs:read"] }])), /strict scoped principals/);
});

test("principal configuration rejects duplicate credential digests across scopes", () => {
  assert.throws(() => new RunApiAuthenticator(JSON.stringify([
    record(), { ...record(), subjectId: "other", tenantId: randomUUID() },
  ])), /unique SHA-256 token digests/);
});

test("authenticate returns only the configured tenant, integration, and permissions", () => {
  const principal = new RunApiAuthenticator(JSON.stringify([record()])).authenticate(`Bearer ${token}`);
  assert.deepEqual(principal, {
    subjectId: "api-user", actorType: "user", tenantId, integrationId,
    permissions: ["runs:read", "runs:trace"],
  });
  assert.equal(principal.permissions.includes("runs:cancel"), false);
});

test("repository administrator credentials are isolated from Run API credentials", () => {
  const authenticator = new RunApiAuthenticator(JSON.stringify([record(), adminRecord()]));
  assert.throws(() => authenticator.authenticate(`Bearer ${adminToken}`), (error: unknown) =>
    error instanceof RunControlError && error.code === "FORBIDDEN" && error.status === 403);
  assert.throws(() => authenticator.authenticateRepositoryAdmin(`Bearer ${token}`), (error: unknown) =>
    error instanceof RunControlError && error.code === "FORBIDDEN" && error.status === 403);
  assert.deepEqual(authenticator.authenticateRepositoryAdmin(`Bearer ${adminToken}`), {
    principalType: "repository_admin", subjectId: "repository-admin", actorType: "user",
    tenantId, githubAccountIds: [1234], permissions: ["repositories:manage"],
  });
});

test("one GitHub account cannot be assigned to repository administrators in different tenants", () => {
  assert.throws(() => new RunApiAuthenticator(JSON.stringify([
    adminRecord(),
    { ...adminRecord(), subjectId: "other-admin", tenantId: randomUUID(),
      tokenSha256: createHash("sha256").update("other-admin-token").digest("hex") },
  ])), /strict scoped principals/);
});

test("expired repository administrator credentials are denied", () => {
  const authenticator = new RunApiAuthenticator(JSON.stringify([{
    ...adminRecord(), expiresAt: "2020-01-01T00:00:00.000Z",
  }]));
  assert.throws(() => authenticator.authenticateRepositoryAdmin(`Bearer ${adminToken}`), (error: unknown) =>
    error instanceof RunControlError && error.code === "UNAUTHORIZED" && error.status === 401);
});

test("authenticate rejects malformed, oversized, and incorrect bearer credentials", () => {
  const authenticator = new RunApiAuthenticator(JSON.stringify([record()]));
  for (const authorization of [undefined, "bearer lower", "Basic abc", "Bearer bad token", `Bearer ${"x".repeat(4090)}`, "Bearer incorrect"]) {
    assert.throws(() => authenticator.authenticate(authorization), (error: unknown) =>
      error instanceof RunControlError && error.code === "UNAUTHORIZED" && error.status === 401);
  }
});

test("authenticate fails closed when the API credential registry is absent", () => {
  assert.throws(() => new RunApiAuthenticator(undefined).authenticate(`Bearer ${token}`), (error: unknown) =>
    error instanceof RunControlError && error.code === "RUN_API_DISABLED" && error.status === 503);
});

function record() {
  return {
    subjectId: "api-user", actorType: "user" as const,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    tenantId, integrationId, permissions: ["runs:read", "runs:trace"] as const,
  };
}

function adminRecord() {
  return {
    principalType: "repository_admin" as const,
    subjectId: "repository-admin", actorType: "user" as const,
    tokenSha256: createHash("sha256").update(adminToken).digest("hex"),
    tenantId, githubAccountIds: [1234], permissions: ["repositories:manage"] as const,
  };
}

test("expiry, not-before, disable and rotation are enforced without exposing key metadata", () => {
  for (const constraints of [{ expiresAt: new Date(Date.now()-1000).toISOString() },
    { notBefore: new Date(Date.now()+60_000).toISOString() }, { disabled: true }]) {
    const auth = new RunApiAuthenticator(JSON.stringify([{ ...record(), keyId: "old", ...constraints }]));
    assert.throws(() => auth.authenticate(`Bearer ${token}`), (error: unknown) =>
      error instanceof RunControlError && error.status === 401);
  }
  const auth = new RunApiAuthenticator(JSON.stringify([{ ...record(), keyId: "original" }]));
  const issued = auth.authenticate(`Bearer ${token}`);
  auth.assertCurrent(issued);
  const replacement = "replacement-token";
  auth.reload(JSON.stringify([{ ...record(), keyId: "rotated",
    tokenSha256: createHash("sha256").update(replacement).digest("hex") }]));
  assert.throws(() => auth.authenticate(`Bearer ${token}`));
  assert.throws(() => auth.assertCurrent(issued), /no longer valid/);
  assert.equal(auth.authenticate(`Bearer ${replacement}`).subjectId, "api-user");
  assert.throws(() => auth.reload("invalid-json"));
  assert.throws(() => auth.authenticate(`Bearer ${replacement}`), (error: unknown) =>
    error instanceof RunControlError && error.code === "RUN_API_DISABLED");
});
