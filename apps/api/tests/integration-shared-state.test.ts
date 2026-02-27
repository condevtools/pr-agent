import assert from "node:assert/strict";
import test from "node:test";

import {
  readMergedFeedbackSignals,
  rememberIncrementalReviewHead,
  loadIncrementalReviewHead,
} from "@mr-agent/shared/review-state.ts";
import { recordFeedbackSignal } from "@mr-agent/shared/feedback-signals.ts";

test("shared review-state merges scoped and repository-level feedback signals", () => {
  const scope = `feedback-scope-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const repoKey = "owner/repo";
  const prKey = `${repoKey}#42`;

  recordFeedbackSignal({
    scope,
    key: repoKey,
    signal: "Prefer smaller commits",
    ttlMs: 60_000,
    maxSignals: 80,
    maxEntries: 200,
  });
  recordFeedbackSignal({
    scope,
    key: prKey,
    signal: "Focus on null checks",
    ttlMs: 60_000,
    maxSignals: 80,
    maxEntries: 200,
  });
  recordFeedbackSignal({
    scope,
    key: prKey,
    signal: "Prefer smaller commits",
    ttlMs: 60_000,
    maxSignals: 80,
    maxEntries: 200,
  });

  const merged = readMergedFeedbackSignals({
    scope,
    scopedKey: prKey,
    fallbackKey: repoKey,
    maxSignals: 80,
  });
  assert.deepEqual(merged, ["Prefer smaller commits", "Focus on null checks"]);
});

test("shared review-state keeps incremental review head in runtime state", () => {
  const scope = `incremental-scope-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const key = "owner/repo#88";

  assert.equal(loadIncrementalReviewHead({ scope, key }), undefined);
  rememberIncrementalReviewHead({
    scope,
    key,
    headSha: "abc123",
    ttlMs: 60_000,
    maxEntries: 100,
  });
  assert.equal(loadIncrementalReviewHead({ scope, key }), "abc123");
});
