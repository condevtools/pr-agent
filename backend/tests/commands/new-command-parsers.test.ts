import assert from "node:assert/strict";
import test from "node:test";

import { parseAddDocCommand, parseImproveCommand } from "../../src/commands/parsers/index.js";

test("parseImproveCommand supports optional focus", () => {
  const plain = parseImproveCommand("/improve");
  assert.equal(plain.matched, true);
  assert.equal(plain.focus, "");

  const withFocus = parseImproveCommand("/improve auth token refresh");
  assert.equal(withFocus.matched, true);
  assert.equal(withFocus.focus, "auth token refresh");
});

test("parseAddDocCommand supports aliases", () => {
  const one = parseAddDocCommand("/add_doc payment flow");
  assert.equal(one.matched, true);
  assert.equal(one.focus, "payment flow");

  const two = parseAddDocCommand("/ai-review add-doc cache keys");
  assert.equal(two.matched, true);
  assert.equal(two.focus, "cache keys");
});
