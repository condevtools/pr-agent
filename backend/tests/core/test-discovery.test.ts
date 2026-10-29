import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNodeTestArguments, discoverTests, isPostgresTestFile, selectTests,
} from "../../scripts/test-discovery.mjs";

test("discovers nested tests in stable order while excluding support and fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "test-discovery-"));
  try {
    await Promise.all([
      write(root, "review/z.test.ts"), write(root, "agent-runtime/a.pg.test.ts"),
      write(root, "support/helper.test.ts"), write(root, "fixtures/process.test.ts"), write(root, "review/readme.ts"),
    ]);
    assert.deepEqual(await discoverTests(root), ["agent-runtime/a.pg.test.ts", "review/z.test.ts"]);
    assert.deepEqual(await discoverTests(root, isPostgresTestFile), ["agent-runtime/a.pg.test.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects PostgreSQL tests by path or unique basename and rejects invalid selections", () => {
  const available = ["agent-runtime/run-store.pg.test.ts", "review/deep-review.pg.test.ts"];
  assert.deepEqual(selectTests(available, []), available);
  assert.deepEqual(selectTests(available, ["tests/review/deep-review.pg.test.ts"]), ["review/deep-review.pg.test.ts"]);
  assert.deepEqual(selectTests(available, ["run-store.pg.test.ts"]), ["agent-runtime/run-store.pg.test.ts"]);
  assert.throws(() => selectTests(available, ["missing.pg.test.ts"]), /Unknown test selection/);
  assert.throws(() => selectTests([...available, "fix/run-store.pg.test.ts"], ["run-store.pg.test.ts"]), /Ambiguous test selection/);
});

test("forwards Node test options before the recursively discovered files", () => {
  assert.deepEqual(buildNodeTestArguments([
    "--coverage", "--test-name-pattern", "discovery", "--test-isolation=none", "--test-coverage-lines=80",
  ], ["core/test-discovery.test.ts"]), [
    "--import", "./scripts/test-environment.mjs", "--import", "tsx", "--test", "--test-force-exit",
    "--experimental-test-coverage", "--test-name-pattern", "discovery", "--test-isolation=none",
    "--test-coverage-lines=80", "tests/core/test-discovery.test.ts",
  ]);
  assert.deepEqual(buildNodeTestArguments(["--"], ["core/test-discovery.test.ts"]).slice(-2), [
    "--", "tests/core/test-discovery.test.ts",
  ]);
});

test("the normal runner lets Node reject unknown arguments instead of dropping them", () => {
  const backend = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--definitely-not-a-node-test-option"], {
    cwd: backend, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bad option|unknown option|not allowed in NODE_OPTIONS/i);
});

test("the PostgreSQL runner rejects an unknown selection before invoking Docker", () => {
  const backend = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/test-harness-postgres.mjs", "missing.pg.test.ts"], {
    cwd: backend,
    encoding: "utf8",
    env: { ...process.env, PATH: "/path-that-does-not-exist" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown test selection: missing\.pg\.test\.ts/);
  assert.doesNotMatch(result.stderr, /Docker .* failed/);
});

async function write(root: string, path: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, "");
}
