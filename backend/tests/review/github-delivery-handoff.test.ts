import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubDeliveryHandoffError,
  createOrReuseGitHubDeliveryRun,
  type GitHubDeliveryIdentity,
} from "../../src/review/intake/github-delivery-handoff.js";

const identity: GitHubDeliveryIdentity = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  bindingId: "00000000-0000-4000-8000-000000000002",
  sourceKey: "github:delivery:delivery-1",
  sourceHash: "a".repeat(64),
};

test("matching deferred delivery locks lease before source identity and skips lazy creation", async () => {
  const calls: string[] = [];
  const client = { async query(sql: string) {
    if (sql.includes("lock_for_handoff")) {
      calls.push("deferred-lock"); return { rows: [{ deferred_id: "deferred-id" }] };
    }
    if (sql.includes("delivery_handoff_lock")) {
      calls.push("source-lock"); return { rows: [{ status: "matching", run_id: "run-id" }] };
    }
    if (sql.includes("finish_handoff")) {
      calls.push("finish"); return { rows: [{ completed: true }] };
    }
    throw new Error(`Unexpected query ${sql}`);
  } };
  let built = false;
  const result = await createOrReuseGitHubDeliveryRun(client as never, identity, async () => {
    built = true; throw new Error("matching delivery must not build current policy input");
  }, { ownerId: "deferred-owner", leaseEpoch: 4 });
  assert.deepEqual(result, { id: "run-id", created: false });
  assert.equal(built, false);
  assert.deepEqual(calls, ["deferred-lock", "source-lock", "finish"]);
});

for (const [status, code] of [
  ["conflict", "source_identity_conflict"],
  ["legacy_hash_unavailable", "legacy_source_hash_unavailable"],
] as const) {
  test(`${status} delivery lookup fails closed before lazy creation`, async () => {
    const client = { query: async () => ({ rows: [{ status, run_id: null }] }) };
    let built = false;
    await assert.rejects(createOrReuseGitHubDeliveryRun(client as never, identity, async () => {
      built = true; throw new Error("must not build");
    }), (error: unknown) => error instanceof GitHubDeliveryHandoffError && error.code === code);
    assert.equal(built, false);
  });
}

test("stale deferred lease fails before acquiring the source lock", async () => {
  let calls = 0;
  const client = { query: async () => { calls += 1; return { rows: [{ deferred_id: null }] }; } };
  await assert.rejects(createOrReuseGitHubDeliveryRun(client as never, identity, async () => {
    throw new Error("must not build");
  }, { ownerId: "stale", leaseEpoch: 1 }),
  (error: unknown) => error instanceof GitHubDeliveryHandoffError && error.code === "deferred_claim_stale");
  assert.equal(calls, 1);
});
