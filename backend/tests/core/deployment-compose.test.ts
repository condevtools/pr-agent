import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

test("application Compose isolates credentials, process roles, and container privileges", {
  skip: composeAvailable ? false : "docker compose is unavailable",
}, () => {
  const secrets = {
    bootstrap: "sentinel-bootstrap-only",
    migration: "sentinel-migration-only",
    app: "sentinel-app-only",
    verifier: "sentinel-verifier-only",
    maintenance: "sentinel-maintenance-only",
    onboarding: "sentinel-onboarding-web-and-postgres-only",
  };
  const result = spawnSync("docker",
    ["compose", "--env-file", "/dev/null", "-f", "docker-compose.yml",
      "config", "--format", "json"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 30_000,
      env: compactEnvironment({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
        HARNESS_BOOTSTRAP_PASSWORD: secrets.bootstrap,
        HARNESS_MIGRATION_PASSWORD: secrets.migration,
        HARNESS_APP_PASSWORD: secrets.app,
        HARNESS_VERIFIER_PASSWORD: secrets.verifier,
        HARNESS_MAINTENANCE_PASSWORD: secrets.maintenance,
        HARNESS_ONBOARDING_PASSWORD: secrets.onboarding,
        APP_ID: "runtime-app-id",
        PRIVATE_KEY: "runtime-inline-private-key",
        WEBHOOK_SECRET: "runtime-webhook-secret",
        OPENAI_API_KEY: "sentinel-openai-worker-only",
        OPENAI_COMPATIBLE_API_KEY: "sentinel-compatible-worker-only",
        ANTHROPIC_API_KEY: "sentinel-anthropic-worker-only",
        GEMINI_API_KEY: "sentinel-gemini-worker-only",
        LANGFUSE_ENABLED: "on",
        LANGFUSE_BASE_URL: "https://langfuse.example.test",
        LANGFUSE_ALLOW_INSECURE_HTTP: "false",
        LANGFUSE_PUBLIC_KEY: "sentinel-langfuse-public-worker-only",
        LANGFUSE_SECRET_KEY: "sentinel-langfuse-secret-worker-only",
        LANGFUSE_CAPTURE_CONTENT: "redacted",
        LANGFUSE_TRACING_ENVIRONMENT: "compose-test",
        LANGFUSE_RELEASE: "sha-compose-test",
        HARNESS_API_PRINCIPALS_JSON: "sentinel-web-principals-only",
        GITHUB_TOKEN: "runtime-github-token",
        GITLAB_TOKEN: "runtime-gitlab-token",
        GITHUB_APP_PRIVATE_KEY_FILE: "/definitely/missing.pem",
        HTTP_TIMEOUT_MS: "12345",
        HEALTHCHECK_AI_TIMEOUT_MS: "sentinel-dead-health-timeout",
        HEALTHCHECK_AI_LIVE_PROBE: "sentinel-dead-health-probe",
        HARNESS_MODEL_PRICING_JSON: '{"version":"runtime-pricing"}',
      }),
    });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout) as { services: Record<string, {
    environment?: Record<string, string>; env_file?: unknown;
    user?: string; read_only?: boolean; cap_drop?: string[]; security_opt?: string[];
    volumes?: Array<{ source?: string; target?: string }>; ports?: unknown[];
    secrets?: Array<{ source?: string; target?: string; mode?: string | number }>;
    command?: string[];
    depends_on?: Record<string, { condition?: string }>;
  }> };
  const services = config.services;
  assert.deepEqual(Object.keys(services).sort(),
    ["database-init", "maintenance", "onboarding-role-init", "postgres", "pr-agent", "recovery", "worker"]);
  assert.deepEqual(servicesContaining(services, secrets.bootstrap), ["onboarding-role-init", "postgres"]);
  assert.deepEqual(servicesContaining(services, secrets.migration), ["database-init", "postgres"]);
  assert.deepEqual(servicesContaining(services, secrets.app), ["postgres", "pr-agent", "recovery", "worker"]);
  assert.deepEqual(servicesContaining(services, secrets.verifier), ["postgres"]);
  assert.deepEqual(servicesContaining(services, secrets.maintenance), ["maintenance", "postgres"]);
  assert.deepEqual(servicesContaining(services, secrets.onboarding), ["onboarding-role-init", "postgres", "pr-agent"]);

  const app = services["pr-agent"]!.environment!;
  assert.equal(app.APP_ID, "runtime-app-id");
  assert.equal(app.PRIVATE_KEY, "runtime-inline-private-key");
  assert.equal(app.PRIVATE_KEY_PATH, "");
  assert.equal(app.WEBHOOK_SECRET, "runtime-webhook-secret");
  assert.equal(app.OPENAI_API_KEY, undefined);
  assert.equal(app.GITHUB_TOKEN, "runtime-github-token");
  assert.equal(app.GITLAB_TOKEN, "runtime-gitlab-token");
  assert.equal(app.HTTP_TIMEOUT_MS, "12345");
  assert.equal(app.HARNESS_MODEL_PRICING_JSON, '{"version":"runtime-pricing"}');
  assert.equal(app.HARNESS_PG_PASSWORD, secrets.app);
  assert.equal(app.HARNESS_ONBOARDING_PG_PASSWORD, secrets.onboarding);
  assert.equal(app.FEATURE_GITHUB_ONBOARDING, "auto");
  assert.equal(services.worker!.environment!.HARNESS_ONBOARDING_PG_PASSWORD, undefined);
  assert.equal(services.recovery!.environment!.HARNESS_ONBOARDING_PG_PASSWORD, undefined);
  assert.equal(services["database-init"]!.environment!.HARNESS_PG_PASSWORD, secrets.migration);
  assert.equal(services["onboarding-role-init"]!.environment!.PGPASSWORD, secrets.bootstrap);
  assert.equal(services["onboarding-role-init"]!.environment!.HARNESS_ONBOARDING_PASSWORD, secrets.onboarding);
  assert.equal(services["onboarding-role-init"]!.depends_on?.["database-init"]?.condition,
    "service_completed_successfully");
  assert.equal(services["pr-agent"]!.depends_on?.["onboarding-role-init"]?.condition,
    "service_completed_successfully");
  assert.equal(services["pr-agent"]!.environment!.PR_AGENT_PROCESS_ROLE, "web");
  assert.equal(services.worker!.environment!.PR_AGENT_PROCESS_ROLE, "worker");
  assert.equal(services.recovery!.environment!.PR_AGENT_PROCESS_ROLE, "recovery");
  assert.equal(services.maintenance!.environment!.PR_AGENT_PROCESS_ROLE, "maintenance");
  assert.equal(services.maintenance!.environment!.HARNESS_PG_USER, "pr_agent_maintenance");
  assert.equal(services.maintenance!.environment!.HARNESS_DATABASE_URL, "");
  assert.deepEqual(services.maintenance!.command, ["node", "dist/agent-runtime/maintenance-process.js"]);
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_MODE, "preview");
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_INTERVAL_MS, "60000");
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_BATCH_LIMIT, "100");
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_CONTENT_DAYS, "30");
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_REPLAY_DAYS, "90");
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_TRACE_DAYS, "400");
  assert.equal(services.maintenance!.environment!.HARNESS_MAINTENANCE_POOL_MAX, "4");
  assert.deepEqual(servicesContaining(services, "sentinel-openai-worker-only"), ["worker"]);
  assert.deepEqual(servicesContaining(services, "sentinel-compatible-worker-only"), ["worker"]);
  assert.deepEqual(servicesContaining(services, "sentinel-anthropic-worker-only"), ["worker"]);
  assert.deepEqual(servicesContaining(services, "sentinel-gemini-worker-only"), ["worker"]);
  assert.deepEqual(servicesContaining(services, "sentinel-langfuse-public-worker-only"), ["worker"]);
  assert.deepEqual(servicesContaining(services, "sentinel-langfuse-secret-worker-only"), ["worker"]);
  assert.equal(services.worker!.environment!.LANGFUSE_ENABLED, "on");
  assert.equal(services.worker!.environment!.LANGFUSE_BASE_URL, "https://langfuse.example.test");
  assert.equal(services.worker!.environment!.LANGFUSE_ALLOW_INSECURE_HTTP, "false");
  assert.equal(services.worker!.environment!.LANGFUSE_CAPTURE_CONTENT, "redacted");
  assert.equal(services.worker!.environment!.LANGFUSE_TRACING_ENVIRONMENT, "compose-test");
  assert.equal(services.worker!.environment!.LANGFUSE_RELEASE, "sha-compose-test");
  for (const name of ["pr-agent", "recovery", "maintenance", "database-init", "onboarding-role-init", "postgres"]) {
    const environment = services[name]!.environment ?? {};
    assert.equal(environment.LANGFUSE_PUBLIC_KEY, undefined);
    assert.equal(environment.LANGFUSE_SECRET_KEY, undefined);
  }
  assert.deepEqual(servicesContaining(services, "sentinel-web-principals-only"), ["pr-agent"]);
  assert.deepEqual(servicesContaining(services, "sentinel-dead-health-timeout"), []);
  assert.deepEqual(servicesContaining(services, "sentinel-dead-health-probe"), []);
  assert.ok((services["pr-agent"]!.ports?.length ?? 0) > 0);
  assert.equal(services.worker!.ports, undefined);
  assert.equal(services.recovery!.ports, undefined);
  assert.equal(services.maintenance!.ports, undefined);

  for (const name of ["pr-agent", "worker", "recovery", "maintenance", "database-init"]) {
    const service = services[name]!;
    assert.equal("env_file" in service, false);
    assert.equal(service.user, "10001:10001");
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.ok(service.security_opt?.includes("no-new-privileges:true"));
    assert.equal(JSON.stringify(service.volumes ?? []).includes("docker.sock"), false);
    assert.equal(JSON.stringify(service.volumes ?? []).includes("snapshot"), false);
  }
  for (const name of ["pr-agent", "worker", "recovery"]) assert.equal(services[name]!.secrets, undefined);
  const maintenance = JSON.stringify(services.maintenance!.environment ?? {});
  for (const forbidden of ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET", "OPENAI_API_KEY", "GITHUB_TOKEN",
    "GITLAB_TOKEN", "HARNESS_VERIFIER_PASSWORD", "FIX_POLICY_REGISTRY_JSON"]) {
    assert.equal(maintenance.includes(forbidden), false);
  }
});

