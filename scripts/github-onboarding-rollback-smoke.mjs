import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const baseline = "701c6b97abe005b95c64e192e403d142e96f8696";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "pr-agent-github-rollback-"));
const checkout = join(directory, "baseline");
const suffix = randomBytes(6).toString("hex");
const network = `pr-agent-rollback-${suffix}`;
const postgresContainer = `${network}-postgres`;
const applicationContainer = `${network}-web`;
const image = `${network}:${baseline.slice(0, 12)}`;
const postgresPassword = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const onboardingPassword = randomBytes(24).toString("hex");
const maintenancePassword = randomBytes(24).toString("hex");
const webhookSecret = randomBytes(24).toString("hex");
const deliveryId = `rollback-${randomUUID()}`;
const tenantId = randomUUID();
const bindingId = randomUUID();
const secrets = [postgresPassword, appPassword, onboardingPassword, maintenancePassword, webhookSecret];
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|TMPDIR|TMP|TEMP|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|XDG_RUNTIME_DIR)$/u.test(key)));
let networkCreated = false;
let postgresCreated = false;
let applicationCreated = false;
let imageCreated = false;

const pricing = {
  version: "rollback-smoke-v1", currency: "USD",
  tenantLimits: { inputTokens: 1_000_000, outputTokens: 1_000_000, costMicros: 0 },
  runLimits: { inputTokens: 100_000, outputTokens: 10_000, costMicros: 0 },
  models: {
    "openai-compatible:fixture-model": {
      maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3, openAiTokenParameter: "max_tokens",
      rates: { inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0,
        cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
        thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 },
    },
  },
};

