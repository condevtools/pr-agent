import assert from "node:assert/strict";
import test from "node:test";

import { buildReportCommentMarkdown } from "../src/review/report-renderer.ts";
import type { DiffFileContext, PullRequestReviewResult } from "../src/review/review-types.ts";

function makeFile(path: string): DiffFileContext {
  return {
    newPath: path,
    oldPath: path,
    status: "modified",
    additions: 1,
    deletions: 1,
    extendedDiff: "",
    patch: "",
    oldLinesWithNumber: new Map<number, string>(),
    newLinesWithNumber: new Map<number, string>(),
  };
}

const emptyResult: PullRequestReviewResult = {
  summary: "ok",
  riskLevel: "low",
  reviews: [],
  positives: [],
  actionItems: [],
};

test("report markdown renders mermaid change diagram with escaping and node cap", () => {
  const manyPaths = Array.from({ length: 40 }, (_, index) => `src/mod-${index}.ts`);
  const files = [
    makeFile('docs/spec"v1.md'),
    makeFile("infra\\scripts/build.ts"),
    makeFile("src/mod-0.ts"),
    makeFile("src/mod-0.ts"),
    ...manyPaths.map((path) => makeFile(path)),
  ];

  const markdown = buildReportCommentMarkdown(
    emptyResult,
    files,
    {
      platform: "github",
      owner: "acme",
      repo: "demo",
      baseSha: "base",
      headSha: "head",
    },
    { locale: "en" },
  );

  assert.match(markdown, /### Change Structure Diagram \(Mermaid\)/);
  assert.match(markdown, /```mermaid/);
  assert.match(markdown, /flowchart TD/);
  assert.match(markdown, /docs\/spec\\\"v1\.md/);
  assert.match(markdown, /infra\\\\scripts\/build\.ts/);

  const fileNodeCount = markdown
    .split("\n")
    .filter((line) => /^\s*F\d+\["/.test(line)).length;
  assert.equal(fileNodeCount, 24);
});

test("report markdown skips mermaid diagram when changed files are empty", () => {
  const markdown = buildReportCommentMarkdown(
    emptyResult,
    [],
    {
      platform: "github",
      owner: "acme",
      repo: "demo",
      baseSha: "base",
      headSha: "head",
    },
    { locale: "en" },
  );

  assert.doesNotMatch(markdown, /```mermaid/);
  assert.doesNotMatch(markdown, /Change Structure Diagram/);
});
