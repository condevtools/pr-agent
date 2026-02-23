import assert from "node:assert/strict";
import test from "node:test";

import {
  getFreshCacheValue,
  pruneExpiredCache,
  trimCache,
  type ExpiringCacheEntry,
} from "../src/core/cache.ts";

test("cache prune is throttled and key reads still drop expired entries", () => {
  const cache = new Map<string, ExpiringCacheEntry<string>>([
    ["alive", { value: "ok", expiresAt: 2_000 }],
    ["expired-1", { value: "x", expiresAt: 1_000 }],
  ]);

  pruneExpiredCache(cache, 1_500);
  assert.equal(cache.has("expired-1"), false);
  assert.equal(cache.has("alive"), true);

  cache.set("expired-2", { value: "y", expiresAt: 1_550 });
  pruneExpiredCache(cache, 1_600);

  assert.equal(cache.has("expired-2"), true);
  assert.equal(getFreshCacheValue(cache, "expired-2", 1_600), undefined);
  assert.equal(cache.has("expired-2"), false);
  assert.equal(getFreshCacheValue(cache, "alive", 1_600), "ok");
});

test("trimCache evicts least recently used entries", () => {
  const cache = new Map<string, ExpiringCacheEntry<string>>([
    ["a", { value: "A", expiresAt: 9_999 }],
    ["b", { value: "B", expiresAt: 9_999 }],
    ["c", { value: "C", expiresAt: 9_999 }],
  ]);

  assert.equal(getFreshCacheValue(cache, "a", 1_000), "A");
  trimCache(cache, 2);

  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.has("b"), false);
});
