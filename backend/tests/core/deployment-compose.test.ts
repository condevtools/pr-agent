import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

test("Compose isolates database role credentials while preserving runtime configuration", {
  skip: composeAvailable ? false : "docker compose is unavailable",
}, () => {
  const secrets = {
    bootstrap: "sentinel-bootstrap-only",
    migration: "sentinel-migration-only",
    app: "sentinel-app-only",
    verifier: "sentinel-verifier-only",
  };
  const result = spawnSync("docker",
    ["compose", "--env-file", "/dev/null", "-f", "docker-compose.yml", "--profile", "verifier",
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
        APP_ID: "runtime-app-id",
        WEBHOOK_SECRET: "runtime-webhook-secret",
        OPENAI_API_KEY: "runtime-openai-key",
        GITHUB_TOKEN: "runtime-github-token",
        GITLAB_TOKEN: "runtime-gitlab-token",
        HTTP_TIMEOUT_MS: "12345",
        HARNESS_MODEL_PRICING_JSON: '{"version":"runtime-pricing"}',
      }),
    });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout) as { services: Record<string, {
    environment?: Record<string, string>; env_file?: unknown;
  }> };
  const services = config.services;
  assert.equal("env_file" in services["pr-agent"]!, false);
  assert.deepEqual(servicesContaining(services, secrets.bootstrap), ["postgres"]);
  assert.deepEqual(servicesContaining(services, secrets.migration), ["database-init", "postgres"]);
  assert.deepEqual(servicesContaining(services, secrets.app), ["postgres", "pr-agent"]);
  assert.deepEqual(servicesContaining(services, secrets.verifier), ["postgres", "verifier"]);

  const app = services["pr-agent"]!.environment!;
  assert.equal(app.APP_ID, "runtime-app-id");
  assert.equal(app.WEBHOOK_SECRET, "runtime-webhook-secret");
  assert.equal(app.OPENAI_API_KEY, "runtime-openai-key");
  assert.equal(app.GITHUB_TOKEN, "runtime-github-token");
  assert.equal(app.GITLAB_TOKEN, "runtime-gitlab-token");
  assert.equal(app.HTTP_TIMEOUT_MS, "12345");
  assert.equal(app.HARNESS_MODEL_PRICING_JSON, '{"version":"runtime-pricing"}');
  assert.equal(app.HARNESS_PG_PASSWORD, secrets.app);
  assert.equal(services["database-init"]!.environment!.HARNESS_PG_PASSWORD, secrets.migration);
  assert.equal(services.verifier!.environment!.HARNESS_PG_PASSWORD, secrets.verifier);
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
