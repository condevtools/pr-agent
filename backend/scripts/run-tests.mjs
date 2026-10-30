import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildNodeTestArguments,
  discoverTests,
  parseTestRunnerRequest,
} from "./test-discovery.mjs";

const backend = fileURLToPath(new URL("../", import.meta.url));
const available = await discoverTests(new URL("../tests/", import.meta.url));
if (!available.length) throw new Error("No backend tests found");
const { runnerArguments } = parseSuite(process.argv.slice(2));
const { forwardedArguments, tests } = parseTestRunnerRequest(runnerArguments, available);
process.stdout.write(`Running ${tests.length} PostgreSQL-authoritative test files\n`);
const result = spawnSync(process.execPath, buildNodeTestArguments(forwardedArguments, tests), {
  cwd: backend,
  stdio: "inherit",
  env: { ...process.env, PR_AGENT_TEST_PUBLICATION_MODE: "postgres" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

function parseSuite(arguments_) {
  const runnerArguments = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--legacy") throw new Error("Legacy test execution was removed");
    if (argument === "--suite") {
      const value = arguments_[index + 1];
      if (!value || !["all", "durable"].includes(value)) {
        throw new Error("--suite must be all or durable");
      }
      index += 1;
      continue;
    }
    runnerArguments.push(argument);
  }
  return { runnerArguments };
}
