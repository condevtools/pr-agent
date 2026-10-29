import assert from "node:assert/strict";
import test from "node:test";
import { addedLineNumbers } from "../src/review/deep/run.js";
import { freezeDeepBudget, deepRolePrefix } from "../src/review/deep/budget.js";
import { createReviewRequestSchema, reviewApiSourceHash } from "../src/http/runs/input.js";
import { fingerprint } from "../src/agent-runtime/versions.js";

test("new workflow selector preserves legacy single review API request identity", () => {
  const single = createReviewRequestSchema.parse({ number: 42 });
  const { workflow: _workflow, ...original } = single;
  assert.equal(reviewApiSourceHash(single), fingerprint(original));
  assert.equal(reviewApiSourceHash(createReviewRequestSchema.parse({ number: 42, workflow: "review.single.v1" })), fingerprint(original));
  assert.notEqual(reviewApiSourceHash({ ...single, workflow: "review.deep.v1" }), fingerprint(original));
  assert.throws(() => createReviewRequestSchema.parse({ number: 42, workflow: "arbitrary-agent" }));
});

test("deep evidence location gate receives added lines rather than diff context", () => {
  assert.deepEqual(addedLineNumbers("@@ -3,3 +3,4 @@\n context\n-removed\n+added\n+second\n context\n@@ -20 +21 @@\n-old\n+new"), [4, 5, 21]);
  assert.deepEqual(addedLineNumbers("+++ b/a.ts\n(binary / patch omitted)"), []);
});

test("fixed role shares cannot spend critic capacity or exceed the Run envelope", () => {
  const total = { inputTokens: 101, outputTokens: 199, costMicros: 211 };
  const budget = freezeDeepBudget(total);
  for (const key of ["inputTokens", "outputTokens", "costMicros"] as const) {
    assert.ok(budget.security[key] + budget.correctness[key] + budget.critic[key] <= total[key]);
  }
  assert.equal(deepRolePrefix("deep.role.security.turn.1"), "security");
  assert.equal(deepRolePrefix("deep.critic"), "critic");
  assert.throws(() => deepRolePrefix("untrusted.model"));
});
