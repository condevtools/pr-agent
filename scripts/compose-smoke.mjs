import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "pr-agent-compose-smoke-"));
const project = `pr-agent-smoke-${randomBytes(6).toString("hex")}`;
const envFile = join(directory, "smoke.env"), composeFile = join(directory, "compose.json");
const tenantId = randomUUID(), tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
const integrations = [randomUUID(), randomUUID()];
const secret = randomBytes(24).toString("hex");
// Do not inherit project credentials or load the developer's .env.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|TMPDIR|TMP|TEMP|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|XDG_RUNTIME_DIR|SSH_AUTH_SOCK)$/u.test(key)));
const command = async (args, timeout = 120_000) => {
  try { return (await promisify(execFile)("docker", args, { cwd: root, env: environment,
    timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    // Docker config and command environments can contain ephemeral passwords.
    let detail = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.slice(-5000);
    for (const value of [...Object.values(values), ...tokens, secret]) {
      if (value.length > 4) detail = detail.replaceAll(value, "[redacted]");
    }
    throw new Error(`Docker command failed (exit ${error.code ?? "unknown"}): ${detail}`);
  }
};
const compose = (args, timeout) => command(["compose", "--project-name", project, "--project-directory", root,
  "--env-file", envFile, "-f", composeFile, ...args], timeout);
const pricing = { version: "compose-smoke-v1", currency: "USD",
  tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
  runLimits: { inputTokens: 100_000, outputTokens: 10_000, costMicros: 0 }, models: {
    "openai-compatible:fixture-model": { maxOutputTokens: 1000, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens",
      rates: { inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0, thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 } },
  } };
const values = Object.fromEntries(["BOOTSTRAP", "MIGRATION", "APP", "VERIFIER", "MAINTENANCE"]
  .map((role) => [`HARNESS_${role}_PASSWORD`, randomBytes(32).toString("hex")]));
Object.assign(values, { NODE_ENV: "production", FEATURE_DEEP_REVIEW: "off", FEATURE_FIX: "off", FEATURE_EVOLUTION: "off",
  AI_PROVIDER: "openai-compatible", AI_MODEL: "fixture-model", OPENAI_COMPATIBLE_API_KEY: "local-fixture-only",
  OPENAI_COMPATIBLE_TOKEN_PARAMETER: "max_tokens", OPENAI_BASE_URL: "http://provider-mock:8080/v1",
  GITHUB_TOKEN: "local-fixture-only", GITHUB_API_URL: "http://provider-mock:8080", GITHUB_WEBHOOK_SECRET: secret,
  GITLAB_TOKEN: "local-fixture-only", GITLAB_BASE_URL: "http://provider-mock:8080", GITLAB_WEBHOOK_SECRET: secret,
  ALLOW_INSECURE_GITLAB_HTTP: "true", HARNESS_MODEL_PRICING_JSON: JSON.stringify(pricing),
  HARNESS_API_PRINCIPALS_JSON: JSON.stringify(integrations.map((integrationId, i) => ({ subjectId: "compose-smoke",
    actorType: "service", tenantId, integrationId, tokenSha256: createHash("sha256").update(tokens[i]).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: ["runs:create", "runs:read", "metrics:read"] }))),
});
await writeFile(envFile, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600 });
let started = false;
try {
  const config = JSON.parse(await command(["compose", "--project-name", project, "--project-directory", root,
    "--env-file", envFile, "-f", join(root, "docker-compose.yml"), "config", "--format", "json"]));
  const image = `${project}:local`;
  for (const service of Object.values(config.services)) if (service.build) service.image = image;
  config.services["pr-agent"].ports = [];
  config.networks = { default: { internal: true } };
  config.services["provider-mock"] = { image, user: "10001:10001", read_only: true, cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"], command: ["node", "/fixture.mjs"],
    volumes: [{ type: "bind", source: join(root, "scripts/fixtures/provider-mock.mjs"), target: "/fixture.mjs", read_only: true }],
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/stats').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
      interval: "2s", timeout: "3s", retries: 20 }, networks: { default: {} } };
  await writeFile(composeFile, JSON.stringify(config), { mode: 0o600 });
  console.log("Building isolated Compose image");
  await compose(["build", "pr-agent"], 600_000);
  started = true;
  console.log("Starting fresh PostgreSQL and isolated runtime roles");
  await compose(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "120"], 180_000);
  const request = async (path, options = {}) => {
    const script = `const input=JSON.parse(process.argv[1]);const response=await fetch("http://127.0.0.1:3000"+input.path,`+
      `{...input.options,signal:AbortSignal.timeout(10000)});const text=await response.text();let body;`+
      `try{body=JSON.parse(text)}catch{body=text}console.log(JSON.stringify({status:response.status,body}));`;
    return JSON.parse(await compose(["exec", "-T", "pr-agent", "node", "--input-type=module", "-e", script,
      JSON.stringify({ path, options })]));
  };
  await until(async () => (await request("/ready")).status === 200, "runtime readiness");
  assert.equal((await request("/health")).body.ok, true);
  assert.equal((await request("/metrics")).status, 401);
  assert.equal((await request("/github/trigger", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "ping" }, body: "{}" })).status, 403);
  const gitlabPayload = JSON.stringify({ object_kind: "note", project: { id: 999, name: "unmanaged",
    web_url: "http://provider-mock:8080/acme/unmanaged", path_with_namespace: "acme/unmanaged" },
    object_attributes: { note: "LGTM", noteable_type: "MergeRequest" } });
  assert.equal((await request("/gitlab/trigger", { method: "POST", headers: { "content-type": "application/json" }, body: gitlabPayload })).status, 403);
  const comment = JSON.stringify({ action: "created", repository: { id: 999, name: "unmanaged", owner: { login: "acme" } },
    issue: { number: 1, pull_request: {} }, comment: { id: 1, body: "LGTM", user: { login: "alice", type: "User" } } });
  const ignored = await request("/github/trigger", { method: "POST", headers: { "content-type": "application/json",
    "x-github-event": "issue_comment", "x-github-delivery": randomUUID(),
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(comment).digest("hex")}` }, body: comment });
  assert.ok(ignored.status < 300, "ordinary unmanaged comment must be acknowledged");
  for (let index = 0; index < integrations.length; index++) {
    const platform = index === 0 ? "github" : "gitlab", integration = integrations[index];
    const admin = (args) => compose(["run", "--rm", "--no-deps", "database-init", "node", "dist/agent-runtime/cli.js", ...args]);
    await admin(["bind", "--tenant", tenantId, "--id", integration, "--platform", platform, "--origin", "http://provider-mock:8080", "--repository", "acme/smoke"]);
    await admin(["configure", "--tenant", tenantId, "--id", integration, "--repository-id", "4242", "--actor-id", "4343",
      "--credential-ref", `env:${platform === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN"}`, "--version", "0"]);
    await admin(["authority", "--tenant", tenantId, "--id", integration, "--action", "activate", "--version", "1", "--evidence", "fresh-isolated-smoke"]);
    const headers = { "content-type": "application/json", authorization: `Bearer ${tokens[index]}`, "idempotency-key": "smoke-review" };
    const body = JSON.stringify({ number: 42, options: { customRules: [], includeCiChecks: false,
      enableSecretScan: false, secretScanCustomPatterns: [], enableAutoLabel: false } });
    const created = await request("/runs", { method: "POST", headers, body });
    assert.equal(created.status, 202, `${platform} Run admission: ${JSON.stringify(created.body)}`);
    const repeated = await request("/runs", { method: "POST", headers, body });
    assert.equal(repeated.body.id, created.body.id); assert.equal(repeated.body.created, false);
    await until(async () => {
      const run = await request(`/runs/${created.body.id}`, { headers });
      assert.equal(run.status, 200);
      assert.notEqual(run.body.status, "failed", `${platform} Run failed: ${JSON.stringify(run.body)}`);
      return run.body.status === "succeeded";
    }, `${platform} mock review publication`);
    assert.equal((await request("/metrics", { headers })).status, 200);
  }
  const stats = JSON.parse(await compose(["exec", "-T", "provider-mock", "node", "-e",
    "fetch('http://127.0.0.1:8080/stats').then(r=>r.text()).then(console.log)"]));
  assert.equal(stats.modelCalls, 2); assert.equal(stats.githubComments, 1); assert.equal(stats.gitlabComments, 1);
  const cycleId = randomUUID();
  const preview = async () => JSON.parse(await compose(["run", "--rm", "--no-deps", "maintenance", "node",
    "dist/agent-runtime/maintenance-process.js", "--once", "--cycle-id", cycleId]));
  const receipt = await preview();
  assert.equal(receipt.action, "preview");
  assert.deepEqual(await preview(), receipt, "one-shot maintenance reuses the exact cycle receipt");
  await compose(["stop", "--timeout", "45", "worker", "recovery", "maintenance"]);
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/ready")).status, 503, "stopped workers must withdraw readiness");
  await compose(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "120"], 180_000);
  await until(async () => (await request("/ready")).status === 200, "readiness after restart");
  console.log("Compose smoke passed: fresh schema, roles, auth, GH/GL mock budgeted publication, idempotency, shutdown/restart");
} catch (error) {
  if (started) {
    console.error(await compose(["ps", "--all"]).catch(() => "Service state unavailable"));
    const ids = await compose(["ps", "--all", "--quiet"]).catch(() => "");
    for (const id of ids.split("\n").filter(Boolean)) {
      console.error(await command(["inspect", "--format", "{{.Name}} {{json .State.Health}}", id]).catch(() => "Health state unavailable"));
    }
    // Service logs are structured/redacted; do not print config or env files.
    const logs = await compose(["logs", "--no-color", "--tail", "20", "pr-agent", "worker", "recovery", "maintenance", "provider-mock"]).catch(() => "Logs unavailable");
    console.error(logs);
  }
  console.error(error instanceof Error ? error.message : "Compose smoke failed");
  process.exitCode = 1;
} finally {
  if (started) await compose(["down", "--volumes", "--remove-orphans", "--timeout", "15"], 90_000)
    .catch(() => { console.error(`Cleanup failed for isolated project ${project}`); process.exitCode = 1; });
  await rm(directory, { recursive: true, force: true });
}

async function until(probe, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
