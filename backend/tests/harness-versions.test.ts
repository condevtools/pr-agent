import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCodeManifest, fingerprint, reviewVersionManifest } from "../src/harness/versions.js";

test("checkpoint fingerprints survive PostgreSQL JSONB object key ordering", () => {
  assert.equal(fingerprint({ b: [{ x: 1, a: 2 }], a: true }),
    fingerprint({ a: true, b: [{ a: 2, x: 1 }] }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});

test("dependency and migration changes invalidate the built runtime manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-version-"));
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "backend/scripts"));
    for (const file of ["backend/package.json", "backend/tsconfig.json", "backend/scripts/copy-harness-assets.mjs", "backend/scripts/fix-sandbox-runner.mjs",
      "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "backend/src/main.ts", "backend/src/001.sql"]) {
      await writeFile(join(root, file), "original");
    }
    const source = pathToFileURL(join(root, "backend/src/"));
    const baseline = await buildCodeManifest(source);
    await writeFile(join(root, "pnpm-lock.yaml"), "new-sdk-version");
    const changedDependencies = await buildCodeManifest(source);
    assert.notEqual(changedDependencies.sourceHash, baseline.sourceHash);
    await writeFile(join(root, "backend/src/001.sql"), "new-schema-contract");
    const changedMigration = await buildCodeManifest(source);
    assert.notEqual(changedMigration.sourceHash, changedDependencies.sourceHash);
    await writeFile(join(root, "backend/scripts/fix-sandbox-runner.mjs"), "changed-sandbox-protocol");
    assert.notEqual((await buildCodeManifest(source)).sourceHash, changedMigration.sourceHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime fingerprints include review policy and locale but exclude credentials", async () => {
  const names = ["PR_AGENT_LOCALE", "REVIEW_CODE_EXTENSIONS", "OPENAI_API_KEY",
    "OPENAI_MAX_COMPLETION_TOKENS", "ANTHROPIC_MAX_TOKENS", "GEMINI_MAX_OUTPUT_TOKENS"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PR_AGENT_LOCALE = "en";
    process.env.REVIEW_CODE_EXTENSIONS = ".ts";
    process.env.OPENAI_API_KEY = "fixture-one";
    const baseline = await reviewVersionManifest({ version: "test" });
    process.env.OPENAI_API_KEY = "fixture-two";
    assert.deepEqual(await reviewVersionManifest({ version: "test" }), baseline);
    process.env.PR_AGENT_LOCALE = "zh";
    assert.notEqual((await reviewVersionManifest({ version: "test" })).runtimeVersionHash, baseline.runtimeVersionHash);
    process.env.PR_AGENT_LOCALE = "en";
    process.env.REVIEW_CODE_EXTENSIONS = ".py";
    assert.notEqual((await reviewVersionManifest({ version: "test" })).runtimeVersionHash, baseline.runtimeVersionHash);
    for (const name of names.slice(3)) {
      const before = (await reviewVersionManifest({ version: "test" })).runtimeVersionHash;
      process.env[name] = process.env[name] === "123" ? "124" : "123";
      assert.notEqual((await reviewVersionManifest({ version: "test" })).runtimeVersionHash, before);
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
