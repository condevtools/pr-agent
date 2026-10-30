import assert from "node:assert/strict";
import test from "node:test";

import type { VerificationPolicy, VerificationResult } from "../../src/fix/contracts.js";
import type { DockerFixVerifier } from "../../src/fix/verification/docker-verifier.js";
import { VerificationJobLeaseLostError, type PgFixVerifierJobStore,
  type VerificationJobLease } from "../../src/fix/verification/jobs.js";
import { VerifierWorker } from "../../src/fix/verification/worker.js";

const hash = (value: string) => value.repeat(64).slice(0, 64);
const imageDigest = `sha256:${hash("a")}`;
const policy: VerificationPolicy = {
  id: "node", hash: hash("b"), nodeImageDigest: imageDigest, argv: ["node", "--test"],
  dependencyLockPath: "package-lock.json", dependencyLockHash: hash("c"), sandboxHash: hash("d"),
  allowedTestPrefixes: ["test/"], relevanceTokens: [], deadlineMs: 60_000, maxLogBytes: 1000,
  memoryMb: 128, cpuCount: 1, pidsLimit: 32, tmpfsMb: 16,
  publisherPolicyId: "publisher", publisherPolicyHash: hash("e"), publishEnabled: false,
};
const result: VerificationResult = { outcome: "suggestion_only", reasonCodes: ["relevance_not_verified"],
  baselineTarget: "fail", patchedTarget: "pass", baselineRegression: [], patchedRegression: [],
  relevance: "unknown", logRefs: {}, logHashes: {}, imageDigest, policyHash: policy.hash,
  proposalHash: hash("f") };

test("three rolling verifier stops settle Docker cleanup before returning the lease without spending attempts", async () => {
  const state = { leased: false, attempts: 0, relinquished: 0, cleaned: false };
  const errors: unknown[] = [];
  for (const behavior of ["resolve", "reject", "resolve"] as const) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const store = verifierStore({
      claim: async () => { state.leased = true; state.attempts += 1; state.cleaned = false; return lease(state.attempts); },
      relinquish: async () => {
        assert.equal(state.cleaned, true, "lease cannot return while the Docker action may still write");
        assert.equal(state.leased, true); state.leased = false; state.attempts -= 1; state.relinquished += 1;
      },
    });
    const verifier = verifierFixture(async (_proposal, _policy, _resource, signal) => {
      started();
      return new Promise<VerificationResult>((resolve, reject) => signal?.addEventListener("abort", () => {
        state.cleaned = true;
        if (behavior === "resolve") resolve(result);
        else reject(signal.reason);
      }, { once: true }));
    });
    const worker = createWorker(store, verifier, 60_000, (error) => errors.push(error));
    const tick = worker.tick();
    await ready;
    worker.stop();
    assert.equal(state.leased, true, "stop only signals; it does not release an active verifier action");
    await tick;
    assert.equal(state.attempts, 0);
  }
  assert.equal(state.relinquished, 3);
  assert.deepEqual(errors, []);
});

test("an authoritative verifier lease loss aborts cleanup without releasing the replacement lease", async () => {
  let relinquished = 0;
  const store = verifierStore({
    claim: async () => lease(1),
    heartbeat: async (active) => { throw new VerificationJobLeaseLostError(active.id); },
    relinquish: async () => { relinquished += 1; },
  });
  const verifier = verifierFixture(async (_proposal, _policy, _resource, signal) =>
    new Promise<VerificationResult>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const worker = createWorker(store, verifier, 1);
  await worker.tick();
  assert.equal(relinquished, 0);
});

test("stop during claim returns the newly claimed lease without starting a Docker action", async () => {
  let resolveClaim!: (value: VerificationJobLease) => void;
  let verified = false; let relinquished = 0;
  const store = verifierStore({ claim: async () => new Promise<VerificationJobLease>((resolve) => { resolveClaim = resolve; }),
    relinquish: async () => { relinquished += 1; } });
  const verifier = verifierFixture(async () => { verified = true; return result; });
  const worker = createWorker(store, verifier);
  const tick = worker.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  worker.stop();
  resolveClaim(lease(1));
  await tick;
  assert.equal(verified, false);
  assert.equal(relinquished, 1);
});

function createWorker(store: PgFixVerifierJobStore, verifier: DockerFixVerifier, heartbeatMs = 60_000,
  onError?: (error: unknown) => void): VerifierWorker {
  return new VerifierWorker({ store, verifier, policies: new Map([[policy.id, policy]]), owner: "fixture",
    verifierCapabilityHash: hash("9"), heartbeatMs, onError });
}

function verifierStore(overrides: Record<string, (...args: any[]) => Promise<any>>): PgFixVerifierJobStore {
  return {
    databaseNow: async () => new Date(), claim: async () => undefined, heartbeat: async () => undefined,
    complete: async () => undefined, fail: async () => "queued", relinquish: async () => undefined,
    ...overrides,
  } as unknown as PgFixVerifierJobStore;
}

function verifierFixture(
  verify: (...args: any[]) => Promise<VerificationResult>,
): DockerFixVerifier {
  return { verify, sweepExpiredResources: () => ({ removed: [], failures: [] }) } as unknown as DockerFixVerifier;
}

function lease(attempt: number): VerificationJobLease {
  const proposal = { id: hash("1"), tenantId: "00000000-0000-4000-8000-000000000001",
    integrationId: "00000000-0000-4000-8000-000000000002", runId: "00000000-0000-4000-8000-000000000003",
    sourceReviewRunId: "00000000-0000-4000-8000-000000000004", findingId: hash("2"), revision: 1 as const,
    repository: "acme/repo", baseSha: "a", headSha: "b", sourceBundleRef: "bundle", sourceBundleHash: hash("3"),
    codePatch: "code", testPatch: "test", codePatchHash: hash("4"), testPatchHash: hash("5"),
    proposalHash: result.proposalHash, policyId: policy.id, policyHash: policy.hash,
    trustedCommandHash: hash("6"), dependencyLockHash: policy.dependencyLockHash,
    dependencyLockPath: policy.dependencyLockPath, sandboxPolicyHash: policy.sandboxHash, imageDigest,
    publisherPolicyHash: policy.publisherPolicyHash, qualificationStatus: "not_verified" as const };
  return { id: "00000000-0000-4000-8000-000000000005", tenantId: proposal.tenantId,
    integrationId: proposal.integrationId, runId: proposal.runId, proposalId: proposal.id,
    proposalHash: proposal.proposalHash, sourceBundleRef: proposal.sourceBundleRef,
    sourceBundleHash: proposal.sourceBundleHash, policyHash: proposal.policyHash,
    verifierCapabilityHash: hash("9"), verificationInputHash: hash("8"),
    trustedCommandHash: proposal.trustedCommandHash, dependencyLockHash: proposal.dependencyLockHash,
    dependencyLockPath: proposal.dependencyLockPath, sandboxPolicyHash: proposal.sandboxPolicyHash,
    imageDigest, claimedRunEpoch: 1, owner: "fixture", epoch: attempt, attempt,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    proposal };
}
