import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createAdminConfiguration,
  parseArguments,
  resolveGitHubAccount,
} from "./github-onboarding-admin.mjs";

const tenantId = "93b45b11-2228-4aaa-87d3-4c0c3fcbdf61";
const generatedKeyId = "8f487dcf-e195-4aa6-9eba-31046a65e587";

test("creates an offline, expiring principal whose digest matches the one-time bearer", async () => {
  const options = parseArguments([
    "--account-id", "263907852",
    "--tenant", tenantId,
    "--subject", "release-operator",
    "--expires-in-days", "7",
  ]);
  const output = await createAdminConfiguration(options, {
    now: new Date("2026-10-30T00:00:00.000Z"),
    randomBytesImpl: () => Buffer.from("credential-fixture"),
    randomUuidImpl: () => generatedKeyId,
  });

  assert.equal(output.bearerToken, Buffer.from("credential-fixture").toString("base64url"));
  assert.deepEqual(output.principal, {
    principalType: "repository_admin",
    subjectId: "release-operator",
    actorType: "user",
    tenantId,
    githubAccountIds: [263907852],
    permissions: ["repositories:manage"],
    tokenSha256: createHash("sha256").update(output.bearerToken).digest("hex"),
    keyId: `github-onboarding-${generatedKeyId}`,
    expiresAt: "2026-11-06T00:00:00.000Z",
  });
  assert.equal(output.configuration.FEATURE_GITHUB_ONBOARDING, "on");
  assert.equal(output.configuration.appendPrincipalToHARNESS_API_PRINCIPALS_JSON, output.principal);
});

test("resolves a GitHub login through the public users API without credentials", async () => {
  let request;
  const account = await resolveGitHubAccount("ConDevTools", {
    signal: AbortSignal.abort(),
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ id: 1234, login: "condevtools", type: "Organization" }) };
    },
  });

  assert.deepEqual(account, { id: 1234, login: "condevtools", type: "Organization" });
  assert.equal(request.url, "https://api.github.com/users/ConDevTools");
  assert.equal(request.init.headers["User-Agent"], "pr-agent-github-onboarding-admin");
  assert.equal("Authorization" in request.init.headers, false);
});

test("rejects ambiguous, unsafe, and overly long-lived CLI input", () => {
  assert.equal(parseArguments(["--", "--account-id", "1"]).accountId, 1);
  assert.throws(() => parseArguments([]), /exactly one/u);
  assert.throws(() => parseArguments(["--account", "org", "--account-id", "1"]), /exactly one/u);
  assert.throws(() => parseArguments(["--account-id", "0"]), /positive integer/u);
  assert.throws(() => parseArguments(["--account-id", "1", "--tenant", "not-a-uuid"]), /UUID/u);
  assert.throws(() => parseArguments(["--account-id", "1", "--expires-in-days", "366"]), /cannot exceed/u);
});

test("reports account lookup failures without reflecting a response body", async () => {
  await assert.rejects(
    resolveGitHubAccount("missing", {
      signal: AbortSignal.abort(),
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    { message: "GitHub account 'missing' was not found" },
  );
  await assert.rejects(
    resolveGitHubAccount("limited", {
      signal: AbortSignal.abort(),
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    { message: "GitHub account lookup failed with HTTP 403" },
  );
});
