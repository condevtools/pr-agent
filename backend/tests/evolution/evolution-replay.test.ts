import assert from "node:assert/strict";
import test from "node:test";

import type { DeepReviewArtifact, FindingCandidate } from "../../src/review/deep/contracts.js";
import type { DatasetFixtureV1 } from "../../src/evolution/datasets/contracts.js";
import { ReplayFixtureAdapter } from "../../src/evolution/evaluations/fixture-adapter.js";
import { replayRunInputSchema } from "../../src/evolution/evaluations/contracts.js";
import { scoreReplayArtifact } from "../../src/evolution/evaluations/scorer.js";

test("replay input rejects caller URLs, provider seeds and arbitrary fields", () => {
  const base = { schemaVersion: 1, workflow: "eval.replay.v1", evaluationId: id(1), resultId: id(2),
    datasetId: id(3), caseId: id(4), candidateId: id(5), variant: "baseline", repetition: 1,
    samplingMode: "unseeded", attemptIdentityHash: hash("a"), fixtureHash: hash("b"),
    labelSetId: id(6), labelSetHash: hash("c"), componentHash: hash("d"), verifierHash: hash("e") };
  assert.equal(replayRunInputSchema.parse(base).samplingMode, "unseeded");
  assert.throws(() => replayRunInputSchema.parse({ ...base, repositoryUrl: "https://example.test", seed: 7 }));
});

test("fixture adapter returns only frozen files and CI without a network capability", async () => {
  const fixture = { files: [{ path: "src/a.ts", kind: "source", content: "export const a = 1;",
    contentHash: hash("e"), sizeBytes: 19 }], ci: { value: [{ name: "test", status: "completed" }] } } as DatasetFixtureV1;
  const adapter = new ReplayFixtureAdapter(fixture);
  assert.equal(Buffer.from((await adapter.readFile("src/a.ts"))!.bytes).toString(), "export const a = 1;");
  assert.equal(await adapter.readFile("src/missing.ts"), undefined);
  assert.deepEqual(await adapter.readCiStatus(), [{ name: "test", status: "completed" }]);
});

test("scorer includes every accepted finding and flags high-severity false positives", () => {
  const expected = finding("expected", "src/a.ts", 2, "high");
  const falsePositive = finding("false", "src/b.ts", 3, "high");
  const artifact = { analysisStatus: "complete", candidates: [expected, falsePositive],
    gateDecisions: [{ candidateId: expected.id, accepted: true, reasonCode: "accepted" },
      { candidateId: falsePositive.id, accepted: true, reasonCode: "accepted" }] } as DeepReviewArtifact;
  const score = scoreReplayArtifact(artifact, { completeness: "complete", expectedFindings: [
    { path: "src/a.ts", startLine: 2, endLine: 2, severity: "high" },
  ] });
  assert.deepEqual({ tp: score.truePositive, fp: score.falsePositive, fn: score.falseNegative }, { tp: 1, fp: 1, fn: 0 });
  assert.equal(score.safetyRegression, true);
});

test("scorer treats a missed high-severity finding as a safety regression", () => {
  const artifact = { analysisStatus: "complete", candidates: [], gateDecisions: [] } as unknown as DeepReviewArtifact;
  const score = scoreReplayArtifact(artifact, { completeness: "complete", expectedFindings: [
    { path: "src/auth.ts", startLine: 9, endLine: 9, severity: "high" },
  ] });
  assert.equal(score.highFalseNegatives, 1);
  assert.equal(score.safetyRegression, true);
  assert.equal(score.recall, 0);
});

function finding(seed: string, path: string, line: number, severity: "low" | "medium" | "high"): FindingCandidate {
  return { id: hash(seed), sourceRole: "security", severity, title: seed, body: seed,
    location: { path, side: "new", startLine: line, endLine: line }, evidenceIds: [], crossFileEvidenceIds: [] };
}
function id(value: number): string { return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`; }
function hash(value: string): string { return value.repeat(64).slice(0, 64); }
