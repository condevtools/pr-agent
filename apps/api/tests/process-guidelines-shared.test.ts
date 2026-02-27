import assert from "node:assert/strict";
import test from "node:test";

import { loadProcessGuidelinesWithCache } from "@mr-agent/shared/process-guidelines.ts";

test("shared guideline loader reads direct files and template files from directories", async () => {
  const scope = `guideline-scope-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cacheKey = "owner/repo@main";
  const fileReadCalls: string[] = [];
  const listCalls: string[] = [];

  const loaded = await loadProcessGuidelinesWithCache({
    scope,
    cacheKey,
    ttlMs: 60_000,
    maxEntries: 100,
    filePaths: [".github/copilot-instructions.md"],
    directories: [".github/instructions"],
    maxGuidelines: 20,
    maxGuidelinesPerDirectory: 8,
    isTemplateFile: (path) => path.endsWith(".md"),
    readFile: async (path) => {
      fileReadCalls.push(path);
      if (path === ".github/copilot-instructions.md") {
        return { path, content: "global guideline" };
      }
      if (path === ".github/instructions/review.md") {
        return { path, content: "review guideline" };
      }
      return undefined;
    },
    listDirectory: async (path) => {
      listCalls.push(path);
      if (path !== ".github/instructions") {
        return [];
      }
      return [
        { path: ".github/instructions/review.md", type: "blob" },
        { path: ".github/instructions/notes.txt", type: "blob" },
      ];
    },
  });

  assert.deepEqual(
    loaded.map((item) => item.path),
    [".github/copilot-instructions.md", ".github/instructions/review.md"],
  );
  assert.equal(fileReadCalls.length, 2);
  assert.equal(listCalls.length, 1);
});

test("shared guideline loader uses runtime cache for repeated requests", async () => {
  const scope = `guideline-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cacheKey = "cached/repo@main";
  let readCount = 0;
  let listCount = 0;

  const params = {
    scope,
    cacheKey,
    ttlMs: 60_000,
    maxEntries: 100,
    filePaths: ["README.md"],
    directories: ["docs"],
    maxGuidelines: 20,
    maxGuidelinesPerDirectory: 8,
    isTemplateFile: (path: string) => path.endsWith(".md"),
    readFile: async (path: string) => {
      readCount += 1;
      return { path, content: `content:${path}` };
    },
    listDirectory: async () => {
      listCount += 1;
      return [{ path: "docs/process.md", type: "blob" }];
    },
  };

  const first = await loadProcessGuidelinesWithCache(params);
  const second = await loadProcessGuidelinesWithCache(params);

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(readCount, 2);
  assert.equal(listCount, 1);
});
