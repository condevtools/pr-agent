import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeferredPullRequestClaim,
  SyncClaim,
} from "../../../src/agent-runtime/authority/github-installation-sync.js";
import {
  GitHubInstallationReconciler,
  type GitHubInstallationReconcilerStore,
} from "../../../src/integrations/github/onboarding/reconciler.js";
import type {
  GitHubInstallationDiscovery,
  GitHubInstallationSnapshot,
} from "../../../src/integrations/github/onboarding/provider.js";

const app = { id: 7, slug: "review-app", name: "Review App" };
const activeInstallation = {
  id: 31, appId: 7, account: { id: 501, login: "Example" }, permissions: {},
  status: "active" as const, accessEligible: true as const,
};

test("startup discovery schedules existing and missing installations without treating list failures as empty", async () => {
  const store = new FakeStore();
  store.known = [{ installationId: 31, accountId: 501 }, { installationId: 44, accountId: 777 }];
  const provider = new FakeProvider();
  const reconciler = createReconciler(store, provider);

  await reconciler.discoverNow();
  assert.deepEqual(store.discovered[0]!.installations, [
    { appId: 7, installationId: 31, accountId: 501 },
  ]);
  assert.deepEqual(store.requested.map(({ installationId, accountId, reason }) => ({
    installationId, accountId, reason,
  })), [{
    installationId: 44, accountId: 777,
    reason: "installation absent from complete App discovery; confirm current provider state",
  }]);

  provider.discoveryError = Object.assign(new Error("rate limited"), { status: 429 });
  await assert.rejects(reconciler.discoverNow(), /rate limited/u);
  assert.equal(store.knownReads, 1, "failed discovery must not compare an apparent empty inventory");
  assert.equal(store.requested.length, 1);
});

test("partial provider snapshot failure is failed with backoff and never applied", async () => {
  const store = new FakeStore();
  store.syncClaims.push(syncClaim());
  const provider = new FakeProvider();
  provider.snapshotError = Object.assign(new Error("page two unavailable"), { status: 503 });
  const reconciler = createReconciler(store, provider);

  await reconciler.runOnce();
  assert.equal(store.applied.length, 0);
  assert.equal(store.restricted.length, 0);
  assert.equal(store.failed.length, 1);
  assert.equal(store.failed[0]!.input.errorCode, "github_api_temporary");
  assert.ok(store.failed[0]!.input.retryAt.getTime() > Date.now());
});

test("fresh active snapshot after repository re-add applies canonical store hash and identities", async () => {
  const store = new FakeStore();
  store.syncClaims.push(syncClaim());
  const provider = new FakeProvider();
  provider.snapshot = activeSnapshot();
  const reconciler = createReconciler(store, provider);

  await reconciler.runOnce();
  assert.equal(store.applied.length, 1);
  assert.deepEqual(store.applied[0]!.snapshot, {
    accountId: 501,
    providerActorId: 81,
    completedAt: new Date("2026-10-31T00:00:00.000Z"),
    snapshotHash: "canonical:10000",
    repositories: [{ id: 10_000, fullName: "Example/project" }],
  });
  assert.equal(store.failed.length, 0);
});

test("mapping conflicts are reported as degraded rather than successful synchronization", async () => {
  const store = new FakeStore();
  store.syncClaims.push(syncClaim());
  store.applyCompleteSnapshot = async () => ({ status: "completed", created: 0, restored: 0,
    adopted: 0, conflicted: 1, revoked: 0 });
  const reconciler = createReconciler(store, new FakeProvider());
  await reconciler.runOnce();
  assert.equal(reconciler.readiness().lastErrorCode, "github_mapping_conflict");
  assert.equal(store.failed.length, 0, "committed conflict status must not be overwritten as a transient retry");
});

test("restrictive snapshots complete the current claim without requesting a new epoch", async (context) => {
  for (const [status, state] of [
    ["suspended", "revoked"],
    ["deleted", "revoked"],
    ["permissions_incomplete", "unknown"],
  ] as const) {
    await context.test(status, async () => {
      const store = new FakeStore();
      store.syncClaims.push(syncClaim());
      const provider = new FakeProvider();
      provider.snapshot = restrictiveSnapshot(status);
      await createReconciler(store, provider).runOnce();
      assert.equal(store.requested.length, 0);
      assert.equal(store.restricted.length, 1);
      assert.deepEqual(store.restricted[0]!.snapshot, {
        state, reason: `provider_snapshot_${status}`, completedAt: new Date("2026-10-31T00:00:00.000Z"),
      });
    });
  }
});