test("optional PEM overlay clears inline key and mounts the fixed-UID-readable secret path", {
  skip: composeAvailable ? false : "docker compose is unavailable",
}, () => {
  const result = spawnSync("docker", ["compose", "--env-file", "/dev/null", "-f", "docker-compose.yml",
    "-f", "docker-compose.secret-file.yml", "config", "--format", "json"], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 30_000,
    env: compactEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG, HARNESS_BOOTSTRAP_PASSWORD: "bootstrap",
      HARNESS_MIGRATION_PASSWORD: "migration", HARNESS_APP_PASSWORD: "app",
      HARNESS_VERIFIER_PASSWORD: "verifier", HARNESS_MAINTENANCE_PASSWORD: "maintenance",
      APP_ID: "overlay-app-id", PRIVATE_KEY: "must-be-cleared" }),
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout) as { services: Record<string, {
    environment?: Record<string, string>; user?: string;
    secrets?: Array<{ source?: string; target?: string; uid?: string; gid?: string; mode?: string | number }>;
  }> };
  for (const name of ["pr-agent", "worker", "recovery"]) {
    const service = config.services[name]!;
    assert.equal(service.user, "10001:10001");
    assert.equal(service.environment?.PRIVATE_KEY, "");
    assert.equal(service.environment?.PRIVATE_KEY_PATH, "/run/secrets/github-app-private-key.pem");
    assert.equal(service.environment?.APP_ID, "overlay-app-id");
    assert.ok(service.secrets?.some((secret) => secret.source === "github-app-private-key"
      && secret.target === "/run/secrets/github-app-private-key.pem"
      && secret.uid === "10001" && secret.gid === "10001" && String(secret.mode) === "0400"));
  }
});

