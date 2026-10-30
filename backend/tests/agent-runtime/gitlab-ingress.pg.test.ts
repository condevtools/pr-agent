import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { PublicationAuthorityStore } from "../../src/agent-runtime/authority/publication-authority.js";
import { closeAgentRuntime } from "../../src/agent-runtime/runtime.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import { runGitLabWebhook } from "../../src/integrations/gitlab/webhooks/adapter.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("GitLab ingress tests require isolated Docker HARNESS_TEST_DATABASE_URL");
} else {
  if (!decodeURIComponent(new URL(databaseUrl).pathname.slice(1)).startsWith("harness_test_")) {
    throw new Error("Disposable harness_test_* database required");
  }

  const admin = new Pool({ connectionString: databaseUrl });
  const role = `gitlab_ingress_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const origin = "https://gitlab.ingress.test";
  const repository = "acme/demo";
  const providerRepositoryId = 101;
  const providerUserId = 77;
  const previousEnv = new Map<string, string | undefined>();
  const logger = { info: () => undefined, error: () => undefined };

  before(async () => {
    await migrateRuntime(admin);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`
      GRANT USAGE ON SCHEMA pr_agent_harness TO ${role};
      GRANT SELECT ON pr_agent_harness.integration_bindings TO ${role};
      GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_runs,
        pr_agent_harness.job_queue, pr_agent_harness.tenant_budget_accounts,
        pr_agent_harness.run_budget_envelopes,
        pr_agent_harness.command_rate_limits TO ${role};
      GRANT SELECT, INSERT ON pr_agent_harness.run_events,
        pr_agent_harness.audit_logs, pr_agent_harness.model_pricing_snapshots TO ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
        pr_agent_harness.lock_current_binding_capability(uuid,uuid,text),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${role};
    `);

    const appUrl = new URL(databaseUrl);
    appUrl.username = role;
    appUrl.password = password;
    setEnv("HARNESS_DATABASE_URL", appUrl.toString());
    setEnv("GITLAB_BASE_URL", origin);
    setEnv("GITLAB_TOKEN", "server-gitlab-token");
    setEnv("ALLOW_INSECURE_GITLAB_HTTP", undefined);
    setEnv("AI_PROVIDER", "openai-compatible");
    setEnv("AI_MODEL", "fixture-model");
    setEnv("OPENAI_BASE_URL", "https://model.invalid/v1");
    setEnv("OPENAI_COMPATIBLE_API_KEY", "test-model-key");
    setEnv("HARNESS_MODEL_PRICING_JSON", productionPricingJson());

    const db = new RuntimeDatabase(admin);
    const runs = new RunStore(db);
    const authority = new PublicationAuthorityStore(db);
    await runs.registerIntegration({
      tenantId,
      id: integrationId,
      platform: "gitlab",
      origin,
      repository,
    });
    await authority.configure({
      tenantId,
      integrationId,
      providerRepositoryId,
      providerActorId: 9001,
      credentialRef: "env:GITLAB_TOKEN",
      expectedVersion: 0,
    });
    await authority.transition({
      tenantId,
      integrationId,
      expectedVersion: 1,
      action: "activate",
      actor: "gitlab-ingress-test",
      actorType: "service",
      quiescenceEvidence: "isolated Docker fixture",
    });
    await admin.query(
      `UPDATE pr_agent_harness.integration_bindings
       SET review_execution_mode='harness_async',execution_mode_generation=1
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );
  });

  after(async () => {
    await closeAgentRuntime();
    restoreEnv();
    await admin.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE");
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  test("unsupported GitLab commands stop before provider API and durable intake", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("unsupported commands must not call GitLab");
    };
    try {
      for (const note of ["/improve make this clearer", "/ask explain this"]) {
        const result = await runGitLabWebhook({
          payload: notePayload(note),
          headers: {},
          logger,
          skipSecurityVerification: true,
        });
        assert.deepEqual(result, { ok: true, message: "ignored note content" });
      }
      assert.equal(fetches, 0);
      assert.deepEqual(await durableCounts(), { runs: 0, jobs: 0, modelCalls: 0, batches: 0, operations: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GitLab member authorization gates and deduplicates durable review intake", async () => {
    const originalFetch = globalThis.fetch;
    let memberResponse: number | "404" | "500" = 20;
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      assert.equal(new Headers(init?.headers).get("private-token"), "server-gitlab-token");
      if (url.endsWith(`/api/v4/projects/${providerRepositoryId}/members/all/${providerUserId}`)) {
        if (memberResponse === "404") return new Response("not found", { status: 404 });
        if (memberResponse === "500") return new Response("failed", { status: 500 });
        return Response.json({ access_level: memberResponse });
      }
      if (decodeURIComponent(url).includes("/repository/files/.pr-agent.yml/raw?ref=main")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith(`/api/v4/projects/${providerRepositoryId}/merge_requests/12`)) {
        return Response.json({ diff_refs: { base_sha: "base-sha", head_sha: "head-sha" } });
      }
      return new Response("unexpected fixture route", { status: 500 });
    };

    try {
      const denied = await runGitLabWebhook({
        payload: notePayload("/ai-review"),
        headers: {},
        logger,
        skipSecurityVerification: true,
      });
      assert.deepEqual(denied, { ok: true, message: "ignored unauthorized command" });
      assert.deepEqual(await durableCounts(), { runs: 0, jobs: 0, modelCalls: 0, batches: 0, operations: 0 });
      assert.equal(requests.length, 1);

      memberResponse = "404";
      const missingMember = await runGitLabWebhook({
        payload: notePayload("/ai-review"), headers: {}, logger, skipSecurityVerification: true,
      });
      assert.deepEqual(missingMember, { ok: true, message: "ignored unauthorized command" });
      assert.deepEqual(await durableCounts(), { runs: 0, jobs: 0, modelCalls: 0, batches: 0, operations: 0 });

      memberResponse = 30;
      const first = await runGitLabWebhook({
        payload: notePayload("/ai-review"), headers: {}, logger, skipSecurityVerification: true,
      });
      const repeated = await runGitLabWebhook({
        payload: notePayload("/ai-review"), headers: {}, logger, skipSecurityVerification: true,
      });
      assert.deepEqual(first, { ok: true, message: "review command queued" });
      assert.deepEqual(repeated, { ok: true, message: "review command queued" });
      assert.deepEqual(await durableCounts(), { runs: 1, jobs: 1, modelCalls: 0, batches: 0, operations: 0 });
      const actor = await admin.query<{ created_by_actor_type: string; created_by_actor_id: string }>(
        `SELECT created_by_actor_type,created_by_actor_id
         FROM pr_agent_harness.agent_runs WHERE tenant_id=$1`,
        [tenantId],
      );
      assert.deepEqual(actor.rows, [{
        created_by_actor_type: "user",
        created_by_actor_id: `gitlab-user:${providerUserId}`,
      }]);

      memberResponse = "500";
      await assert.rejects(
        runGitLabWebhook({
          payload: notePayload("/ai-review"), headers: {}, logger, skipSecurityVerification: true,
        }),
        /member permission lookup failed \(500\)/,
      );
      assert.deepEqual(await durableCounts(), { runs: 1, jobs: 1, modelCalls: 0, batches: 0, operations: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  function notePayload(note: string) {
    return {
      object_kind: "note",
      project: { id: providerRepositoryId, name: "demo", web_url: `${origin}/${repository}`, path_with_namespace: repository },
      user: { id: providerUserId, username: "alice" },
      object_attributes: { action: "create", note, noteable_type: "MergeRequest" },
      merge_request: {
        iid: 12,
        title: "feat: durable GitLab intake",
        description: "description",
        source_branch: "feature",
        target_branch: "main",
        url: `${origin}/${repository}/-/merge_requests/12`,
      },
    };
  }

  async function durableCounts() {
    const result = await admin.query<{
      runs: string; jobs: string; model_calls: string; batches: string; operations: string;
    }>(
      `SELECT
         (SELECT count(*) FROM pr_agent_harness.agent_runs WHERE tenant_id=$1) AS runs,
         (SELECT count(*) FROM pr_agent_harness.job_queue WHERE tenant_id=$1) AS jobs,
         (SELECT count(*) FROM pr_agent_harness.model_calls WHERE tenant_id=$1) AS model_calls,
         (SELECT count(*) FROM pr_agent_harness.publication_batches WHERE tenant_id=$1) AS batches,
         (SELECT count(*) FROM pr_agent_harness.repository_operations WHERE tenant_id=$1) AS operations`,
      [tenantId],
    );
    const row = result.rows[0]!;
    return {
      runs: Number(row.runs),
      jobs: Number(row.jobs),
      modelCalls: Number(row.model_calls),
      batches: Number(row.batches),
      operations: Number(row.operations),
    };
  }

  function setEnv(name: string, value: string | undefined): void {
    if (!previousEnv.has(name)) previousEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function restoreEnv(): void {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function productionPricingJson(): string {
  return JSON.stringify({
    version: "gitlab-ingress-zero-price-v1",
    currency: "USD",
    periodKey: "gitlab-ingress-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
    models: {
      "openai-compatible:fixture-model": {
        rates: {
          inputMicrosPerMillion: 0,
          cachedInputMicrosPerMillion: 0,
          cacheWriteInputMicrosPerMillion: 0,
          outputMicrosPerMillion: 0,
          thoughtOutputMicrosPerMillion: 0,
          toolInputMicrosPerMillion: 0,
        },
        maxOutputTokens: 1_000,
        maxPhysicalCallsPerStep: 3,
        openAiTokenParameter: "max_tokens",
      },
    },
  });
}
