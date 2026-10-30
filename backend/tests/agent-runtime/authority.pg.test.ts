import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import {
  PublicationAuthorityStore,
  PublicationBindingBlockedError,
  PublicationBindingNotFoundError,
} from "../../src/agent-runtime/authority/publication-authority.js";
import { PublicationBatchStore } from "../../src/agent-runtime/publication/batches.js";
import { RunExecutionStore } from "../../src/agent-runtime/execution/store.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";
import { closeAgentRuntime } from "../../src/agent-runtime/runtime.js";
import { handleGitHubWebhookEvent } from "../../src/integrations/github/webhooks/handler.js";

const url = process.env.HARNESS_TEST_DATABASE_URL;
if (!url) {
  test.skip("Authority tests require isolated Docker HARNESS_TEST_DATABASE_URL");
} else {
  if (!decodeURIComponent(new URL(url).pathname.slice(1)).startsWith("harness_test_")) throw new Error("Disposable harness_test_* database required");
  const admin = new Pool({ connectionString: url });
  const db = new RuntimeDatabase(admin);
  const authority = new PublicationAuthorityStore(db);
  const registry = new RunStore(db);
  const role = `harness_authority_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  let app: Pool;
  let batches: PublicationBatchStore;
  let previousRuntimeUrl: string | undefined;
  let previousGitHubToken: string | undefined;
  const previousModelEnv = new Map<string, string | undefined>();
  before(async () => {
    await migrateRuntime(admin);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.integration_bindings FROM ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint) TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_current_binding_capability(uuid,uuid,text),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO ${role}`);
    const appUrl = new URL(url); appUrl.username = role; appUrl.password = password;
    app = new Pool({ connectionString: appUrl.toString(), max: 4 });
    batches = new PublicationBatchStore(new RuntimeDatabase(app));
    previousRuntimeUrl = process.env.HARNESS_DATABASE_URL;
    previousGitHubToken = process.env.GITHUB_TOKEN;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.GITHUB_TOKEN = "test-github-token";
    setModelEnv("AI_PROVIDER", "openai-compatible");
    setModelEnv("AI_MODEL", "fixture-model");
    setModelEnv("OPENAI_BASE_URL", "https://model.invalid/v1");
    setModelEnv("OPENAI_COMPATIBLE_API_KEY", "test-model-key");
    setModelEnv("HARNESS_MODEL_PRICING_JSON", productionPricingJson());
  });
  after(async () => {
    await closeAgentRuntime();
    if (previousRuntimeUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
    else process.env.HARNESS_DATABASE_URL = previousRuntimeUrl;
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
    for (const [name, value] of previousModelEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await app?.end();
    await admin.query("DROP SCHEMA pr_agent_harness CASCADE");
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  });

  async function enroll() {
    const tenantId = randomUUID(), id = randomUUID();
    const repository = `example/${id}`;
    await registry.registerIntegration({ tenantId, id, platform: "github", origin: "https://api.github.com", repository });
    return { tenantId, id, repository };
  }
  async function configure(input: Awaited<ReturnType<typeof enroll>>) {
    await authority.configure({ tenantId: input.tenantId, integrationId: input.id, providerRepositoryId: Math.floor(Math.random()*1e12)+1,
      providerActorId: 23, credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
  }
  async function activate(input: Awaited<ReturnType<typeof enroll>>) {
    await configure(input);
    return authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 1,
      action: "activate", actor: "test-admin", quiescenceEvidence: "isolated fixture; no prior publishers" });
  }
  function plan(input: Awaited<ReturnType<typeof enroll>>, runLease: RunLease, sourceKey = randomUUID()) {
    return { runLease, scope: { tenantId: input.tenantId, integrationId: input.id, platform: "github" as const,
      origin: "https://api.github.com", repository: input.repository, target: "1", revision: "head-a", authorityGeneration: 1 },
      sourceKey, sourceHash: createHash("sha256").update(sourceKey).digest("hex"),
      operations: [{ slot: "report", payload: { kind: "github-issue-comment", body: "frozen" } }] };
  }
  function issueCommentPayload(repository: string) {
    const [owner, repo] = repository.split("/");
    return {
      action: "created",
      repository: { name: repo, owner: { login: owner } },
      issue: { number: 12, pull_request: {} },
      comment: { id: 44, body: "/ai-review", user: { id: 77, type: "User", login: "alice" } },
    };
  }
  const logReasons: string[] = [];
  const logger = {
    info: (metadata: unknown) => {
      if (metadata && typeof metadata === "object" && "reason" in metadata) {
        logReasons.push(String((metadata as { reason: unknown }).reason));
      }
    },
    error: () => undefined,
  };

  test("activation requires immutable identity and an explicit quiescence receipt", async () => {
    const input = await enroll();
    await assert.rejects(
      authority.resolve("github", "https://api.github.com", input.repository),
      PublicationBindingBlockedError,
    );
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 0,
      action: "activate", actor: "admin", quiescenceEvidence: "drained" }), /immutable/);
    await configure(input);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 1,
      action: "activate", actor: "admin" }), /evidence/);
    const active = await authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: 1,
      action: "activate", actor: "admin", quiescenceEvidence: "old publishers stopped" });
    assert.equal(active.generation, 1);
    assert.equal(active.reviewExecutionMode, "harness_async");
    assert.equal(active.executionModeGeneration, 1);
    await assert.rejects(authority.configure({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: active.version,
      providerRepositoryId: 100, providerActorId: 200, credentialRef: "env:GITHUB_TOKEN" }), /unactivated/);
  });

  test("repository resolution distinguishes unmanaged repositories", async () => {
    await assert.rejects(
      authority.resolve("github", "https://api.github.com", `example/${randomUUID()}`),
      PublicationBindingNotFoundError,
    );
  });

  test("webhook ingress acknowledges only unmanaged bindings and preserves blocked errors", async () => {
    logReasons.length = 0;
    const unmanagedRepository = `example/${randomUUID()}`;
    const ignored = await handleGitHubWebhookEvent({
      eventName: "issue_comment",
      payload: issueCommentPayload(unmanagedRepository),
      octokit: {} as never,
      logger,
      runtimeMode: "github-webhook",
    });
    assert.deepEqual(ignored, { ok: true, message: "ignored unmanaged repository" });
    assert.deepEqual(logReasons, ["publication_binding_not_found"]);

    const blocked = await enroll();
    await assert.rejects(
      handleGitHubWebhookEvent({
        eventName: "issue_comment",
        payload: issueCommentPayload(blocked.repository),
        octokit: {} as never,
        logger,
        runtimeMode: "github-webhook",
      }),
      PublicationBindingBlockedError,
    );
  });

  test("webhook ingress acknowledges insufficient collaborator permission", async () => {
    logReasons.length = 0;
    const input = await enroll();
    await activate(input);
    let permissionReads = 0;
    const result = await handleGitHubWebhookEvent({
      eventName: "issue_comment",
      payload: issueCommentPayload(input.repository),
      octokit: {
        repos: {
          getCollaboratorPermissionLevel: async () => {
            permissionReads += 1;
            return { data: { permission: "read" } };
          },
        },
      } as never,
      logger,
      runtimeMode: "github-webhook",
    });
    assert.deepEqual(result, { ok: true, message: "ignored unauthorized command" });
    assert.equal(permissionReads, 1);
    assert.deepEqual(logReasons, ["command_actor_not_authorized"]);

    await assert.rejects(
      handleGitHubWebhookEvent({
        eventName: "issue_comment",
        payload: issueCommentPayload(input.repository),
        octokit: {
          repos: {
            getCollaboratorPermissionLevel: async () => {
              throw new Error("permission provider unavailable");
            },
          },
        } as never,
        logger,
        runtimeMode: "github-webhook",
      }),
      /permission provider unavailable/,
    );
  });

  test("authorized GitHub command records the signed user actor and deduplicates delivery intake", async () => {
    const input = await enroll();
    await activate(input);
    let permissionReads = 0;
    const octokit = {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          permissionReads += 1;
          return { data: { permission: "write" } };
        },
        getContent: async () => ({ data: [] }),
      },
      pulls: {
        get: async () => ({ data: {
          number: 12,
          title: "feat: durable GitHub intake",
          body: "description",
          user: { login: "alice" },
          base: { ref: "main", sha: "base-sha" },
          head: { ref: "feature", sha: "head-sha" },
          html_url: "https://github.com/example/demo/pull/12",
          draft: false,
        } }),
      },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await handleGitHubWebhookEvent({
        eventName: "issue_comment",
        payload: issueCommentPayload(input.repository),
        octokit: octokit as never,
        logger,
        runtimeMode: "github-webhook",
        deliveryId: "github-delivery-actor-1",
      });
      assert.deepEqual(result, { ok: true, message: "review command queued" });
    }
    const stored = await admin.query<{
      created_by_actor_type: string; created_by_actor_id: string; jobs: string;
    }>(
      `SELECT r.created_by_actor_type,r.created_by_actor_id,
              (SELECT count(*) FROM pr_agent_harness.job_queue j
               WHERE j.tenant_id=r.tenant_id AND j.run_id=r.id) AS jobs
       FROM pr_agent_harness.agent_runs r
       WHERE r.tenant_id=$1 AND r.integration_id=$2`,
      [input.tenantId, input.id],
    );
    assert.deepEqual(stored.rows, [{
      created_by_actor_type: "user",
      created_by_actor_id: "github-user:77",
      jobs: "1",
    }]);
    assert.equal(permissionReads, 2);
  });

  test("draining blocks new batches and unresolved operations block authority flips", async () => {
    const input = await enroll(); const active = await activate(input);
    const runLease = await createLease(input, "draining");
    const batch = await batches.freeze(plan(input, runLease));
    const draining = await authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: active.version,
      action: "drain", actor: "admin" });
    await assert.rejects(batches.freeze(plan(input, runLease)), /binding|authority/i);
    assert.equal((await batches.load(input.tenantId, batch.id))?.id, batch.id);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: draining.version,
      action: "activate", actor: "admin", quiescenceEvidence: "not enough while unresolved" }), /Unresolved/);
    await assert.rejects(authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: draining.version,
      action: "block", actor: "admin" }), /Unresolved/);
  });

  test("concurrent freeze and drain serialize without granting registry mutation", async () => {
    const input = await enroll(); const active = await activate(input);
    const runLease = await createLease(input, "concurrent");
    const [frozen, drained] = await Promise.allSettled([
      batches.freeze(plan(input, runLease)),
      authority.transition({ tenantId: input.tenantId, integrationId: input.id, expectedVersion: active.version, action: "drain", actor: "admin" }),
    ]);
    assert.equal(drained.status, "fulfilled");
    if (frozen.status === "fulfilled") assert.equal((await batches.load(input.tenantId, frozen.value.id))?.operations.length, 1);
    await assert.rejects(batches.freeze(plan(input, runLease)), /binding|authority/i);
    await assert.rejects(app.query("UPDATE pr_agent_harness.integration_bindings SET publication_state='active'"), (error: any) => error.code === "42501");
  });

  function setModelEnv(name: string, value: string): void {
    previousModelEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  async function createLease(input: Awaited<ReturnType<typeof enroll>>, suffix: string): Promise<RunLease> {
    const version = createHash("sha256").update(`authority:${suffix}`).digest("hex");
    await registry.createRun({
      tenantId: input.tenantId,
      integrationId: input.id,
      actorType: "service",
      actorId: "authority-test",
      createScope: "test:authority-publication:v1",
      createKey: suffix,
      requestHash: createHash("sha256").update(`request:${suffix}`).digest("hex"),
      runType: "review",
      baseSha: "base-a",
      headSha: "head-a",
      workflowVersionHash: version,
      promptVersionHash: version,
      modelVersionHash: version,
      toolVersionHash: version,
      policyVersionHash: version,
      runtimeVersionHash: version,
      input: { suffix },
      authorityGeneration: 1,
      executionModeGeneration: 1,
      runtimeConfig: { maxRunMs: 60_000 },
    });
    const lease = await new RunExecutionStore(db).claim({
      tenantId: input.tenantId,
      integrationId: input.id,
      authorityGeneration: 1,
      executionModeGeneration: 1,
    }, `authority-worker-${suffix}`, version);
    assert.ok(lease);
    return lease;
  }
}

function productionPricingJson(): string {
  return JSON.stringify({
    version: "authority-zero-price-v1", currency: "USD", periodKey: "authority-tests",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
    models: { "openai-compatible:fixture-model": { rates: {
      inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0, thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0,
    }, maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } },
  });
}