test("isolated verifier operator is a separate no-HTTP deployment with no provider credentials", {
  skip: composeAvailable ? false : "docker compose is unavailable",
}, () => {
  const result = spawnSync("docker", ["compose", "--env-file", "/dev/null",
    "-f", "docker-compose.verifier-operator.yml", "config", "--format", "json"], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 30_000,
    env: compactEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
      HARNESS_VERIFIER_DATABASE_URL: "postgresql://verifier:secret@database.invalid/pr_agent",
      VERIFIER_DOCKER_GID: "998", FIX_POLICY_REGISTRY_JSON: '{"policies":[]}' }),
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout) as { services: Record<string, {
    environment?: Record<string, string>; ports?: unknown[]; user?: string; read_only?: boolean;
    cap_drop?: string[]; security_opt?: string[]; group_add?: string[];
    volumes?: Array<{ source?: string; target?: string; read_only?: boolean }>;
  }> };
  assert.deepEqual(Object.keys(config.services), ["verifier-operator"]);
  const operator = config.services["verifier-operator"]!;
  assert.equal(operator.ports, undefined);
  assert.equal(operator.user, "10001:10001");
  assert.equal(operator.read_only, true);
  assert.deepEqual(operator.cap_drop, ["ALL"]);
  assert.ok(operator.security_opt?.includes("no-new-privileges:true"));
  assert.ok(operator.group_add?.includes("998"));
  assert.ok(operator.volumes?.some((volume) => volume.source === "/var/run/docker.sock"
    && volume.target === "/var/run/docker.sock"));
  const serialized = JSON.stringify(operator.environment ?? {});
  for (const forbidden of ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET", "OPENAI_API_KEY", "GITHUB_TOKEN", "GITLAB_TOKEN"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("container build contracts pin non-root runtime and sandbox users", () => {
  const dockerfile = readFileSync(`${repositoryRoot}/Dockerfile`, "utf8");
  const ignored = new Set(readFileSync(`${repositoryRoot}/.dockerignore`, "utf8")
    .split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean));
  const runtime = dockerStage(dockerfile, "runtime");
  const sandbox = dockerStage(dockerfile, "verifier-sandbox");
  const verifier = dockerStage(dockerfile, "verifier");
  assert.match(runtime, /USER 10001:10001/u);
  assert.match(runtime, /HEALTHCHECK[\s\S]*dist\/agent-runtime\/health-cli\.js/u);
  assert.doesNotMatch(runtime, /docker-cli|pnpm install/u);
  assert.match(sandbox, /USER 65532:65532/u);
  assert.match(sandbox, /chown -R 65532:65532 \/opt\/pr-agent-verifier \/seed/u);
  assert.match(verifier, /apk add --no-cache docker-cli[\s\S]*USER 10001:10001/u);
  for (const excluded of [".env", ".env.*", ".git", ".codex", ".omx*", "secrets", "frontend", "backend/tests"]) {
    assert.ok(ignored.has(excluded), `Docker build context must exclude ${excluded}`);
  }
});

