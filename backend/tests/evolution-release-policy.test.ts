import assert from "node:assert/strict";
import test from "node:test";

import { computeCanaryMetrics, canPromoteCanary, type CanaryObservation } from "../src/evolution/releases/canary-metrics.js";
import { requestReleaseSchema } from "../src/evolution/releases/contracts.js";
import { evolutionReleasePolicy, evolutionReleasePolicyHash } from "../src/evolution/releases/policy.js";
import { releaseBucket } from "../src/evolution/releases/selection.js";
import { fingerprint } from "../src/agent-runtime/versions.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const qualificationId = "22222222-2222-4222-8222-222222222222";

test("release activation is disabled unless the server configuration is exactly true", () => {
  assert.equal(evolutionReleasePolicy({}).activationEnabled, false);
  assert.equal(evolutionReleasePolicy({ EVOLUTION_RELEASE_ACTIVATION_ENABLED: "TRUE" }).activationEnabled, false);
  assert.equal(evolutionReleasePolicy({ EVOLUTION_RELEASE_ACTIVATION_ENABLED: "true" }).activationEnabled, true);
});

test("release policy hash includes the activation posture", () => {
  const disabled = evolutionReleasePolicy({});
  const enabled = evolutionReleasePolicy({ EVOLUTION_RELEASE_ACTIVATION_ENABLED: "true" });
  assert.notEqual(evolutionReleasePolicyHash(disabled), evolutionReleasePolicyHash(enabled));
});

test("release requests reject caller supplied tenant and integration scope", () => {
  assert.throws(() => requestReleaseSchema.parse({ target: "canary", candidateId, qualificationId,
    expectedVersion: 0, candidateBps: 500, commandKey: "strict-scope", tenantId: candidateId,
    integrationId: qualificationId }));
});

test("canary requests accept 5 percent and reject the next basis point", () => {
  assert.equal(requestReleaseSchema.parse({ target: "canary", candidateId, qualificationId,
    expectedVersion: 0, candidateBps: 500, commandKey: "five-percent" }).candidateBps, 500);
  assert.throws(() => requestReleaseSchema.parse({ target: "canary", candidateId, qualificationId,
    expectedVersion: 0, candidateBps: 501, commandKey: "too-wide" }));
});

test("five percent routing has a deterministic 499 included and 500 excluded boundary", () => {
  const common = { tenantId: candidateId, integrationId: qualificationId, headSha: "a".repeat(40),
    assignmentVersion: 7, routingSalt: "fixed-canary-salt" };
  const keys = new Map<number, string>();
  for (let ordinal = 0; ordinal < 100_000 && (!keys.has(499) || !keys.has(500)); ordinal += 1) {
    const sourceKey = `boundary-${ordinal}`;
    const bucket = releaseBucket({ ...common, sourceKey });
    if (bucket === 499 || bucket === 500) keys.set(bucket, sourceKey);
  }
  assert.ok(keys.has(499) && keys.has(500), "fixture search must find both exact deterministic boundaries");
  assert.ok(releaseBucket({ ...common, sourceKey: keys.get(499)! }) < 500);
  assert.ok(releaseBucket({ ...common, sourceKey: keys.get(500)! }) >= 500);
});

test("canary promotion rejects 99 candidate selections", () => {
  const metrics = computeCanaryMetrics([...observations("candidate", 99), ...observations("control", 100)]);
  assert.equal(canPromoteCanary(metrics), false);
});

test("canary promotion accepts exactly 100 comparable selections per arm", () => {
  const metrics = computeCanaryMetrics([...observations("candidate", 100), ...observations("control", 100)]);
  assert.equal(canPromoteCanary(metrics), true);
  const { metricsHash: _hash, ...content } = metrics;
  assert.equal(metrics.metricsHash, fingerprint(content));
});

test("canary promotion rejects operational, incomplete, cost, latency, and unknown-publication regressions", () => {
  const regressions: Array<(candidate: CanaryObservation[]) => void> = [
    (candidate) => { candidate[0] = { ...candidate[0]!, status: "failed" }; },
    (candidate) => { candidate[0] = { ...candidate[0]!, analysisStatus: "partial" }; },
    (candidate) => { for (let index = 0; index < 51; index += 1) candidate[index]!.costMicros = 101; },
    (candidate) => { for (let index = 0; index < 6; index += 1) candidate[index]!.latencyMs = 101; },
    (candidate) => { candidate[0] = { ...candidate[0]!, publicationUnknown: true }; },
  ];
  for (const applyRegression of regressions) {
    const candidate = observations("candidate", 100); applyRegression(candidate);
    assert.equal(canPromoteCanary(computeCanaryMetrics([...candidate, ...observations("control", 100)])), false);
  }
});

function observations(selection: "candidate" | "control", count: number): CanaryObservation[] {
  return Array.from({ length: count }, () => ({ selection, status: "succeeded" as const,
    analysisStatus: "complete" as const, costMicros: 100, latencyMs: 100 }));
}
