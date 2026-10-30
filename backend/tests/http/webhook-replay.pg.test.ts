import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (!databaseUrl) test.skip("Webhook replay requires Docker test database", () => {});
else {
  if (!new URL(databaseUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");
  const admin = new Pool({ connectionString: databaseUrl });
  const role = `replay_app_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID(); const integrationId = randomUUID();
  const otherTenant = randomUUID(); const otherIntegration = randomUUID();
  let store: typeof import("../../src/http/webhooks/replay/store.js");
  const principal = (tenant: string, integration: string): RunPrincipal => ({
    subjectId: "replay-test", actorType: "service", tenantId: tenant, integrationId: integration,
    permissions: ["replay:read","replay:execute"],
  });

  before(async () => {
    await migrateRuntime(admin);
    await admin.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,quiescence_receipt,review_execution_mode,execution_mode_generation)
      VALUES ($1,$2,'github','https://api.github.com','acme/project','101','201','env:GITHUB_TOKEN',
              'active',1,'{"protocol":"test"}'::jsonb,'harness_async',1),
             ($3,$4,'github','https://api.github.com','other/project','102','202','env:GITHUB_TOKEN',
              'active',1,'{"protocol":"test"}'::jsonb,'harness_async',1)`,
    [integrationId, tenantId, otherIntegration, otherTenant]);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role};
      GRANT SELECT ON pr_agent_harness.integration_bindings TO ${role};
      GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.webhook_replay_events TO ${role}`);
    const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.GITHUB_TOKEN = "test-token";
    store = await import("../../src/http/webhooks/replay/store.js");
  });
  after(async () => {
    const { closeAgentRuntime } = await import("../../src/agent-runtime/runtime.js");
    await closeAgentRuntime();
    await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await admin.end();
  });

  test("stores verified success and failure without secret headers or raw body", async () => {
    const scope = { tenantId, integrationId, platform: "github" as const };
    const payload = { repository: { name: "project", owner: { login: "acme" } }, action: "opened" };
    const first = await store.recordWebhookEvent({ scope, eventName: "issues",
      headers: { "x-github-delivery": "delivery-1", "x-hub-signature-256": "secret" }, payload,
      rawBody: JSON.stringify(payload), outcome: "succeeded", outcomeCode: "handled" });
    const failed = await store.recordWebhookEvent({ scope, eventName: "issues",
      headers: { "x-github-delivery": "delivery-2", authorization: "secret" }, payload: { ...payload, action: "edited" },
      rawBody: "sensitive-wire-body", outcome: "failed", outcomeCode: "RunCreateConflictError" });
    const listed = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId), limit: 10 });
    assert.deepEqual(new Set(listed.map((item) => item.outcome)), new Set(["succeeded","failed"]));
    const stored = await store.getStoredWebhookEventById({ principal: principal(tenantId,integrationId), id: first });
    assert.equal(stored?.headers["x-hub-signature-256"], undefined);
    assert.equal(stored?.headers.authorization, undefined);
    assert.equal(stored?.rawBodyHash, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    assert.equal("rawBody" in (stored ?? {}), false);
    assert.ok(await store.getStoredWebhookEventById({ principal: principal(tenantId,integrationId), id: failed }));
  });

  test("cross-tenant replay lookup is indistinguishable from missing", async () => {
    const id = await store.recordWebhookEvent({ scope: { tenantId,integrationId,platform:"github" }, eventName:"issues",
      headers:{"x-github-delivery":"tenant-isolation"}, payload:{ repository:{name:"project",owner:{login:"acme"}} },
      outcome:"failed",outcomeCode:"Error" });
    assert.equal(await store.getStoredWebhookEventById({ principal: principal(otherTenant,otherIntegration), id }), undefined);
    assert.deepEqual(await store.listStoredWebhookEvents({ principal: principal(otherTenant,otherIntegration) }), []);
  });

  test("verified GitHub transports share canonical hashes, outcomes and one metric per intake", async () => {
    const { runVerifiedGitHubIntake } = await import("../../src/http/webhooks/github/verified-github-intake.js");
    const { clearMetricState } = await import("../support/metrics-test-api.js");
    const { renderPrometheusMetrics } = await import("../../src/http/system/metrics-runtime.js");
    clearMetricState();
    const plainPayload = { action: "opened", repository: { owner: { login: "acme" }, name: "project" } };
    const probotPayload = { repository: { name: "project", owner: { login: "acme" } }, action: "opened" };
    const hashes: string[] = [];
    await runVerifiedGitHubIntake({ eventName: "issues", deliveryId: "plain-canonical", payload: plainPayload,
      rawBody: '{ "action": "opened", "repository": { "owner": { "login": "acme" }, "name": "project" } }',
      execute: async ({ sourceHash }) => { hashes.push(sourceHash); return { ok: true, message: "plain" }; } });
    await runVerifiedGitHubIntake({ eventName: "issues", deliveryId: "probot-canonical", payload: probotPayload,
      execute: async ({ sourceHash }) => { hashes.push(sourceHash); return { ok: true, message: "probot" }; } });
    await assert.rejects(runVerifiedGitHubIntake({ eventName: "issues", deliveryId: "verified-handler-failure",
      payload: probotPayload, execute: async () => { throw new Error("verified failure"); } }), /verified failure/);
    assert.equal(hashes[0], hashes[1]);

    const plain = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId),
      deliveryId: "plain-canonical" });
    const probot = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId),
      deliveryId: "probot-canonical" });
    const failed = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId),
      deliveryId: "verified-handler-failure" });
    assert.equal(plain[0]?.deliveryId, "plain-canonical");
    assert.equal(probot[0]?.deliveryId, "probot-canonical");
    assert.equal(failed[0]?.outcome, "failed");
    const plainStored = await store.getStoredWebhookEventById({ principal: principal(tenantId,integrationId), id: plain[0]!.id });
    const probotStored = await store.getStoredWebhookEventById({ principal: principal(tenantId,integrationId), id: probot[0]!.id });
    assert.equal(plainStored?.payloadHash, probotStored?.payloadHash);
    const metrics = renderPrometheusMetrics();
    assert.match(metrics, /pr_agent_webhook_requests_total\{event="issues",platform="github"\} 3/);
    assert.match(metrics, /pr_agent_webhook_results_total\{platform="github",result="ok"\} 2/);
    assert.match(metrics, /pr_agent_webhook_results_total\{platform="github",result="error"\} 1/);
  });

  test("invalid GitHub signatures never record intake or metrics", async () => {
    const { GithubWebhookService } = await import("../../src/http/webhooks/github/github-webhook.service.js");
    const { clearMetricState } = await import("../support/metrics-test-api.js");
    const { renderPrometheusMetrics } = await import("../../src/http/system/metrics-runtime.js");
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const previousSkip = process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
    process.env.GITHUB_WEBHOOK_SECRET = "signature-test-secret";
    delete process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
    clearMetricState();
    const payload = { repository: { name: "project", owner: { login: "acme" } }, action: "opened" };
    const before = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId), limit: 200 });
    try {
      await assert.rejects(new GithubWebhookService().handleTrigger({ payload, rawBody: JSON.stringify(payload),
        headers: { "x-github-event": "issues", "x-github-delivery": "invalid-signature",
          "x-hub-signature-256": "sha256=invalid" } }));
      const after = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId), limit: 200 });
      assert.equal(after.length, before.length);
      const metrics = renderPrometheusMetrics();
      assert.match(metrics, /pr_agent_webhook_requests_total 0/);
      assert.match(metrics, /pr_agent_webhook_results_total 0/);
      assert.doesNotMatch(metrics, /pr_agent_webhook_(?:requests|results)_total\{/);
    } finally {
      if (typeof previousSecret === "undefined") delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
      if (typeof previousSkip === "undefined") delete process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
      else process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = previousSkip;
    }
  });

  test("delivery lookup finds an event outside the newest 200 and validates the filter", async () => {
    const scope = { tenantId,integrationId,platform:"github" as const };
    await store.recordWebhookEvent({ scope, eventName:"issues", headers:{"x-github-delivery":"older-than-200"},
      payload:{repository:{name:"project",owner:{login:"acme"}},sequence:-1},outcome:"succeeded",outcomeCode:"handled" });
    for (let index = 0; index < 205; index += 1) {
      await store.recordWebhookEvent({ scope,eventName:"issues",headers:{"x-github-delivery":`newer-${index}`},
        payload:{repository:{name:"project",owner:{login:"acme"}},sequence:index},outcome:"succeeded",outcomeCode:"handled" });
    }
    const newest = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId), limit:200 });
    assert.equal(newest.some((event) => event.deliveryId === "older-than-200"), false);
    const found = await store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId),
      deliveryId:"older-than-200",limit:1 });
    assert.equal(found[0]?.deliveryId, "older-than-200");
    await assert.rejects(store.listStoredWebhookEvents({ principal: principal(tenantId,integrationId),
      deliveryId:"bad delivery id" }), /invalid webhook delivery id/);
    assert.deepEqual(await store.listStoredWebhookEvents({ principal: principal(otherTenant,otherIntegration),
      deliveryId:"older-than-200" }), []);
  });

  test("replay execution rejects a principal without replay permission before lookup", async () => {
    const { GithubWebhookController } = await import("../../src/http/webhooks/github/github-webhook.controller.js");
    const controller = new GithubWebhookController(undefined as never, {
      authenticate: () => ({ ...principal(tenantId,integrationId), permissions: [] }),
    } as never);
    await assert.rejects(controller.replay(randomUUID(), {} as never, {}), (error: unknown) => {
      return error instanceof Error
        && "status" in error
        && (error as { status: unknown }).status === 403;
    });
  });

}
