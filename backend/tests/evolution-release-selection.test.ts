import assert from "node:assert/strict";
import test from "node:test";

import { releaseBucket } from "../src/evolution/releases/selection.js";

const base = { tenantId: "00000000-0000-4000-8000-000000000001",
  integrationId: "00000000-0000-4000-8000-000000000002", headSha: "head",
  assignmentVersion: 7, routingSalt: "frozen-salt" };

test("release bucket is deterministic, bounded and changes with immutable assignment identity", () => {
  const first = releaseBucket({ ...base, sourceKey: "delivery-1" });
  assert.equal(first, releaseBucket({ ...base, sourceKey: "delivery-1" }));
  assert.ok(first >= 0 && first < 10_000);
  assert.notEqual(first, releaseBucket({ ...base, sourceKey: "delivery-1", assignmentVersion: 8 }));
});

test("five-percent canary boundary uses integer buckets without rounding", () => {
  let selected: number | undefined; let control: number | undefined;
  for (let index = 0; index < 100_000 && (selected === undefined || control === undefined); index += 1) {
    const bucket = releaseBucket({ ...base, sourceKey: `delivery-${index}` });
    if (bucket < 500) selected ??= bucket;
    else control ??= bucket;
  }
  assert.ok(selected !== undefined && selected < 500);
  assert.ok(control !== undefined && control >= 500);
});
