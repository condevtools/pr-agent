import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { RunApiAuthenticator } from "../src/harness/run-api-auth.js";
import { RunControlError } from "../src/harness/run-control-contracts.js";

const tenantId = randomUUID();
const integrationId = randomUUID();
const token = "test-token._~+/-=";

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
