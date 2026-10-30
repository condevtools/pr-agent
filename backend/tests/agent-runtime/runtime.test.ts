import assert from "node:assert/strict";
import test from "node:test";

import { agentRuntimePoolConfig, validatePublicationCredentialOrigin, requireOnlinePublicationAuthority } from "../../src/agent-runtime/runtime.js";

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
  }), /Configure HARNESS/);
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
