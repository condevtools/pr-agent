import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffFileContexts } from "@mr-agent/shared/diff-context.ts";

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
});
