import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAddDocCommand,
  parseImproveCommand,
  parseMentionCommand,
  parseReflectCommand,
  parseSimilarIssueCommand,
} from "@mr-agent/review/report-renderer.ts";

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

test("parseReflectCommand supports optional request", () => {
  const plain = parseReflectCommand("/reflect");
  assert.equal(plain.matched, true);
  assert.equal(plain.request, "");

  const withRequest = parseReflectCommand("/reflect clarify rollback behavior");
  assert.equal(withRequest.matched, true);
  assert.equal(withRequest.request, "clarify rollback behavior");
});

test("parseSimilarIssueCommand supports aliases and query", () => {
  const one = parseSimilarIssueCommand("/similar_issue timeout race condition");
  assert.equal(one.matched, true);
  assert.equal(one.query, "timeout race condition");

  const two = parseSimilarIssueCommand("/ai-review similar-issue oauth callback");
  assert.equal(two.matched, true);
  assert.equal(two.query, "oauth callback");
});

test("parseMentionCommand accepts both bot login with and without [bot]", () => {
  const withSuffix = parseMentionCommand("@condev-code-agent[bot] give suggestions", "condev-code-agent");
  assert.equal(withSuffix.matched, true);
  assert.equal(withSuffix.question, "give suggestions");

  const withoutSuffix = parseMentionCommand("@condev-code-agent give suggestions", "condev-code-agent[bot]");
  assert.equal(withoutSuffix.matched, true);
  assert.equal(withoutSuffix.question, "give suggestions");
});
