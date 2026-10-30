import assert from "node:assert/strict";
import test from "node:test";

import { agentRuntimePoolConfig, resolveWorkerSchedulingConfiguration,
  validatePublicationCredentialOrigin, requireOnlinePublicationAuthority } from "../../src/agent-runtime/runtime.js";
import { githubOnboardingPoolConfig } from "../../src/agent-runtime/runtime/config.js";

test("Harness PostgreSQL configuration never inherits an unrelated DATABASE_URL", () => {
  assert.throws(() => agentRuntimePoolConfig({ DATABASE_URL: "postgres://unrelated/private" }), /Configure HARNESS/);
  assert.deepEqual(agentRuntimePoolConfig({
    HARNESS_PG_HOST: "postgres", HARNESS_PG_DATABASE: "pr_agent",
    HARNESS_PG_USER: "pr_agent_app", HARNESS_PG_PASSWORD: "local-test", HARNESS_PG_PORT: "5432",
  }), {
    host: "postgres", database: "pr_agent", user: "pr_agent_app", password: "local-test", port: 5432,
    max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15000,
  });
  assert.throws(() => agentRuntimePoolConfig({
    HARNESS_PG_HOST: "postgres", HARNESS_PG_DATABASE: "pr_agent",
    HARNESS_PG_USER: "pr_agent_app", HARNESS_PG_PASSWORD: "local-test", HARNESS_PG_PORT: "bad",
  }), /HARNESS_PG_PORT/);
});

test("runtime roles freeze independent bounded pool and scheduling capacities", () => {
  const base = { HARNESS_DATABASE_URL: "postgres://runtime:test@postgres/runtime" };
  assert.equal(agentRuntimePoolConfig(base, "web").max, 8);
  assert.equal(agentRuntimePoolConfig(base, "worker").max, 8);
  assert.equal(agentRuntimePoolConfig(base, "recovery").max, 4);
  assert.equal(agentRuntimePoolConfig({ ...base, HARNESS_WORKER_POOL_MAX: "12" }, "worker").max, 12);
  assert.throws(() => agentRuntimePoolConfig({ ...base, HARNESS_WORKER_POOL_MAX: "many" }, "worker"),
    /HARNESS_WORKER_POOL_MAX/);
  assert.deepEqual(resolveWorkerSchedulingConfiguration({}), {
    concurrency: 4,
    perBindingConcurrency: 2,
    specialConcurrency: 1,
    recoveryBindingPageSize: 32,
  });
  assert.throws(() => resolveWorkerSchedulingConfiguration({ HARNESS_WORKER_CONCURRENCY: "1" }),
    /between 2 and 16/);
  assert.throws(() => resolveWorkerSchedulingConfiguration({
    HARNESS_WORKER_CONCURRENCY: "4", HARNESS_WORKER_SPECIAL_CONCURRENCY: "4",
  }), /between 1 and 3/);
});

test("GitHub onboarding uses a separate small restricted-role pool", () => {
  const environment = {
    FEATURE_GITHUB_ONBOARDING: "on", HARNESS_ONBOARDING_PG_PASSWORD: "onboarding-password",
    HARNESS_PG_HOST: "postgres", HARNESS_PG_DATABASE: "pr_agent", HARNESS_PG_PORT: "5432",
    HARNESS_PG_USER: "pr_agent_app", HARNESS_PG_PASSWORD: "app-password",
  };
  assert.deepEqual(githubOnboardingPoolConfig(environment), {
    host: "postgres", database: "pr_agent", port: 5432,
    user: "pr_agent_onboarding", password: "onboarding-password", max: 2,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15000,
  });
  assert.throws(() => githubOnboardingPoolConfig({ ...environment,
    FEATURE_GITHUB_ONBOARDING: "off" }), /disabled/u);
  assert.throws(() => githubOnboardingPoolConfig({ ...environment,
    HARNESS_DATABASE_URL: "postgres://app:secret@postgres/pr_agent" }), /explicit PostgreSQL/u);
});

test("a server credential cannot be sent to a different binding origin", () => {
  const binding = { platform: "github" as const, repository: "org/repo", origin: "https://api.github.com" };
  assert.doesNotThrow(() => validatePublicationCredentialOrigin(binding, {}));
  assert.throws(() => validatePublicationCredentialOrigin({ ...binding, origin: "https://other.example" }, {}), /credential destination/);
  assert.doesNotThrow(() => validatePublicationCredentialOrigin({ ...binding, origin: "https://ghe.example/api/v3" }, { GITHUB_API_URL: "https://ghe.example/api/v3/" }));
});

test("publication authority only accepts the PostgreSQL mode", () => {
  const previous = process.env.HARNESS_PUBLICATION_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.HARNESS_PUBLICATION_MODE;
    assert.doesNotThrow(requireOnlinePublicationAuthority);
    process.env.HARNESS_PUBLICATION_MODE = "postgres";
    assert.doesNotThrow(requireOnlinePublicationAuthority);
    process.env.HARNESS_PUBLICATION_MODE = "disabled";
    assert.throws(requireOnlinePublicationAuthority, /only supports postgres/);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_PUBLICATION_MODE;
    else process.env.HARNESS_PUBLICATION_MODE = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("a live server rejects a non-PostgreSQL mode", () => {
  process.env.HARNESS_PUBLICATION_MODE = "postgres";
  requireOnlinePublicationAuthority();
  process.env.HARNESS_PUBLICATION_MODE = "disabled";
  assert.throws(requireOnlinePublicationAuthority, /only supports postgres/);
  delete process.env.HARNESS_PUBLICATION_MODE;
  assert.doesNotThrow(requireOnlinePublicationAuthority);
});
