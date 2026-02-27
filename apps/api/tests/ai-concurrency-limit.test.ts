import assert from "node:assert/strict";
import test from "node:test";

import {
  createAiConcurrencyLimiter,
} from "@mr-agent/review/ai-concurrency.ts";

test("ai concurrency limiter respects AI_MAX_CONCURRENCY", async () => {
  const originalLimit = process.env.AI_MAX_CONCURRENCY;
  process.env.AI_MAX_CONCURRENCY = "1";
  const limiter = createAiConcurrencyLimiter();

  let active = 0;
  let maxActive = 0;
  const runTask = async (label: string) =>
    limiter.withLimit(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return label;
    });

  try {
    const results = await Promise.all([runTask("a"), runTask("b"), runTask("c")]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.equal(maxActive, 1);
  } finally {
    process.env.AI_MAX_CONCURRENCY = originalLimit;
  }
});

test("ai concurrency limiter rejects when wait queue is full", async () => {
  const originalLimit = process.env.AI_MAX_CONCURRENCY;
  const originalQueue = process.env.AI_MAX_QUEUE_SIZE;
  process.env.AI_MAX_CONCURRENCY = "1";
  process.env.AI_MAX_QUEUE_SIZE = "1";
  const limiter = createAiConcurrencyLimiter();

  let releaseFirst: (() => void) | undefined;
  const first = limiter.withLimit(
    () =>
      new Promise<string>((resolve) => {
        releaseFirst = () => resolve("first");
      }),
  );
  const second = limiter.withLimit(async () => "second");

  try {
    await assert.rejects(
      () => limiter.withLimit(async () => "third"),
      /queue is full/i,
    );
  } finally {
    releaseFirst?.();
    await Promise.all([first, second]);
    process.env.AI_MAX_CONCURRENCY = originalLimit;
    process.env.AI_MAX_QUEUE_SIZE = originalQueue;
  }
});
