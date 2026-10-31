import assert from "node:assert/strict";
import test from "node:test";
import { BadWebhookRequestError } from "../../../src/core/index.js";
import { deferGitHubPullRequest, processDeferredGitHubPullRequest,
  type DeferredGitHubDependencies } from "../../../src/integrations/github/onboarding/deferred-pull-request.js";
import type { DeferredPullRequestClaim, GitHubInstallationSyncStore } from "../../../src/agent-runtime/authority/github-installation-sync.js";
import type { PublicationBinding } from "../../../src/agent-runtime/authority/publication-authority.js";
import { GitHubDeliveryHandoffError } from "../../../src/review/intake/github-delivery-handoff.js";
import { renderPrometheusMetrics } from "../../../src/http/system/metrics-runtime.js";

const env = { APP_ID: "71", PRIVATE_KEY: "fixture-key", WEBHOOK_SECRET: "fixture-secret" };
const payload = { action: "opened", installation: { id: 81 },
  repository: { id: 91, name: "Repo", owner: { id: 101, login: "Owner" } },
  pull_request: { number: 3, body: "must not persist raw body", title: "untrusted title" } };

test("eligible App PR waits for durable minimal admission before acknowledgement", async () => {
  let release!: () => void;
  const durable = new Promise<void>((resolve) => { release = resolve; });
  const rows: unknown[] = [];
  let acknowledged = false;
  const pending = deferGitHubPullRequest({ eventName: "pull_request", runtimeMode: "github-app", payload,
    deliveryId: "delivery-first", sourceHash: "a".repeat(64), env }, async () => ({ defer: async (input) => {
    rows.push(input); await durable; return { outcome: "admitted", accepted: true, id: "stored" };
  } })).then((result) => { acknowledged = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);
  assert.deepEqual(rows, [{ appId: 71, installationId: 81, accountId: 101, repositoryId: 91,
    repository: "owner/repo", pullNumber: 3, action: "opened", deliveryId: "delivery-first", sourceHash: "a".repeat(64) }]);
  release();
  assert.match((await pending)?.message ?? "", /queued pending/u);
});

test("plain/PAT, non-PR and disabled automation never stage a deferred delivery", async () => {
  const getStore = async (): Promise<never> => { throw new Error("must not open onboarding pool"); };
  for (const overrides of [{ runtimeMode: "github-webhook" as const }, { eventName: "issue_comment" },
    { env: { ...env, FEATURE_GITHUB_ONBOARDING: "off" } }, { env: {} }]) {
    assert.equal(await deferGitHubPullRequest({ eventName: "pull_request", runtimeMode: "github-app",
      payload, deliveryId: "delivery", sourceHash: "a".repeat(64), env, ...overrides }, getStore), undefined);
  }
});

test("bad App/source identities fail closed and database commit failures are retriable", async () => {
  const getStore = async (): Promise<never> => { throw new Error("database unavailable"); };
  const input = { eventName: "pull_request", runtimeMode: "github-app" as const, payload,
    deliveryId: "delivery", sourceHash: "a".repeat(64), env };
  await assert.rejects(deferGitHubPullRequest({ ...input, sourceHash: "invalid" }, getStore), BadWebhookRequestError);
  await assert.rejects(deferGitHubPullRequest({ ...input,
    payload: { ...payload, installation: { id: 81, app_id: 72 } } }, getStore), BadWebhookRequestError);
  await assert.rejects(deferGitHubPullRequest(input, getStore), /database unavailable/u);
});

test("operator suppression is acknowledged without claiming the PR was queued", async () => {
  const result = await deferGitHubPullRequest({ eventName: "pull_request", runtimeMode: "github-app", payload,
    deliveryId: "delivery", sourceHash: "a".repeat(64), env }, async () => ({
    defer: async () => ({ outcome: "suppressed", accepted: false }),
  }));
  assert.match(result?.message ?? "", /disabled by operator/u);
});

test("pre-binding delivery conflicts emit stable redacted integrity evidence", async () => {
  const errors: string[] = [];
  const previous = console.error;
  console.error = (value: unknown) => { errors.push(String(value)); };
  try {
    await assert.rejects(deferGitHubPullRequest({ eventName: "pull_request", runtimeMode: "github-app", payload,
      deliveryId: "delivery-conflict", sourceHash: "a".repeat(64), env }, async () => ({
      defer: async () => { throw Object.assign(new Error("sensitive SQL detail"), { code: "23505" }); },
    })), BadWebhookRequestError);
  } finally { console.error = previous; }
  assert.match(errors.join("\n"), /GITHUB_DEFERRED_IDENTITY_CONFLICT/u);
  assert.doesNotMatch(errors.join("\n"), /sensitive SQL|untrusted title|must not persist raw body/u);
  assert.match(renderPrometheusMetrics(), /pr_agent_github_deferred_admissions_total\{outcome="conflict"\} 1/u);
});

test("deferred processing rechecks current policy/PR and passes stable source plus leased atomic handoff", async () => {
  const f = fixture();
  await processDeferredGitHubPullRequest(claim(), new AbortController().signal, f.store, f.dependencies);
  assert.deepEqual(f.outcomes, []);
  assert.equal(f.enqueued.length, 1);
  const [params, binding, deferred] = f.enqueued[0]!;
  assert.equal(params.sourceKey, "github:delivery:delivery-first");
  assert.equal(params.sourceHash, "a".repeat(64));
  assert.equal(binding.repository, "owner/renamed");
  assert.deepEqual(deferred?.handoff, { ownerId: "drainer-1", leaseEpoch: 2 });
  assert.equal(deferred?.pull.title, "fresh provider title");
  assert.deepEqual(f.policyReads, ["opened:main"]);
});

test("missing/restricted bindings wait; operator stops and immutable identity mismatches never enqueue", async () => {
  for (const [kind, expected] of [["missing", "retry"], ["revoked", "retry"], ["inactive", "skipped"],
    ["blocked", "skipped"], ["draining", "skipped"], ["wrong-installation", "conflict"]] as const) {
    const f = fixture();
    f.dependencies.findBinding = async () => kind === "missing" ? undefined : ({
      active: kind !== "inactive", binding: { ...binding(),
        ...(kind === "revoked" ? { providerAccessState: "revoked" as const } : {}),
        ...(kind === "blocked" ? { state: "blocked" as const } : {}),
        ...(kind === "draining" ? { reviewExecutionState: "draining" as const } : {}),
        ...(kind === "wrong-installation" ? { credentialRef: "github-app:82" } : {}),
      },
    });
    await processDeferredGitHubPullRequest(claim(), new AbortController().signal, f.store, f.dependencies);
    assert.equal(f.outcomes[0]?.outcome, expected, kind);
    assert.equal(f.enqueued.length, 0, kind);
  }
});

test("closed PR, changed repository identity or disabled review policy cannot be replayed into a run", async () => {
  for (const kind of ["closed", "identity", "policy"] as const) {
    const f = fixture();
    const load = f.dependencies.loadCurrent;
    f.dependencies.loadCurrent = async (...args) => {
      const result = await load(...args);
      if (kind === "closed") result.pull.state = "closed";
      if (kind === "identity") result.pull.base.repo.owner.id = 999;
      return result;
    };
    if (kind === "policy") f.dependencies.resolvePolicy = async () => ({ ...policy(), enabled: false });
    await processDeferredGitHubPullRequest(claim(), new AbortController().signal, f.store, f.dependencies);
    assert.equal(f.outcomes[0]?.outcome, kind === "identity" ? "conflict" : "skipped");
    assert.equal(f.enqueued.length, 0);
  }
});

test("shutdown during provider lookup cannot enqueue and leaves retry ownership to coordinator", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.dependencies.loadCurrent = async () => { controller.abort(); return new Promise(() => {}); };
  await assert.rejects(processDeferredGitHubPullRequest(claim(), controller.signal, f.store, f.dependencies), { name: "AbortError" });
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.outcomes.length, 0);
});