test("lease loss aborts a hanging provider fetch without applying or acknowledging a stale claim", async () => {
  const store = new FakeStore();
  store.syncClaims.push(syncClaim());
  store.renewError = new Error("stale lease");
  const provider = new FakeProvider();
  provider.hangSnapshot = true;
  const reconciler = createReconciler(store, provider, { renewIntervalMs: 2 });

  await reconciler.runOnce();
  assert.equal(store.renewals, 1);
  assert.equal(store.applied.length, 0);
  assert.equal(store.failed.length, 0, "a lost lease must not acknowledge another owner's claim");
});

test("stop aborts in-flight work, deferred failures retry, and cleanup remains available when automation is off", async () => {
  const store = new FakeStore();
  store.syncClaims.push(syncClaim());
  const provider = new FakeProvider();
  provider.hangSnapshot = true;
  const reconciler = createReconciler(store, provider, { pollIntervalMs: 2 });
  reconciler.start();
  await eventually(() => provider.snapshotCalls === 1);
  await reconciler.stop();
  assert.equal(reconciler.readiness().running, false);
  assert.equal(store.applied.length, 0);
  assert.equal(store.failed[0]?.input.errorCode, "coordinator_stopped");

  const deferredStore = new FakeStore();
  deferredStore.deferredClaims.push(deferredClaim());
  const deferred = createReconciler(deferredStore, new FakeProvider(), {}, async () => {
    throw new Error("handoff temporarily unavailable");
  });
  await deferred.runOnce();
  assert.equal(deferredStore.deferredCompletions[0]!.input.outcome, "retry");

  const cleanupStore = new FakeStore();
  const cleanupOnly = createReconciler(cleanupStore, new FakeProvider(), { automationEnabled: false });
  await cleanupOnly.cleanupNow();
  assert.equal(cleanupStore.cleanupCalls, 1);

  const idle = createReconciler(new FakeStore(), new FakeProvider(), { pollIntervalMs: 100 });
  idle.start();
  await eventually(() => idle.readiness().lastDiscoveryCompletedAt !== undefined);
  await assert.doesNotReject(idle.stop(), "idle polling sleep should stop cleanly");
});

function createReconciler(
  store: FakeStore,
  provider: FakeProvider,
  options: Partial<ConstructorParameters<typeof GitHubInstallationReconciler>[0]> = {},
  processDeferred: (claim: DeferredPullRequestClaim, signal: AbortSignal) => Promise<void> = async () => undefined,
) {
  return new GitHubInstallationReconciler({
    store,
    provider,
    origin: "https://api.github.com",
    appId: 7,
    ownerId: "test-owner",
    processDeferred,
    repositoryIdsHash: (ids) => `canonical:${ids.join(",")}`,
    pollIntervalMs: 10,
    discoveryIntervalMs: 60_000,
    cleanupIntervalMs: 60_000,
    renewIntervalMs: 20_000,
    retryBaseMs: 1_000,
    ...options,
  });
}

class FakeProvider {
  discovery: GitHubInstallationDiscovery = { app, installations: [activeInstallation] };
  snapshot: GitHubInstallationSnapshot = activeSnapshot();
  discoveryError?: Error;
  snapshotError?: Error;
  hangSnapshot = false;
  snapshotCalls = 0;

  async discoverInstallations(): Promise<GitHubInstallationDiscovery> {
    if (this.discoveryError) throw this.discoveryError;
    return this.discovery;
  }

  async installationSnapshot(_origin: string, _installationId: number, options?: { signal?: AbortSignal }) {
    this.snapshotCalls += 1;
    if (this.snapshotError) throw this.snapshotError;
    if (this.hangSnapshot) {
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    }
    return this.snapshot;
  }
}

