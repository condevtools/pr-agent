import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { GitHubInstallationSyncStore } from "../../../src/agent-runtime/authority/github-installation-sync.js";
import { RuntimeDatabase } from "../../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../../src/agent-runtime/postgres/migrations.js";
import { createAgentRuntimeServices, withAgentRuntimeServices,
  type AgentRuntimeServices } from "../../../src/agent-runtime/runtime/services.js";
import { closeGitHubOnboardingStore } from "../../../src/agent-runtime/runtime/github-onboarding.js";
import { processDeferredGitHubPullRequest,
  type DeferredGitHubDependencies } from "../../../src/integrations/github/onboarding/deferred-pull-request.js";
import { GitHubInstallationReconciler } from "../../../src/integrations/github/onboarding/reconciler.js";
import type { GitHubInstallationSnapshot } from "../../../src/integrations/github/onboarding/provider.js";
import { handleGitHubWebhookEvent, verifyWebhookSignature } from
  "../../../src/integrations/github/webhooks/handler.js";
import { runVerifiedGitHubIntake } from "../../../src/http/webhooks/github/verified-github-intake.js";
import { canonicalizeWebhookPayload } from "../../../src/http/webhooks/replay/store.js";
import { GithubWebhookService } from "../../../src/http/webhooks/github/github-webhook.service.js";
import { GitHubDeliveryHandoffError } from "../../../src/review/intake/github-delivery-handoff.js";
import { enqueueGitHubReviewForBinding } from "../../../src/review/intake/provider-intake.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) test.skip("GitHub install-and-use requires isolated Docker PostgreSQL", () => {});
else {
  if (!new URL(databaseUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");
  const owner = new Pool({ connectionString: databaseUrl });
  const appPassword = randomUUID();
  const onboardingPassword = randomUUID();
  const tenantId = randomUUID();
  const appId = 7;
  const installationId = 31;
  const accountId = 501;
  const repositoryId = 10_000;
  const webhookSecret = "install-and-use-fixture-secret";
  const savedEnv = new Map<string, string | undefined>();
  let app: AgentRuntimeServices;
  let syncStore: GitHubInstallationSyncStore;
  let onboardingPool: Pool;

  before(async () => {
    for (const [role, password] of [["pr_agent_app", appPassword],
      ["pr_agent_onboarding", onboardingPassword]] as const) {
      const exists = await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      const ddl = await owner.query<{ sql: string }>(exists.rowCount
        ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) AS sql"
        : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) AS sql",
      [role, password]);
      await owner.query(ddl.rows[0]!.sql);
    }
    await migrateRuntime(owner);
    await owner.query(`INSERT INTO pr_agent_harness.github_account_tenant_mappings
      (github_app_id,github_account_id,tenant_id,mapping_source)
      VALUES ($1,$2,$3,'auto_created')`, [appId, accountId, tenantId]);

    const parsed = new URL(databaseUrl);
    setEnv("HARNESS_PG_HOST", parsed.hostname);
    setEnv("HARNESS_PG_PORT", parsed.port || "5432");
    setEnv("HARNESS_PG_DATABASE", decodeURIComponent(parsed.pathname.slice(1)));
    setEnv("HARNESS_PG_USER", "pr_agent_app");
    setEnv("HARNESS_PG_PASSWORD", appPassword);
    setEnv("HARNESS_ONBOARDING_PG_PASSWORD", onboardingPassword);
    setEnv("HARNESS_PG_POOL_MAX", "4");
    setEnv("APP_ID", String(appId));
    setEnv("PRIVATE_KEY", "fixture-private-key");
    setEnv("WEBHOOK_SECRET", webhookSecret);
    setEnv("GITHUB_WEBHOOK_SECRET", "plain-webhook-fixture-secret");
    setEnv("GITHUB_WEBHOOK_TOKEN", undefined);
    setEnv("GITHUB_TOKEN", undefined);
    setEnv("FEATURE_GITHUB_ONBOARDING", "on");
    setEnv("AI_PROVIDER", "openai-compatible");
    setEnv("AI_MODEL", "fixture-model");
    setEnv("OPENAI_BASE_URL", "https://model.invalid/v1");
    setEnv("OPENAI_COMPATIBLE_API_KEY", "fixture-only-never-called");
    setEnv("HARNESS_MODEL_PRICING_JSON", pricing());
    setEnv("HARNESS_DATABASE_URL", undefined);

    app = createAgentRuntimeServices("web");
    await app.assertRole();
    const restrictedUrl = new URL(databaseUrl);
    restrictedUrl.username = "pr_agent_onboarding";
    restrictedUrl.password = onboardingPassword;
    onboardingPool = new Pool({ connectionString: restrictedUrl.toString(), max: 2 });
    syncStore = new GitHubInstallationSyncStore(new RuntimeDatabase(onboardingPool));
  });

  after(async () => {
    await closeGitHubOnboardingStore();
    await app?.close();
    await onboardingPool?.end();
    for (const [name, value] of savedEnv) value === undefined ? delete process.env[name] : process.env[name] = value;
    await owner.end();
  });

  test("verified install immediately accepts a PR, reconciles it once, and preserves fences", async () => {
    await signedIntake("installation", "install-created", lifecyclePayload("created"));

    const deliveryId = "pull-before-binding";
    const pullPayload = pullRequestPayload("opened");
    const admitted = await signedNestIntake("pull_request", deliveryId, pullPayload);
    assert.match(admitted.message, /queued pending GitHub installation synchronization/u);
    await assert.rejects(signedNestIntake("pull_request", "plain-cannot-defer", pullPayload,
      "plain-webhook-fixture-secret"), /Missing GITHUB_WEBHOOK_TOKEN/u);
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM
      pr_agent_harness.github_deferred_pull_requests WHERE delivery_id=$1`, [deliveryId])).rows[0]!.count, 1);
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM
      pr_agent_harness.github_deferred_pull_requests WHERE delivery_id='plain-cannot-defer'`)).rows[0]!.count, 0);

    const dependencies = deferredDependencies();
    const reconciler = new GitHubInstallationReconciler({
      store: syncStore,
      provider: { discoverInstallations: async () => ({ app: { id: appId, slug: "review-app", name: "Review App" },
        installations: [] }), installationSnapshot: async () => snapshot() },
      origin: "https://api.github.com", appId, ownerId: "install-and-use-test",
      processDeferred: (claim, signal) => withAgentRuntimeServices(app,
        () => processDeferredGitHubPullRequest(claim, signal, syncStore, dependencies)),
    });
    await reconciler.runOnce();

    const bindingResult = await owner.query(`SELECT id,tenant_id FROM pr_agent_harness.integration_bindings
      WHERE provider_repository_id=$1`, [String(repositoryId)]);
    assert.equal(bindingResult.rowCount, 1);
    const binding = (await app.authority.findByProviderRepository("github", "https://api.github.com", repositoryId))!.binding;
    const counts = await runCounts(deliveryId);
    assert.deepEqual(counts, { runs: 1, jobs: 1, budgets: 1 });

    await owner.query(`UPDATE pr_agent_harness.integration_bindings
      SET default_review_workflow='review.deep.v1',review_deep_enabled=true WHERE id=$1`, [binding.id]);
    const changedWorkflowBinding = (await app.authority.findByProviderRepository(
      "github", "https://api.github.com", repositoryId))!.binding;
    const sameRun = await withAgentRuntimeServices(app, () => enqueueGitHubReviewForBinding(
      enqueueParams(deliveryId, sourceHash(pullPayload)), changedWorkflowBinding, undefined,
    ));
    assert.equal(sameRun, (await owner.query(`SELECT id FROM pr_agent_harness.agent_runs
      WHERE source_key=$1`, [`github:delivery:${deliveryId}`])).rows[0]!.id);
    assert.deepEqual(await runCounts(deliveryId), { runs: 1, jobs: 1, budgets: 1 });

    await assert.rejects(withAgentRuntimeServices(app, () => enqueueGitHubReviewForBinding(
      enqueueParams(deliveryId, "f".repeat(64)), changedWorkflowBinding,
    )), (error: unknown) => error instanceof GitHubDeliveryHandoffError);
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM pr_agent_harness.audit_logs
      WHERE tenant_id=$1 AND reason_code='source_identity_conflict'`, [tenantId])).rows[0]!.count, 1,
    "integrity denial must commit its audit record");

    await signedIntake("installation_repositories", "repo-removed", {
      ...lifecyclePayload("removed"), repositories_removed: [{ id: repositoryId }],
    });
    await signedIntake("installation_repositories", "repo-added", lifecyclePayload("added"));
    const secondDelivery = "pull-after-readd-before-sync";
    const waiting = await signedIntake("pull_request", secondDelivery, pullRequestPayload("synchronize"));
    assert.match(waiting.message, /queued pending/u);
    await reconciler.runOnce();
    assert.deepEqual(await runCounts(secondDelivery), { runs: 1, jobs: 1, budgets: 1 });

    await owner.query("UPDATE pr_agent_harness.integration_bindings SET review_execution_state='draining' WHERE id=$1",
      [binding.id]);
    const drainingDelivery = "managed-draining";
    const draining = await signedNestIntake("pull_request", drainingDelivery, pullRequestPayload("edited"));
    assert.match(draining.message, /disabled by operator/u);
    assert.deepEqual(await runCounts(drainingDelivery), { runs: 0, jobs: 0, budgets: 0 });
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM
      pr_agent_harness.github_deferred_pull_requests WHERE delivery_id=$1`, [drainingDelivery])).rows[0]!.count, 0);
    await owner.query("UPDATE pr_agent_harness.integration_bindings SET review_execution_state='active' WHERE id=$1",
      [binding.id]);

    await owner.query("UPDATE pr_agent_harness.integration_bindings SET active=false WHERE id=$1", [binding.id]);
    const suppressed = await signedIntake("pull_request", "operator-disabled", pullRequestPayload("edited"));
    assert.match(suppressed.message, /disabled by operator/u);
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM
      pr_agent_harness.github_deferred_pull_requests WHERE delivery_id='operator-disabled'`)).rows[0]!.count, 0);
  });

  async function signedIntake(eventName: string, deliveryId: string, payload: unknown) {
    const rawBody = JSON.stringify(payload);
    verifyWebhookSignature(rawBody, { "x-github-event": eventName,
      "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret)
      .update(rawBody).digest("hex")}` });
    return withAgentRuntimeServices(app, () => runVerifiedGitHubIntake({ eventName, deliveryId, payload, rawBody,
      execute: ({ sourceHash: hash }) => handleGitHubWebhookEvent({ eventName, payload,
        octokit: {} as never, logger: { info() {}, error() {} }, runtimeMode: "github-app",
        deliveryId, sourceHash: hash }) }));
  }

  async function signedNestIntake(eventName: string, deliveryId: string, payload: unknown,
    secret = webhookSecret) {
    const rawBody = JSON.stringify(payload);
    return withAgentRuntimeServices(app, () => new GithubWebhookService().handleTrigger({ payload, rawBody,
      headers: { "x-github-event": eventName, "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret)
          .update(rawBody).digest("hex")}` } }));
  }

  function deferredDependencies(): DeferredGitHubDependencies {
    return {
      findBinding: (id) => app.authority.findByProviderRepository("github", "https://api.github.com", id),
      loadCurrent: async () => ({ context: context(), pull: currentPull() }),
      resolvePolicy: async () => policy(), resolveMergedPolicy: async () => ({ ...policy(),
        improveCommandEnabled: true, addDocCommandEnabled: true }),
      enqueue: enqueueGitHubReviewForBinding,
    };
  }

  function context() {
    return { repo: () => ({ owner: "example", repo: "project" }), octokit: {
      pulls: { get: async () => ({ data: currentPull() }) },
    } as never, log: { info() {}, error() {} } };
  }
  function enqueueParams(deliveryId: string, hash: string) {
    return { context: context(), pullNumber: 1, mode: "comment" as const, trigger: "pr-opened" as const,
      sourceKey: `github:delivery:${deliveryId}`, sourceHash: hash, customRules: [], includeCiChecks: true,
      enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: true };
  }
  function currentPull() {
    return { id: 5, number: 1, title: "fixture PR", body: "fixture body", user: { login: "author" },
      state: "open" as const, merged: false, base: { ref: "main", sha: "a".repeat(40),
        repo: { id: repositoryId, owner: { id: accountId } } },
      head: { ref: "feature", sha: "b".repeat(40) }, additions: 1, deletions: 0, changed_files: 1,
      html_url: "https://github.com/example/project/pull/1" };
  }
  function policy() { return { enabled: true, mode: "comment" as const, customRules: [], includeCiChecks: true,
    secretScanEnabled: true, secretScanCustomPatterns: [], autoLabelEnabled: true }; }
  function lifecyclePayload(action: string) { return { action,
    installation: { id: installationId, app_id: appId, account: { id: accountId } } }; }
  function pullRequestPayload(action: string) { return { action, installation: { id: installationId, app_id: appId },
    repository: { id: repositoryId, name: "project", owner: { id: accountId, login: "example" },
      default_branch: "main" }, pull_request: { number: 1, title: "fixture PR", body: "fixture body",
      html_url: "https://github.com/example/project/pull/1", merged: false,
      base: { ref: "main" }, head: { ref: "feature", sha: "b".repeat(40) } } }; }
  function sourceHash(payload: unknown) {
    return createHash("sha256").update(canonicalizeWebhookPayload(payload)).digest("hex");
  }

  function snapshot(): Extract<GitHubInstallationSnapshot, { status: "active" }> {
    const app = { id: appId, slug: "review-app", name: "Review App" };
    const installation = { id: installationId, appId, account: { id: accountId, login: "Example" },
      permissions: {}, status: "active" as const, accessEligible: true as const };
    return { complete: true, status: "active", app, installation, account: installation.account,
      bot: { id: 81, login: "review-app[bot]" }, completedAt: new Date().toISOString(), repositories: [{
        fullName: "Example/project", account: "Example", suspended: false, identity: {
          origin: "https://api.github.com", repository: "example/project", appId, installationId,
          accountId, repositoryId, actorId: 81,
        },
      }] };
  }
  async function runCounts(deliveryId: string) {
    const result = await owner.query<{ runs: number; jobs: number; budgets: number }>(`SELECT
      count(DISTINCT r.id)::int AS runs,count(DISTINCT j.id)::int AS jobs,
      count(DISTINCT b.run_id)::int AS budgets FROM pr_agent_harness.agent_runs r
      LEFT JOIN pr_agent_harness.job_queue j ON j.run_id=r.id AND j.tenant_id=r.tenant_id
      LEFT JOIN pr_agent_harness.run_budget_envelopes b ON b.run_id=r.id AND b.tenant_id=r.tenant_id
      WHERE r.source_key=$1`, [`github:delivery:${deliveryId}`]);
    return result.rows[0]!;
  }
  function setEnv(name: string, value: string | undefined) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function pricing(): string {
  return JSON.stringify({ version: "install-and-use-v1", currency: "USD", periodKey: "install-and-use",
    tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
    runLimits: { inputTokens: 10_000, outputTokens: 10_000, costMicros: 0 },
    models: { "openai-compatible:fixture-model": { rates: { inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 }, maxOutputTokens: 1_000,
    maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens" } } });
}
