import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { NestFactory } from "@nestjs/core";

import { GitHubAdminModule } from "../../src/http/admin/github/github-admin.module.js";

test("disabled onboarding exposes neither its public shell nor its protected API", async () => {
  const restore = configureEnvironment({ enabled: false });
  const app = await NestFactory.create(GitHubAdminModule, { logger: false, abortOnError: false });
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/api/admin/github`)).status, 404);
    assert.equal((await fetch(`${base}/api/admin/github/repositories`)).status, 404);
  } finally {
    await app.close();
    restore();
  }
});

test("enabled onboarding serves only fixed hardened assets and isolates Run credentials", async () => {
  const restore = configureEnvironment({ enabled: true });
  const app = await NestFactory.create(GitHubAdminModule, { logger: false, abortOnError: false });
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const page = await fetch(`${base}/api/admin/github`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal((await fetch(`${base}/api/admin/github/assets/app.js`)).status, 200);
    const missing = await fetch(`${base}/api/admin/github/assets/not-allowed.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/admin/github/assets/constructor`)).status, 404);

    assert.equal((await fetch(`${base}/api/admin/github/repositories`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/github/repositories`, {
      headers: { authorization: "Bearer run-token" },
    })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/github/repositories`, {
      headers: { authorization: "Bearer expired-admin-token" },
    })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/github/repositories`, {
      method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: "{}",
    })).status, 400);
  } finally {
    await app.close();
    restore();
  }
});

function configureEnvironment(options: { enabled: boolean }): () => void {
  const previousFeature = process.env.FEATURE_GITHUB_ONBOARDING;
  const previousPrincipals = process.env.HARNESS_API_PRINCIPALS_JSON;
  process.env.FEATURE_GITHUB_ONBOARDING = options.enabled ? "on" : "off";
  const tenantId = randomUUID();
  process.env.HARNESS_API_PRINCIPALS_JSON = JSON.stringify([{
    subjectId: "run-user", actorType: "user", tenantId, integrationId: randomUUID(),
    tokenSha256: createHash("sha256").update("run-token").digest("hex"), permissions: ["runs:read"],
  }, {
    principalType: "repository_admin", subjectId: "admin-user", actorType: "user", tenantId,
    githubAccountIds: [1234], permissions: ["repositories:manage"],
    tokenSha256: createHash("sha256").update("admin-token").digest("hex"),
  }, {
    principalType: "repository_admin", subjectId: "expired-admin", actorType: "user", tenantId,
    githubAccountIds: [1234], permissions: ["repositories:manage"], expiresAt: "2020-01-01T00:00:00.000Z",
    tokenSha256: createHash("sha256").update("expired-admin-token").digest("hex"),
  }]);
  return () => {
    if (previousFeature === undefined) delete process.env.FEATURE_GITHUB_ONBOARDING;
    else process.env.FEATURE_GITHUB_ONBOARDING = previousFeature;
    if (previousPrincipals === undefined) delete process.env.HARNESS_API_PRINCIPALS_JSON;
    else process.env.HARNESS_API_PRINCIPALS_JSON = previousPrincipals;
  };
}
