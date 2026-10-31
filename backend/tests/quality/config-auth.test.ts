import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunPermission, RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { resolveQualityConfiguration } from "../../src/quality/config.js";
import { readPrincipalConfiguration, RunApiAuthenticator } from "../../src/http/common/run-auth.js";

test("quality configuration enables public-key-only Web mode and fails closed for invalid explicit mode", () => {
  const enabled = resolveQualityConfiguration({ LANGFUSE_QUALITY_ENABLED: "auto", LANGFUSE_ENABLED: "on",
    LANGFUSE_BASE_URL: "https://langfuse.example.test/", LANGFUSE_PUBLIC_KEY: "pk-lf-web" });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.baseUrl, "https://langfuse.example.test");
  assert.equal(enabled.publicKey, "pk-lf-web");
  assert.equal(enabled.secretKey, undefined, "Web configuration must not require the Worker secret");
  assert.match(enabled.targetFingerprint, /^[a-f0-9]{64}$/u);

  assert.equal(resolveQualityConfiguration({ LANGFUSE_QUALITY_ENABLED: "off", LANGFUSE_ENABLED: "on",
    LANGFUSE_BASE_URL: "https://langfuse.example.test", LANGFUSE_PUBLIC_KEY: "pk-lf-web" }).enabled, false);
  assert.throws(() => resolveQualityConfiguration({ LANGFUSE_QUALITY_ENABLED: "on", LANGFUSE_ENABLED: "on",
    LANGFUSE_BASE_URL: "https://langfuse.example.test" }), /requires a valid base URL/u);
  assert.throws(() => resolveQualityConfiguration({ LANGFUSE_QUALITY_ENABLED: "sometimes" }),
    /must be auto, on, or off/u);
  assert.throws(() => resolveQualityConfiguration({ LANGFUSE_QUALITY_ENABLED: "on", LANGFUSE_ENABLED: "off",
    LANGFUSE_BASE_URL: "https://langfuse.example.test", LANGFUSE_PUBLIC_KEY: "pk-lf-web" }),
  /requires Langfuse tracing/u);
});

test("quality configuration permits private HTTP service discovery but rejects public or credentialed HTTP", () => {
  assert.equal(resolveQualityConfiguration({ LANGFUSE_ENABLED: "on", LANGFUSE_BASE_URL: "http://langfuse:3000",
    LANGFUSE_PUBLIC_KEY: "pk-lf-private" }).enabled, true);
  assert.equal(resolveQualityConfiguration({ LANGFUSE_ENABLED: "on", LANGFUSE_BASE_URL: "http://10.20.30.40:3000",
    LANGFUSE_PUBLIC_KEY: "pk-lf-private" }).enabled, true);
  assert.equal(resolveQualityConfiguration({ LANGFUSE_ENABLED: "on", LANGFUSE_BASE_URL: "http://203.0.113.8:3000",
    LANGFUSE_PUBLIC_KEY: "pk-lf-public" }).enabled, false);
  assert.equal(resolveQualityConfiguration({ LANGFUSE_ENABLED: "on", LANGFUSE_BASE_URL: "http://user:secret@langfuse:3000",
    LANGFUSE_PUBLIC_KEY: "pk-lf-private" }).enabled, false);
  assert.throws(() => resolveQualityConfiguration({ LANGFUSE_QUALITY_ENABLED: "on", LANGFUSE_ENABLED: "on",
    LANGFUSE_BASE_URL: "http://203.0.113.8:3000", LANGFUSE_PUBLIC_KEY: "pk-lf-public" }),
  /requires a valid base URL/u);
});

test("delegated persisted principals are revalidated without relying on issued-object identity", () => {
  const token = "quality-worker-token";
  const base = principalRecord(token, ["quality:sync:execute", "evaluations:read"]);
  const authenticator = new RunApiAuthenticator(JSON.stringify([base]));
  const authenticated = authenticator.authenticate(`Bearer ${token}`);
  const persisted = JSON.parse(JSON.stringify(authenticated)) as RunPrincipal;
  assert.notEqual(persisted, authenticated);
  assert.doesNotThrow(() => authenticator.assertDelegated(persisted));

  authenticator.reload(JSON.stringify([principalRecord(token, ["quality:sync:execute"])]));
  assert.throws(() => authenticator.assertDelegated(persisted), /no longer valid/u,
    "removing a required permission must revoke serialized queued work");
  authenticator.reload(JSON.stringify([principalRecord(token, ["quality:sync:execute", "evaluations:read"],
    { disabled: true })]));
  assert.throws(() => authenticator.assertDelegated(persisted), /no longer valid/u);
  authenticator.reload(undefined);
  assert.throws(() => authenticator.assertDelegated(persisted), /no longer valid/u,
    "removing the actor must revoke serialized queued work");

  const expired = new RunApiAuthenticator(JSON.stringify([principalRecord(token,
    ["quality:sync:execute", "evaluations:read"], { expiresAt: "2020-01-01T00:00:00.000Z" })]));
  assert.throws(() => expired.assertDelegated(persisted), /no longer valid/u);
});

test("principal configuration file is bounded and mutually exclusive with inline JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "pr-agent-quality-auth-"));
  const path = join(directory, "principals.json");
  const contents = JSON.stringify([principalRecord("file-token", ["quality:sync:execute"])]);
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  try {
    assert.equal(readPrincipalConfiguration({ HARNESS_API_PRINCIPALS_FILE: path }), contents);
    assert.equal(readPrincipalConfiguration({ HARNESS_API_PRINCIPALS_JSON: contents }), contents);
    assert.throws(() => readPrincipalConfiguration({ HARNESS_API_PRINCIPALS_FILE: path,
      HARNESS_API_PRINCIPALS_JSON: contents }), /Configure one/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function principalRecord(token: string, permissions: RunPermission[], extra: Record<string, unknown> = {}) {
  return { subjectId: "quality-worker", actorType: "service", tenantId: "11111111-1111-4111-8111-111111111111",
    integrationId: "22222222-2222-4222-8222-222222222222", permissions,
    tokenSha256: createHash("sha256").update(token).digest("hex"), ...extra };
}


test("quality workflows require tracing so exported experiments have trace links", () => {
  const config = { LANGFUSE_BASE_URL: "https://langfuse.example.test", LANGFUSE_PUBLIC_KEY: "pk-fixture", LANGFUSE_ENABLED: "off" };
  assert.equal(resolveQualityConfiguration(config).enabled, false);
  assert.throws(() => resolveQualityConfiguration({ ...config, LANGFUSE_QUALITY_ENABLED: "on" }), /requires Langfuse tracing/u);
});