test("CI is read-only, SHA-pinned, provider-secret-free, and exercises production gates", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8");
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\./u);
  assert.doesNotMatch(workflow, /^\s*push:\s*true\s*$/mu);
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1]!);
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/u, `action must use a full commit SHA: ${reference}`);
  }
  for (const required of ["pnpm --filter backend check", "pnpm --filter backend build",
    "pnpm --filter backend test", "pnpm --filter backend test:harness:pg",
    "pnpm --filter frontend lint", "pnpm --filter frontend build",
    "node scripts/compose-smoke.mjs", "FIX_VERIFIER_SANDBOX_IMAGE_DIGEST",
    "target: [default, verifier, verifier-sandbox]",
    "platforms: linux/amd64,linux/arm64", "outputs: type=cacheonly"]) {
    assert.ok(workflow.includes(required), `CI must include ${required}`);
  }
});

function servicesContaining(
  services: Record<string, { environment?: Record<string, string> }>,
  secret: string,
): string[] {
  return Object.entries(services)
    .filter(([, service]) => Object.values(service.environment ?? {}).includes(secret))
    .map(([name]) => name)
    .sort();
}

function compactEnvironment(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function dockerStage(dockerfile: string, name: string): string {
  const marker = new RegExp(`^FROM .+ AS ${name}$`, "mu");
  const match = marker.exec(dockerfile);
  assert.ok(match, `missing Docker stage ${name}`);
  const start = match.index;
  const next = dockerfile.slice(start + match[0].length).search(/^FROM /mu);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + match[0].length + next);
}
