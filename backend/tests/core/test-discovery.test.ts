import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNodeTestArguments, discoverTests, isPostgresTestFile, LEGACY_PUBLICATION_PG_TESTS,
  LEGACY_PUBLICATION_TESTS, parseTestRunnerRequest, partitionTestsByPublicationMode,
  publicationModeForPostgresTest, selectTests, validateSuiteSelection,
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

test("separates requested test files from Node options without dropping option values or --", () => {
  const available = ["core/test-discovery.test.ts", "review/short-term-review-usability.test.ts"];
  assert.deepEqual(parseTestRunnerRequest([
    "--test-name-pattern", "discovery", "tests/core/test-discovery.test.ts",
  ], available), {
    forwardedArguments: ["--test-name-pattern", "discovery"],
    hasExplicitSelection: true,
    tests: ["core/test-discovery.test.ts"],
  });
  assert.deepEqual(parseTestRunnerRequest([
    "--test-name-pattern", "looks-like-a.test.ts", "core/test-discovery.test.ts",
  ], available), {
    forwardedArguments: ["--test-name-pattern", "looks-like-a.test.ts"],
    hasExplicitSelection: true,
    tests: ["core/test-discovery.test.ts"],
  });
  assert.deepEqual(parseTestRunnerRequest([
    "--test-isolation=none", "--", "short-term-review-usability.test.ts",
  ], available), {
    forwardedArguments: ["--test-isolation=none", "--"],
    hasExplicitSelection: true,
    tests: ["review/short-term-review-usability.test.ts"],
  });
  assert.throws(
    () => parseTestRunnerRequest(["missing.test.ts"], available),
    /Unknown test selection: missing\.test\.ts/,
  );
});

test("a Node option value ending in .test.ts is not treated as a cross-suite file selection", () => {
  const available = ["core/test-discovery.test.ts", "review/short-term-review-usability.test.ts"];
  const parsed = parseTestRunnerRequest([
    "--test-global-setup", "setup.test.ts",
    "--test-timeout", "5000",
    "--test-name-pattern", "looks-like-a.test.ts",
  ], available);
  assert.deepEqual(parsed, {
    forwardedArguments: [
      "--test-global-setup", "setup.test.ts",
      "--test-timeout", "5000",
      "--test-name-pattern", "looks-like-a.test.ts",
    ],
    hasExplicitSelection: false,
    tests: available,
  });
  const partitioned = partitionTestsByPublicationMode(parsed.tests);
  assert.doesNotThrow(() => validateSuiteSelection("legacy", parsed.hasExplicitSelection, partitioned));
  assert.doesNotThrow(() => validateSuiteSelection("durable", parsed.hasExplicitSelection, partitioned));
  assert.throws(
    () => validateSuiteSelection("legacy", true, partitioned),
    /Durable tests cannot run in the legacy suite/,
  );
});

test("partitions only the explicit temporary legacy inventory out of durable tests", () => {
  const legacy = LEGACY_PUBLICATION_TESTS[0]!;
  assert.deepEqual(partitionTestsByPublicationMode([legacy, "core/test-discovery.test.ts"]), {
    durable: ["core/test-discovery.test.ts"],
    legacy: [legacy],
  });
  assert.equal(LEGACY_PUBLICATION_TESTS.includes("commands/command-authorization.test.ts"), false);
});

test("keeps new PostgreSQL tests durable unless explicitly inventoried as an old prototype", () => {
  assert.deepEqual(LEGACY_PUBLICATION_PG_TESTS, []);
  assert.equal(publicationModeForPostgresTest("agent-runtime/publication.pg.test.ts"), "postgres");
  assert.equal(publicationModeForPostgresTest("agent-runtime/recovery.pg.test.ts"), "postgres");
  assert.equal(publicationModeForPostgresTest("agent-runtime/new-behavior.pg.test.ts"), "postgres");
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

test("the normal runner rejects an unknown test selection before starting Node test", () => {
  const backend = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "missing.test.ts"], {
    cwd: backend, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown test selection: missing\.test\.ts/);
  assert.doesNotMatch(result.stdout, /tests [0-9]+/);
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
