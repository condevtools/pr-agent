import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildNodeTestArguments,
  discoverTests,
  LEGACY_PUBLICATION_TESTS,
  parseTestRunnerRequest,
  partitionTestsByPublicationMode,
  validateSuiteSelection,
} from "./test-discovery.mjs";

const backend = fileURLToPath(new URL("../", import.meta.url));
const available = await discoverTests(new URL("../tests/", import.meta.url));
if (!available.length) throw new Error("No backend tests found");
for (const test of LEGACY_PUBLICATION_TESTS) {
  if (!available.includes(test)) throw new Error(`Legacy test inventory is stale: ${test}`);
}
const { runnerArguments, suite } = parseSuite(process.argv.slice(2));
const { forwardedArguments, hasExplicitSelection, tests } = parseTestRunnerRequest(runnerArguments, available);
const partitioned = partitionTestsByPublicationMode(tests);
validateSuiteSelection(suite, hasExplicitSelection, partitioned);
const groups = suite === "durable"
  ? [{ mode: "postgres", tests: partitioned.durable }]
  : suite === "legacy"
    ? [{ mode: "legacy", tests: partitioned.legacy }]
    : [
      { mode: "postgres", tests: partitioned.durable },
      { mode: "legacy", tests: partitioned.legacy },
    ];

for (const group of groups) {
  if (!group.tests.length) continue;
  process.stdout.write(`Running ${group.tests.length} ${group.mode === "postgres" ? "durable" : "temporary legacy"} test files\n`);
  const args = buildNodeTestArguments(forwardedArguments, group.tests);
  const result = spawnSync(process.execPath, args, {
    cwd: backend,
    stdio: "inherit",
    env: { ...process.env, PR_AGENT_TEST_PUBLICATION_MODE: group.mode },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

function parseSuite(arguments_) {
  let suite = "all";
  const runnerArguments = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--legacy") {
      suite = "legacy";
      continue;
    }
    if (argument === "--suite") {
      const value = arguments_[index + 1];
      if (!value || !["all", "durable", "legacy"].includes(value)) {
        throw new Error("--suite must be all, durable, or legacy");
      }
      suite = value;
      index += 1;
      continue;
    }
    runnerArguments.push(argument);
  }
  return { runnerArguments, suite };
}
