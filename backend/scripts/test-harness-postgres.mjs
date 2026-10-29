import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { discoverTests, isPostgresTestFile, selectTests } from "./test-discovery.mjs";

const backend = fileURLToPath(new URL("../", import.meta.url));
const container = `pr-agent-harness-test-${randomUUID().slice(0, 12)}`;
const password = randomUUID();
const image = "postgres:17-alpine";
let created = false;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker ${args[0]} failed: ${result.error?.message || result.stderr || "nonzero exit"}`);
  }
  return result.stdout.trim();
}

try {
  const available = await discoverTests(new URL("../tests/", import.meta.url), isPostgresTestFile);
  const tests = selectTests(available, process.argv.slice(2));
  if (!tests.length) throw new Error("No PostgreSQL tests found");
  docker(["info", "--format", "{{.ServerVersion}}"]);
  docker([
    "run", "--detach", "--name", container, "--label", "pr-agent.harness-test=true",
    "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=postgres",
    "--publish", "127.0.0.1::5432", image,
  ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  created = true;
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Could not determine isolated Docker port");
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // The image starts a temporary Unix-socket-only server during initialization.
    // Wait for the final TCP listener so createdb cannot race that server's shutdown.
    const probe = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0) { ready = true; break; }
    await delay(500);
  }
  if (!ready) throw new Error("PostgreSQL Docker container did not become ready");
  console.log(`Docker PostgreSQL: ${docker(["exec", container, "postgres", "--version"])}`);
  for (let index = 0; index < tests.length; index += 1) {
    const database = `harness_test_${index}_${randomUUID().replaceAll("-", "")}`;
    docker(["exec", container, "createdb", "-U", "postgres", database]);
    console.log(`Running ${tests[index]} against a fresh Docker-only database`);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", `tests/${tests[index]}`], {
      cwd: backend, stdio: "inherit", timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HARNESS_PUBLICATION_MODE: "legacy",
        HARNESS_TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`,
      },
    });
    if (result.error || result.status !== 0) throw new Error(`${tests[index]} failed: ${result.error?.message || result.status}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Docker PostgreSQL tests failed");
  process.exitCode = 1;
} finally {
  // Only the uniquely named container created by this invocation is removed.
  if (created) {
    try { docker(["rm", "--force", "--volumes", container]); }
    catch { console.error(`Could not clean up owned test container ${container}`); process.exitCode = 1; }
  }
}