try {
  await run("pnpm", ["--filter", "backend", "build"], { cwd: root, timeout: 180_000 });
  await archiveBaseline(checkout);
  await rm(join(checkout, ".env"), { force: true });
  await rm(join(checkout, ".codex"), { recursive: true, force: true });

  console.log(`Building rollback image from ${baseline}`);
  await docker(["build", "--tag", image, checkout], 600_000);
  imageCreated = true;
  await docker(["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev",
    image, "node", "--input-type=module", "-e",
    `const {githubOnboardingEnabled}=await import('./dist/agent-runtime/runtime/config.js');
     if(githubOnboardingEnabled({})!==false)process.exit(2);
     let rejected=false;try{githubOnboardingEnabled({FEATURE_GITHUB_ONBOARDING:'auto'})}catch{rejected=true}
     if(!rejected)process.exit(3);`]);
  await docker(["network", "create", "--internal", network]);
  networkCreated = true;
  await docker(["run", "--detach", "--name", postgresContainer, "--network", network,
    "--env", `POSTGRES_PASSWORD=${postgresPassword}`, "--env", "POSTGRES_DB=pr_agent", "postgres:17-alpine"]);
  postgresCreated = true;
  await until(async () => (await dockerStatus(["exec", postgresContainer, "pg_isready", "-h", "127.0.0.1",
    "-U", "postgres", "-d", "pr_agent"])).ok, "PostgreSQL readiness", 60_000);
  await databaseFixture("setup");

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  secrets.push(privateKey);
  const appEnvironment = {
    NODE_ENV: "production", PR_AGENT_PROCESS_ROLE: "web", HARNESS_PUBLICATION_MODE: "postgres",
    HARNESS_PG_HOST: postgresContainer, HARNESS_PG_DATABASE: "pr_agent", HARNESS_PG_PORT: "5432",
    HARNESS_PG_USER: "pr_agent_app", HARNESS_PG_PASSWORD: appPassword,
    HARNESS_ONBOARDING_PG_PASSWORD: onboardingPassword, FEATURE_GITHUB_ONBOARDING: "on",
    FEATURE_DEEP_REVIEW: "off", FEATURE_FIX: "off", FEATURE_EVOLUTION: "off",
    APP_ID: "71", PRIVATE_KEY: privateKey, WEBHOOK_SECRET: webhookSecret,
    GITHUB_WEBHOOK_SECRET: webhookSecret, GITHUB_API_URL: "https://api.github.com",
    AI_PROVIDER: "openai-compatible", AI_MODEL: "fixture-model",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1", HARNESS_MODEL_PRICING_JSON: JSON.stringify(pricing),
    PORT: "3000",
  };
  const runArgs = ["run", "--detach", "--name", applicationContainer, "--network", network,
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev"];
  for (const [key, value] of Object.entries(appEnvironment)) runArgs.push("--env", `${key}=${value}`);
  runArgs.push(image);
  await docker(runArgs);
  applicationCreated = true;
  await until(async () => (await dockerStatus(["exec", applicationContainer, "node", "-e",
    "fetch('http://127.0.0.1:3000/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"])).ok,
  "baseline web readiness", 90_000);

  const payload = JSON.stringify({
    action: "deleted",
    installation: { id: 81, app_id: 71, account: { login: "rollback-fixture", id: 101,
      node_id: "fixture", avatar_url: "https://example.invalid/avatar", gravatar_id: "", url: "https://api.github.com/users/rollback-fixture",
      html_url: "https://github.com/rollback-fixture", followers_url: "", following_url: "", gists_url: "",
      starred_url: "", subscriptions_url: "", organizations_url: "", repos_url: "", events_url: "",
      received_events_url: "", type: "Organization", site_admin: false }, repository_selection: "all",
      access_tokens_url: "https://api.github.com/app/installations/81/access_tokens",
      repositories_url: "https://api.github.com/installation/repositories",
      html_url: "https://github.com/settings/installations/81", app_slug: "rollback-fixture",
      target_id: 101, target_type: "Organization", permissions: {}, events: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), suspended_at: null,
      suspended_by: null },
    sender: { login: "rollback-fixture", id: 101, node_id: "fixture", avatar_url: "https://example.invalid/avatar",
      gravatar_id: "", url: "https://api.github.com/users/rollback-fixture",
      html_url: "https://github.com/rollback-fixture", followers_url: "", following_url: "", gists_url: "",
      starred_url: "", subscriptions_url: "", organizations_url: "", repos_url: "", events_url: "",
      received_events_url: "", type: "Organization", site_admin: false },
  });
  const webhookOptions = { method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "installation",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}` },
    body: payload };
  const response = JSON.parse(await docker(["exec", applicationContainer, "node", "-e",
    "const o=JSON.parse(process.argv[1]);fetch('http://127.0.0.1:3000/api/github/webhooks',o).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(e=>{console.error(e.message);process.exit(1)})",
    JSON.stringify(webhookOptions)]));
  assert.ok(response.status >= 200 && response.status < 300,
    `baseline webhook returned ${response.status}: ${response.body.slice(0, 500)}`);
  await databaseFixture("verify");
  console.log("GitHub onboarding rollback smoke passed: baseline 031 web fenced a current 032 binding");
} catch (error) {
  if (applicationCreated) {
    const logs = await docker(["logs", "--tail", "50", applicationContainer]).catch(() => "logs unavailable");
    console.error(redact(logs));
  }
  console.error(error instanceof Error ? redact(error.message) : "GitHub onboarding rollback smoke failed");
  process.exitCode = 1;
} finally {
  if (applicationCreated) await docker(["rm", "--force", "--volumes", applicationContainer]).catch(markCleanupFailure);
  if (postgresCreated) await docker(["rm", "--force", "--volumes", postgresContainer]).catch(markCleanupFailure);
  if (networkCreated) await docker(["network", "rm", network]).catch(markCleanupFailure);
  if (imageCreated) await docker(["image", "rm", "--force", image]).catch(markCleanupFailure);
  await rm(directory, { recursive: true, force: true });
}

async function databaseFixture(mode) {
  const fixture = join(root, "scripts/fixtures/github-onboarding-rollback-database.mjs");
  await docker(["run", "--rm", "--network", network,
    "--env", `DATABASE_HOST=${postgresContainer}`, "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env", `APP_PASSWORD=${appPassword}`, "--env", `ONBOARDING_PASSWORD=${onboardingPassword}`,
    "--env", `MAINTENANCE_PASSWORD=${maintenancePassword}`, "--env", `TENANT_ID=${tenantId}`,
    "--env", `BINDING_ID=${bindingId}`, "--env", `DELIVERY_ID=${deliveryId}`,
    "--volume", `${join(root, "node_modules")}:/workspace/node_modules:ro`,
    "--volume", `${join(root, "backend/node_modules")}:/workspace/backend/node_modules:ro`,
    "--volume", `${join(root, "backend/package.json")}:/workspace/backend/package.json:ro`,
    "--volume", `${join(root, "backend/dist")}:/workspace/backend/dist:ro`,
    "--volume", `${fixture}:/workspace/fixture.mjs:ro`,
    "node:22-alpine", "node", "/workspace/fixture.mjs", mode], mode === "setup" ? 180_000 : 30_000);
}

async function archiveBaseline(target) {
  await mkdir(target);
  await new Promise((resolvePromise, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", baseline], { cwd: root, env: environment });
    const extract = spawn("tar", ["-x", "-C", target], { env: environment });
    archive.stdout.pipe(extract.stdin);
    let error = "";
    archive.stderr.on("data", (chunk) => { error += chunk; });
    extract.stderr.on("data", (chunk) => { error += chunk; });
    let archiveStatus;
    let extractStatus;
    const finish = () => {
      if (archiveStatus === undefined || extractStatus === undefined) return;
      if (archiveStatus === 0 && extractStatus === 0) resolvePromise();
      else reject(new Error(`git archive extraction failed: ${error.slice(-2_000)}`));
    };
    archive.on("error", reject);
    extract.on("error", reject);
    archive.on("close", (status) => { archiveStatus = status; finish(); });
    extract.on("close", (status) => { extractStatus = status; finish(); });
  });
}

async function until(probe, label, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function dockerStatus(args) {
  try { return { ok: true, output: await docker(args) }; }
  catch { return { ok: false, output: "" }; }
}

function docker(args, timeout = 120_000) {
  return run("docker", args, { cwd: root, timeout });
}

async function run(file, args, options = {}) {
  try {
    const result = await promisify(execFile)(file, args, { cwd: options.cwd ?? root,
      env: environment, timeout: options.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${file} failed: ${redact(`${error.stdout ?? ""}\n${error.stderr ?? ""}`.slice(-5_000))}`);
  }
}

function redact(value) {
  let redacted = String(value);
  for (const secret of secrets) if (secret.length > 4) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted;
}

function markCleanupFailure(error) {
  console.error(`Rollback smoke cleanup failed: ${redact(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
}
