import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildNodeTestArguments, discoverTests } from "./test-discovery.mjs";

const backend = fileURLToPath(new URL("../", import.meta.url));
const tests = await discoverTests(new URL("../tests/", import.meta.url));
if (!tests.length) throw new Error("No backend tests found");

const args = buildNodeTestArguments(process.argv.slice(2), tests);
const result = spawnSync(process.execPath, args, { cwd: backend, stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
