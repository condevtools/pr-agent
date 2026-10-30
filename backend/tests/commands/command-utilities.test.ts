import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAddDocRule,
  buildImproveRule,
} from "../../src/commands/builders/questions.ts";
import {
  parseYamlBooleanMaybe,
  stripYamlQuotes,
} from "../../src/core/config/yaml.ts";
import { findPotentialSecrets } from "../../src/repository/content-safety/secret-scan.ts";
import { isLikelyPlaceholder } from "../../src/repository/content-safety/secret-scan.js";
import { inferReviewLabels } from "../../src/review/presentation/auto-labels.ts";
import { buildSecretWarningComment } from "../../src/review/rendering/secret-warning.ts";
import {
  buildSimilarIssueComment,
  buildSimilarIssueQueryMissingMessage,
  resolveSimilarIssueQuery,
} from "../../src/issues/similarity/presentation.ts";

test("shared improve/add-doc builders keep focus behavior", () => {
  assert.match(
    buildImproveRule("api timeout"),
    /Focus mode: improvement suggestions only\./,
  );
  assert.match(buildImproveRule("api timeout"), /api timeout/);
  assert.match(
    buildAddDocRule("auth token"),
    /Focus mode: docstrings\/comments only\./,
  );
  assert.match(buildAddDocRule("auth token"), /auth token/);
});

test("shared yaml helpers strip quotes and parse boolean aliases", () => {
  assert.equal(stripYamlQuotes("'enforce'"), "enforce");
  assert.equal(stripYamlQuotes("  \"report\"  "), "report");
  assert.equal(stripYamlQuotes("plain"), "plain");

  assert.equal(parseYamlBooleanMaybe("yes"), true);
  assert.equal(parseYamlBooleanMaybe("'on'"), true);
  assert.equal(parseYamlBooleanMaybe("0"), false);
  assert.equal(parseYamlBooleanMaybe("off"), false);
  assert.equal(parseYamlBooleanMaybe("maybe"), undefined);
});

test("shared secret scan uses consistent placeholder filter and sample redaction", () => {
  const findings = findPotentialSecrets({
    files: [
      {
        newPath: "src/config.ts",
        patch: [
          "@@ -0,0 +1,2 @@",
          '+const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890AB";',
          '+const fake = "your_api_key_here";',
        ].join("\n"),
      },
    ],
    maxFindings: 10,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "GitHub Token");
  assert.match(findings[0]?.sample ?? "", /^ghp_\*\*\*90AB$/);
  assert.equal(isLikelyPlaceholder("your_api_key_here"), true);
  assert.equal(isLikelyPlaceholder("production-secret-value"), false);
});

test("shared secret warning comment keeps platform-specific wording", () => {
  const findings = [
    {
      path: "src/config.ts",
      line: 12,
      kind: "GitHub Token",
      sample: "ghp_***90AB",
    },
  ];

  const githubComment = buildSecretWarningComment({
    platform: "github",
    findings,
    locale: "en",
  });
  assert.match(githubComment, /- \[ \] `src\/config\.ts:12` detected possible/);
  assert.match(githubComment, /push protection/);

  const gitlabComment = buildSecretWarningComment({
    platform: "gitlab",
    findings,
    locale: "en",
  });
  assert.match(gitlabComment, /- `src\/config\.ts:12` \(GitHub Token\) sample:/);
  assert.match(gitlabComment, /GitLab Secret Detection/);
});

test("shared similar issue helpers keep consistent query and markdown rendering", () => {
  assert.equal(
    resolveSimilarIssueQuery({
      query: "",
      title: "auth timeout",
      description: "race condition in refresh",
    }),
    "auth timeout race condition in refresh",
  );
  assert.match(buildSimilarIssueQueryMissingMessage("en"), /Unable to derive a search query/);

  const markdown = buildSimilarIssueComment(
    "auth timeout",
    [
      {
        id: 42,
        title: "Fix token refresh race",
        url: "https://example.com/issues/42",
        state: "opened",
        score: 88,
        matchedTerms: ["auth", "refresh"],
      },
    ],
    "en",
  );
  assert.match(markdown, /AI Similar Issue Finder/);
  assert.match(markdown, /Query: `auth timeout`/);
  assert.match(markdown, /score=88/);
});

test("shared auto-label inference supports github-style and gitlab-style strategies", () => {
  const createFile = (newPath: string) => ({
    newPath,
    oldPath: newPath,
    status: "modified",
    additions: 1,
    deletions: 1,
    extendedDiff: "@@ -1 +1 @@\n-a\n+b",
    patch: "@@ -1 +1 @@\n-a\n+b",
    oldLinesWithNumber: new Map<number, string>(),
    newLinesWithNumber: new Map<number, string>(),
  });
  const base = {
    title: "feat: improve docs and tests",
    files: [
      createFile("docs/guide.md"),
      createFile("src/service.spec.ts"),
      createFile(".github/workflows/ci.yml"),
    ],
    reviewResult: {
      summary: "high risk",
      riskLevel: "high",
      reviews: [],
      positives: [],
      actionItems: [],
    },
    hasSecretFinding: false,
  };

  const githubLabels = inferReviewLabels({
    ...base,
    docsFromFiles: "all-documentation",
    highRiskLabel: "needs-attention",
    fallbackLabel: "ai-reviewed",
    maxLabels: 8,
  });
  assert.equal(githubLabels.includes("docs"), false);
  assert.equal(githubLabels.includes("tests"), false);
  assert.equal(githubLabels.includes("ci"), false);
  assert.equal(githubLabels.includes("needs-attention"), true);

  const gitlabLabels = inferReviewLabels({
    ...base,
    docsFromTitle: true,
    docsFromFiles: "any-markdown",
    includeTestLabelFromFiles: true,
    includeCiLabelFromFiles: true,
    highRiskLabel: "high-risk",
    maxLabels: 10,
  });
  assert.equal(gitlabLabels.includes("docs"), true);
  assert.equal(gitlabLabels.includes("tests"), true);
  assert.equal(gitlabLabels.includes("ci"), true);
  assert.equal(gitlabLabels.includes("high-risk"), true);
});
