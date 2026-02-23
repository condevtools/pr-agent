import assert from "node:assert/strict";
import test from "node:test";

import { buildIssueCommentMarkdown } from "../src/review/report-renderer.ts";

test("old-line suggestion is rendered as fallback text block instead of being dropped", () => {
  const markdown = buildIssueCommentMarkdown(
    {
      severity: "medium",
      newPath: "src/a.ts",
      oldPath: "src/a.ts",
      type: "old",
      startLine: 8,
      endLine: 8,
      issueHeader: "Deletion looks risky",
      issueContent: "Consider keeping this guard.",
      suggestion: "if (!input) return;",
    },
    { platform: "github", locale: "en" },
  );

  assert.doesNotMatch(markdown, /```suggestion/);
  assert.match(markdown, /Suggested fix/i);
  assert.match(markdown, /```text/);
  assert.match(markdown, /if \(!input\) return;/);
});

test("issue markdown escapes html-sensitive content", () => {
  const markdown = buildIssueCommentMarkdown(
    {
      severity: "high",
      newPath: "src/a.ts",
      oldPath: "src/a.ts",
      type: "new",
      startLine: 12,
      endLine: 12,
      issueHeader: "<script>alert(1)</script>",
      issueContent: "Use x < y && y > z",
    },
    { platform: "github", locale: "en" },
  );

  assert.doesNotMatch(markdown, /<script>alert\(1\)<\/script>/);
  assert.match(markdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markdown, /Use x &lt; y &amp;&amp; y &gt; z/);
});
