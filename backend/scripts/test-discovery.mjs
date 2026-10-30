import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRECTORIES = new Set(["fixtures", "support"]);
const NODE_TEST_OPTIONS_WITH_VALUE = new Set([
  "--experimental-test-tag-filter",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--test-name-pattern",
  "--test-random-seed",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-rerun-failures",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
]);

// Temporary compatibility inventory. Every entry exercises a direct writer or
// synchronous workflow that Phase 5 removes; new tests must not be added here.
export const LEGACY_PUBLICATION_TESTS = Object.freeze([
  "agent-runtime/publication.test.ts",
  "fix/fix-publication.test.ts",
  "integrations/github/github-issue-auto-triage.test.ts",
  "integrations/github/github-similar-issue-command.test.ts",
  "integrations/gitlab/gitlab-hardening-fixes.test.ts",
  "integrations/gitlab/gitlab-similar-issue-command.test.ts",
  "integrations/gitlab/gitlab-x-ai-mode.test.ts",
  "regression/platform-publication.test.ts",
  "regression/policy-lifecycle-e2e.test.ts",
  "review/short-term-review-usability.test.ts",
]);

// PostgreSQL prototype coverage that still creates generation-0 operations
// outside a claimed durable write context. Phase 2/5 removes this exception.
export const LEGACY_PUBLICATION_PG_TESTS = Object.freeze([
  "agent-runtime/publication.pg.test.ts",
]);

export async function discoverTests(root, predicate = isTestFile) {
  const absoluteRoot = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const discovered = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && predicate(entry.name)) {
        discovered.push(relative(absoluteRoot, path).split(sep).join("/"));
      }
    }
  }

  await visit(absoluteRoot);
  return discovered.sort();
}

export function isTestFile(name) {
  return name.endsWith(".test.ts");
}

export function isPostgresTestFile(name) {
  return name.endsWith(".pg.test.ts");
}

export function selectTests(available, requested) {
  if (!requested.length) return available;
  const selected = [];
  for (const request of requested) {
    const normalized = request.replaceAll("\\", "/").replace(/^tests\//, "");
    const matches = normalized.includes("/")
      ? available.filter((path) => path === normalized)
      : available.filter((path) => path.split("/").at(-1) === normalized);
    if (matches.length === 0) throw new Error(`Unknown test selection: ${request}`);
    if (matches.length > 1) throw new Error(`Ambiguous test selection: ${request} (${matches.join(", ")})`);
    if (!selected.includes(matches[0])) selected.push(matches[0]);
  }
  return selected.sort();
}

export function parseTestRunnerRequest(arguments_, available) {
  const requested = [];
  const forwardedArguments = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (NODE_TEST_OPTIONS_WITH_VALUE.has(argument)) {
      forwardedArguments.push(argument);
      if (index + 1 < arguments_.length) forwardedArguments.push(arguments_[index += 1]);
      continue;
    }
    if (isTestSelection(argument)) requested.push(argument);
    else forwardedArguments.push(argument);
  }
  return {
    forwardedArguments,
    hasExplicitSelection: requested.length > 0,
    tests: selectTests(available, requested),
  };
}

export function partitionTestsByPublicationMode(tests) {
  const legacySet = new Set(LEGACY_PUBLICATION_TESTS);
  return {
    durable: tests.filter((test) => !legacySet.has(test)),
    legacy: tests.filter((test) => legacySet.has(test)),
  };
}

export function publicationModeForPostgresTest(test) {
  return LEGACY_PUBLICATION_PG_TESTS.includes(test) ? "legacy" : "postgres";
}

export function validateSuiteSelection(suite, hasExplicitSelection, partitioned) {
  if (hasExplicitSelection && suite === "legacy" && partitioned.durable.length) {
    throw new Error(`Durable tests cannot run in the legacy suite: ${partitioned.durable.join(", ")}`);
  }
  if (hasExplicitSelection && suite === "durable" && partitioned.legacy.length) {
    throw new Error(`Legacy-only tests cannot run in the durable suite: ${partitioned.legacy.join(", ")}`);
  }
}

function isTestSelection(argument) {
  if (typeof argument !== "string" || argument.startsWith("-")) return false;
  const normalized = argument.replaceAll("\\", "/");
  return /(?:^|\/)[^/]+\.test\.ts$/.test(normalized) || /^[^/]+\.test\.ts$/.test(normalized);
}

export function buildNodeTestArguments(forwardedArguments, tests) {
  const coverage = forwardedArguments.includes("--coverage");
  const nodeOptions = forwardedArguments.filter((argument) => argument !== "--coverage");
  const args = ["--import", "./scripts/test-environment.mjs", "--import", "tsx", "--test", "--test-force-exit"];
  if (coverage) args.push("--experimental-test-coverage");
  return [...args, ...nodeOptions, ...tests.map((path) => `tests/${path}`)];
}
