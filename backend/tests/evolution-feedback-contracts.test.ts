import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeLabelSet,
  findingMatchKey,
  labelSetHash,
  trustedLabelSetSchema,
} from "../src/evolution/feedback-contracts.js";

const first = { path: "src/a.ts", startLine: 8, endLine: 8, severity: "high" as const, title: "  Unsafe input  " };
const second = { path: "src/b.ts", startLine: 2, endLine: 4, severity: "medium" as const, title: "Missing guard" };

test("canonical label hashes are independent of finding input order and presentation whitespace", () => {
  const left = { schemaVersion: 1 as const, rubricVersion: "review-quality.v1" as const,
    completeness: "complete" as const, expectedFindings: [second, first] };
  const right = { ...left, expectedFindings: [{ ...first, title: "Unsafe input" }, second] };

  assert.equal(labelSetHash(left), labelSetHash(right));
  assert.deepEqual(canonicalizeLabelSet(left).expectedFindings.map(({ path }) => path), ["src/a.ts", "src/b.ts"]);
});

test("label sets reject duplicate scoring identities even when titles differ", () => {
  assert.throws(() => canonicalizeLabelSet({
    schemaVersion: 1, rubricVersion: "review-quality.v1", completeness: "complete",
    expectedFindings: [first, { ...first, title: "Different prose" }],
  }), /duplicate finding locations/);
});

test("finding matching identity ignores presentation-only title text", () => {
  assert.equal(findingMatchKey(first), findingMatchKey({ ...first, title: "Reworded finding" }));
});

test("trusted labels reject unsafe paths and excessively broad locations", () => {
  const result = trustedLabelSetSchema.safeParse({
    schemaVersion: 1, rubricVersion: "review-quality.v1", completeness: "complete",
    expectedFindings: [{ path: "../secret", startLine: 1, endLine: 103, severity: "high", title: "Leak" }],
  });

  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(new Set(result.error.issues.map(({ message }) => message)),
    new Set(["finding location must be ordered and span at most 101 lines", "finding path is unsafe"]));
});
