import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeLabelSet, findingMatchKey, labelSetHash } from "../src/evolution/feedback/contracts.js";

test("label sets canonicalize order while scoring ignores presentation title", () => {
  const first = { path: "src/b.ts", startLine: 9, endLine: 9, severity: "high" as const, title: " B " };
  const second = { path: "src/a.ts", startLine: 3, endLine: 4, severity: "medium" as const, title: "A" };
  const left = canonicalizeLabelSet({ schemaVersion: 1, rubricVersion: "review-quality.v1",
    completeness: "complete", expectedFindings: [first, second] });
  const right = canonicalizeLabelSet({ schemaVersion: 1, rubricVersion: "review-quality.v1",
    completeness: "complete", expectedFindings: [second, first] });
  assert.deepEqual(left, right); assert.equal(labelSetHash(left), labelSetHash(right));
  assert.equal(findingMatchKey(first), findingMatchKey({ ...first, title: "different" }));
});

test("label sets reject unsafe, oversized and duplicate locations", () => {
  assert.throws(() => canonicalizeLabelSet({ schemaVersion: 1, rubricVersion: "review-quality.v1",
    completeness: "complete", expectedFindings: [{ path: ".env.production", startLine: 1, endLine: 1,
      severity: "low", title: "secret" }] }));
  const duplicate = { path: "src/a.ts", startLine: 3, endLine: 3, severity: "high", title: "same" };
  assert.throws(() => canonicalizeLabelSet({ schemaVersion: 1, rubricVersion: "review-quality.v1",
    completeness: "complete", expectedFindings: [duplicate, { ...duplicate, title: "other" }] }));
});
