import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffFileContexts } from "../../src/repository/diff/context.ts";

test("shared diff context filters files and applies patch limits", () => {
  const result = buildDiffFileContexts({
    candidates: [
      {
        newPath: "src/keep.ts",
        oldPath: "src/keep.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      {
        newPath: "docs/readme.md",
        oldPath: "docs/readme.md",
        status: "modified",
        additions: 10,
        deletions: 8,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    maxFiles: 40,
    maxPatchCharsPerFile: 4_000,
    maxTotalPatchChars: 30,
    shouldIncludeFile: (path) => path.startsWith("src/"),
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.newPath, "src/keep.ts");
  assert.equal(result.totalAdditions, 3);
  assert.equal(result.totalDeletions, 1);
  assert.equal(result.totalPatchChars > 0, true);
  assert.deepEqual(result.coverage, { status: "partial", reasonCodes: ["file_filtered"],
    sourceFiles: 2, includedFiles: 1, excludedFiles: 1 });
});

test("shared diff context supports custom patch stats resolver", () => {
  const result = buildDiffFileContexts({
    candidates: [
      {
        newPath: "src/custom.ts",
        oldPath: "src/custom.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
    ],
    maxFiles: 40,
    maxPatchCharsPerFile: 4_000,
    maxTotalPatchChars: 60_000,
    shouldIncludeFile: () => true,
    resolveStats: () => ({ additions: 8, deletions: 5 }),
  });

  assert.equal(result.totalAdditions, 8);
  assert.equal(result.totalDeletions, 5);
  assert.equal(result.coverage.status, "complete");
});

test("shared diff context accounts for provider and local truncation", () => {
  const result = buildDiffFileContexts({ candidates: [
    { newPath: "a.ts", status: "modified", patch: "x" },
    { newPath: "b.ts", status: "modified", patch: "y" },
  ], maxFiles: 1, maxPatchCharsPerFile: 100, maxTotalPatchChars: 100,
  shouldIncludeFile: () => true, sourceTruncated: true, sourceFileCount: 5 });
  assert.deepEqual(result.coverage, { status: "partial",
    reasonCodes: ["file_limit", "provider_file_list_truncated"],
    sourceFiles: 5, includedFiles: 1, excludedFiles: 4 });
});

test("shared diff context reports per-file hunk truncation but not an intentional empty patch", () => {
  const result = buildDiffFileContexts({ candidates: [
    { newPath: "large.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n".repeat(20) },
    { newPath: "renamed.ts", status: "renamed", patch: "" },
  ], maxFiles: 10, maxPatchCharsPerFile: 40, maxTotalPatchChars: 1_000,
  shouldIncludeFile: () => true });
  assert.equal(result.coverage.status, "partial");
  assert.deepEqual(result.coverage.reasonCodes, ["file_patch_truncated"]);
  assert.equal(result.coverage.includedFiles, 2);
});
