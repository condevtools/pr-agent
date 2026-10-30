import assert from "node:assert/strict";
import test from "node:test";

import { parseRepoPolicyConfig } from "../../src/issues/policy/github/config.js";
import { parseGitLabReviewPolicyConfig } from "../../src/review/policy/gitlab.js";

test("GitHub and GitLab apply the same review aliases", () => {
  const raw = [
    "review:",
    "  on_opened: no",
    "  include-ci-checks: yes",
    "  secret_scan_custom_patterns:",
    "    - token=[A-Z]+",
    "  custom_rules: rule-a, rule-b",
  ].join("\n");

  const github = parseRepoPolicyConfig(raw).review;
  const gitlab = parseGitLabReviewPolicyConfig(raw);
  assert.equal(github?.onOpened, false);
  assert.equal(gitlab.onOpened, false);
  assert.equal(github?.includeCiChecks, true);
  assert.equal(gitlab.includeCiChecks, true);
  assert.deepEqual(github?.secretScanCustomPatterns, ["token=[A-Z]+"]) ;
  assert.deepEqual(gitlab.secretScanCustomPatterns, ["token=[A-Z]+"]) ;
  assert.deepEqual(github?.customRules, ["rule-a", "rule-b"]);
  assert.deepEqual(gitlab.customRules, ["rule-a", "rule-b"]);
});

test("GitHub preserves issue and pull request fields while GitLab uses review defaults", () => {
  const raw = [
    "mode: enforce",
    "issue:",
    "  min_body_length: 42",
    "  required_sections: [Context, Impact]",
    "pull_request:",
    "  require_linked_issue: yes",
    "review:",
    "  mode: report",
  ].join("\n");

  const github = parseRepoPolicyConfig(raw);
  const gitlab = parseGitLabReviewPolicyConfig(raw);
  assert.equal(github.mode, "enforce");
  assert.equal(github.issue?.minBodyLength, 42);
  assert.deepEqual(github.issue?.requiredSections, ["Context", "Impact"]);
  assert.equal(github.pullRequest?.requireLinkedIssue, true);
  assert.equal(github.review?.mode, "report");
  assert.equal(gitlab.mode, "report");
});

test("malformed repository roots throw for GitHub and resolve to GitLab defaults", () => {
  assert.throws(() => parseRepoPolicyConfig("- not\n- a\n- mapping"), /mapping object/);
  const gitlab = parseGitLabReviewPolicyConfig("- not\n- a\n- mapping");
  assert.equal(gitlab.enabled, true);
  assert.equal(gitlab.mode, "comment");
});