test("source conflicts are terminal but lease conflicts remain retryable", async () => {
  for (const code of ["source_identity_conflict", "legacy_source_hash_unavailable", "deferred_claim_stale"] as const) {
    const f = fixture();
    f.dependencies.enqueue = async () => { throw new GitHubDeliveryHandoffError(code); };
    const pending = processDeferredGitHubPullRequest(claim(), new AbortController().signal, f.store, f.dependencies);
    if (code === "deferred_claim_stale") {
      await assert.rejects(pending, GitHubDeliveryHandoffError);
      assert.deepEqual(f.outcomes, []);
    } else {
      await pending;
      assert.deepEqual(f.outcomes, [{ outcome: "conflict", errorCode: code }]);
    }
  }
});

function claim(): DeferredPullRequestClaim {
  return { id: "deferred-1", appId: 71, installationId: 81, accountId: 101, repositoryId: 91,
    repository: "owner/repo", pullNumber: 3, action: "opened", deliveryId: "delivery-first",
    sourceHash: "a".repeat(64), ownerId: "drainer-1", leaseEpoch: 2,
    leaseExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 86_400_000) };
}
function binding(): PublicationBinding {
  return { id: "binding-1", tenantId: "tenant-1", platform: "github", origin: "https://api.github.com",
    repository: "owner/renamed", providerRepositoryId: 91, providerActorId: 111,
    credentialRef: "github-app:81", githubAppId: 71, githubAccountId: 101,
    generation: 1, version: 2, state: "active", reviewExecutionMode: "harness_async",
    reviewExecutionState: "active", providerAccessState: "verified",
    capabilities: { reviewSingle: true, reviewDeep: true, fix: false, evolution: false, defaultReviewWorkflow: "review.single.v1" } };
}
function policy() {
  return { enabled: true, mode: "comment" as const, customRules: [], includeCiChecks: true,
    secretScanEnabled: true, secretScanCustomPatterns: [], autoLabelEnabled: true };
}
function fixture() {
  const outcomes: Parameters<GitHubInstallationSyncStore["completeDeferred"]>[1][] = [];
  const enqueued: Parameters<DeferredGitHubDependencies["enqueue"]>[] = [];
  const policyReads: string[] = [];
  const store = { completeDeferred: async (_claim: DeferredPullRequestClaim,
    outcome: Parameters<GitHubInstallationSyncStore["completeDeferred"]>[1]) => { outcomes.push(outcome); return true; } };
  const dependencies: DeferredGitHubDependencies = {
    findBinding: async () => ({ binding: binding(), active: true }),
    loadCurrent: async () => ({ context: { repo: () => ({ owner: "owner", repo: "renamed" }), octokit: {} as never,
      log: { info() {}, error() {} } },
    pull: { id: 5, number: 3, title: "fresh provider title", body: "fresh body", user: { login: "author" },
      state: "open", merged: false, base: { ref: "main", sha: "a".repeat(40), repo: { id: 91, owner: { id: 101 } } },
      head: { ref: "feature", sha: "b".repeat(40) }, additions: 1, deletions: 0, changed_files: 1,
      html_url: "https://github.com/owner/renamed/pull/3" } }),
    resolvePolicy: async (input) => { policyReads.push(`${input.action}:${input.baseRef}`); return policy(); },
    resolveMergedPolicy: async () => ({ ...policy(), improveCommandEnabled: true, addDocCommandEnabled: true }),
    enqueue: async (...args) => { enqueued.push(args); return "run-1"; },
  };
  return { outcomes, enqueued, policyReads, store, dependencies };
}
