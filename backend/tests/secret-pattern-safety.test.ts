import assert from "node:assert/strict";
import test from "node:test";

import { compileCustomSecretPatterns } from "../src/core/secret-patterns.ts";

test("custom secret patterns accept wildcard-style matching without runtime regex compilation", () => {
  const compiled = compileCustomSecretPatterns([
    "glpat-*",
    "token-????",
  ]);

  assert.equal(compiled.length, 2);
  assert.equal(compiled[0]?.test("prefix glpat-AbCd1234"), true);
  assert.equal(compiled[0]?.test("prefix nope"), false);
  assert.equal(compiled[1]?.test("token-1a2B"), true);
  assert.equal(compiled[1]?.test("token-123"), false);
});

test("custom secret patterns keep backward-compatible slash form with safe flags only", () => {
  const compiled = compileCustomSecretPatterns([
    "/x-api-key=*/i",
    "/unsafe/m",
  ]);

  assert.equal(compiled.length, 1);
  assert.equal(compiled[0]?.test("X-API-KEY=AbCdEfGh12345678"), true);
});
