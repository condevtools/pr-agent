import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const backend = fileURLToPath(new URL("../", import.meta.url));
const project = fileURLToPath(new URL("../../", import.meta.url));
const profile = process.argv.includes("--qualification") ? "qualification" : "quick";
const requestedOutput = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
const container = `pr-agent-capacity-${randomUUID().slice(0, 12)}`;
const database = `harness_capacity_${randomUUID().replaceAll("-", "")}`;
const password = randomUUID();
const output = requestedOutput || fileURLToPath(new URL(profile === "qualification"
  ? "../../.omx/implementation/p0d-capacity.json"
  : "../../.omx/implementation/p0d-capacity-quick.json", import.meta.url));
let created = false;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker ${args[0]} failed: ${result.error?.message || result.stderr || "nonzero exit"}`);
  }
  return result.stdout.trim();
}

try {
  await mkdir(fileURLToPath(new URL("../../.omx/implementation/", import.meta.url)), { recursive: true });
  if (profile === "qualification" && !requestedOutput) {
    const first = fileURLToPath(new URL("../../.omx/implementation/p0d-capacity-first.json", import.meta.url));
    await copyFile(output, first, constants.COPYFILE_EXCL).catch((error) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "EEXIST") throw error;
    });
  }
  docker(["info", "--format", "{{.ServerVersion}}"]);
  docker(["run", "--detach", "--name", container, "--label", "pr-agent.harness-capacity=true",
    "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=postgres",
    "--publish", "127.0.0.1::5432", "postgres:17-alpine"],
  { env: { ...process.env, POSTGRES_PASSWORD: password } });
  created = true;
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Could not determine isolated PostgreSQL port");
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
      { stdio: "ignore", timeout: 5_000 });
    if (probe.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("PostgreSQL Docker container did not become ready");
  docker(["exec", container, "createdb", "-U", "postgres", database]);
  console.log(JSON.stringify({ event: "capacity.start", profile, postgres: docker(["exec", container, "postgres", "--version"]), output }));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/harness-capacity.ts", `--profile=${profile}`, `--output=${output}`], {
    cwd: backend, stdio: "inherit", env: { ...process.env, NODE_ENV: "test", CAPACITY_PROJECT_ROOT: project,
      HARNESS_TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}` },
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0) throw new Error(`Capacity process failed (${status.code ?? status.signal})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Harness capacity launcher failed");
  process.exitCode = 1;
} finally {
  if (created) {
    try { docker(["rm", "--force", "--volumes", container]); }
    catch { console.error(`Could not clean up owned capacity container ${container}`); process.exitCode = 1; }
  }
}