class FakeStore implements GitHubInstallationReconcilerStore {
  known: Array<{ installationId: number; accountId?: number }> = [];
  knownReads = 0;
  discovered: Array<{ installations: Array<{ appId: number; installationId: number; accountId: number }>;
    discoveryId: string }> = [];
  requested: Array<Parameters<GitHubInstallationReconcilerStore["requestSync"]>[0]> = [];
  syncClaims: SyncClaim[] = [];
  deferredClaims: DeferredPullRequestClaim[] = [];
  applied: Array<{ claim: SyncClaim; snapshot: Parameters<GitHubInstallationReconcilerStore["applyCompleteSnapshot"]>[1] }> = [];
  restricted: Array<{ claim: SyncClaim;
    snapshot: Parameters<GitHubInstallationReconcilerStore["completeRestrictedSnapshot"]>[1] }> = [];
  failed: Array<{ claim: SyncClaim; input: Parameters<GitHubInstallationReconcilerStore["fail"]>[1] }> = [];
  deferredCompletions: Array<{ claim: DeferredPullRequestClaim;
    input: Parameters<GitHubInstallationReconcilerStore["completeDeferred"]>[1] }> = [];
  renewals = 0;
  renewError?: Error;
  cleanupCalls = 0;

  async discoveryRequests(installations: Array<{ appId: number; installationId: number; accountId: number }>,
    discoveryId: string) {
    this.discovered.push({ installations, discoveryId });
    return { accepted: installations.length, duplicates: 0 };
  }
  async listKnownInstallations() { this.knownReads += 1; return this.known; }
  async requestSync(input: Parameters<GitHubInstallationReconcilerStore["requestSync"]>[0]) {
    this.requested.push(input); return { accepted: true, requestedEpoch: 1 };
  }
  async claim() { return this.syncClaims.shift(); }
  async renew(claim: SyncClaim) {
    this.renewals += 1;
    if (this.renewError) throw this.renewError;
    return claim.leaseExpiresAt;
  }
  async fail(claim: SyncClaim, input: Parameters<GitHubInstallationReconcilerStore["fail"]>[1]) {
    this.failed.push({ claim, input }); return true;
  }
  async applyCompleteSnapshot(claim: SyncClaim,
    snapshot: Parameters<GitHubInstallationReconcilerStore["applyCompleteSnapshot"]>[1]) {
    this.applied.push({ claim, snapshot });
    return { status: "completed" as const, created: 1, restored: 0, adopted: 0, conflicted: 0, revoked: 0 };
  }
  async completeRestrictedSnapshot(claim: SyncClaim,
    snapshot: Parameters<GitHubInstallationReconcilerStore["completeRestrictedSnapshot"]>[1]) {
    this.restricted.push({ claim, snapshot }); return true;
  }
  async claimDeferred() { return this.deferredClaims.shift(); }
  async completeDeferred(claim: DeferredPullRequestClaim,
    input: Parameters<GitHubInstallationReconcilerStore["completeDeferred"]>[1]) {
    this.deferredCompletions.push({ claim, input }); return true;
  }
  async cleanup() { this.cleanupCalls += 1; return { deleted: 0, expired: 0 }; }
}

function syncClaim(): SyncClaim {
  return { appId: 7, installationId: 31, accountId: 501, ownerId: "test-owner",
    claimEpoch: 1, leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000) };
}

function deferredClaim(): DeferredPullRequestClaim {
  return { id: "00000000-0000-4000-8000-000000000001", appId: 7, installationId: 31,
    accountId: 501, repositoryId: 10_000, repository: "example/project", pullNumber: 1,
    action: "opened", deliveryId: "delivery-1", sourceHash: "a".repeat(64), ownerId: "test-owner",
    leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 3600_000) };
}

function activeSnapshot(): Extract<GitHubInstallationSnapshot, { status: "active" }> {
  return {
    complete: true, status: "active", app, installation: activeInstallation,
    account: activeInstallation.account, bot: { id: 81, login: "review-app[bot]" },
    completedAt: "2026-10-31T00:00:00.000Z",
    repositories: [{ fullName: "Example/project", account: "Example", suspended: false,
      identity: { origin: "https://api.github.com", repository: "example/project", appId: 7,
        installationId: 31, accountId: 501, repositoryId: 10_000, actorId: 81 } }],
  };
}

function restrictiveSnapshot(
  status: "suspended" | "deleted" | "permissions_incomplete",
): Exclude<GitHubInstallationSnapshot, { status: "active" }> {
  if (status === "deleted") {
    return { complete: true, status, app, installation: { id: 31, status }, account: null, bot: null,
      repositories: [], completedAt: "2026-10-31T00:00:00.000Z" };
  }
  const installation = {
    id: 31, appId: 7, account: { id: 501, login: "Example" }, permissions: {}, status,
    accessEligible: false as const, restrictionReason: status,
  };
  return { complete: true, status, app, installation, account: installation.account, bot: null,
    repositories: [], completedAt: "2026-10-31T00:00:00.000Z" };
}

async function eventually(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!assertion()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
