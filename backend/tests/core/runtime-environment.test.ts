import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getModelExecutionPolicy } from "../../src/agent-runtime/budget/model-budget-store.js";
import { readNumberEnv, validateRuntimeEnvironment } from "../../src/core/index.js";

const database = { HARNESS_DATABASE_URL: "postgres://runtime:secret@postgres/runtime" };
const worker = { ...database, AI_PROVIDER: "openai-compatible", AI_MODEL: "fixture",
  OPENAI_COMPATIBLE_API_KEY: "model-secret", OPENAI_BASE_URL: "https://models.example/v1",
  HARNESS_MODEL_PRICING_JSON: "{}" };
const web = worker;

test("runtime environment profiles validate only their required dependencies", () => {
  assert.doesNotThrow(() => validateRuntimeEnvironment(database, "recovery"));
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...database,
    RUNTIME_HEARTBEAT_INTERVAL_MS: "not-used-by-admin" }, "admin"));
  assert.throws(() => validateRuntimeEnvironment({ ...worker,
    OPENAI_COMPATIBLE_API_KEY: undefined }, "worker"), /OPENAI_COMPATIBLE_API_KEY/u);
  assert.doesNotThrow(() => validateRuntimeEnvironment(worker, "worker"));
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...worker,
    OPENAI_COMPATIBLE_API_KEY: undefined }, "web"));
  assert.throws(() => validateRuntimeEnvironment({ ...worker, HARNESS_WORKER_CONCURRENCY: "many" }, "worker"),
    /HARNESS_WORKER_CONCURRENCY/u);
  assert.throws(() => validateRuntimeEnvironment({ ...database, FIX_POLICY_REGISTRY_JSON: undefined }, "verifier"),
    /FIX_POLICY_REGISTRY_JSON/u);
});

test("all publication credential consumers reject conflicting GitHub App key sources", () => {
  for (const profile of ["web", "worker", "recovery"] as const) {
    const source = profile === "worker" ? worker : profile === "web" ? web : database;
    assert.throws(() => validateRuntimeEnvironment({ ...source, APP_ID: "1", WEBHOOK_SECRET: "hook",
      PRIVATE_KEY: "inline", PRIVATE_KEY_PATH: "/run/secrets/key" }, profile), /PRIVATE_KEY/u);
  }
});

test("non-web health profiles ignore an unrelated invalid HTTP port", () => {
  assert.doesNotThrow(() => validateRuntimeEnvironment({ PORT: "invalid" }, "health", { healthRole: "maintenance" }));
  assert.throws(() => validateRuntimeEnvironment({ PORT: "invalid" }, "health", { healthRole: "web" }), /PORT/u);
});

test("web credential sources and numeric limits fail fast without exposing values", () => {
  assert.throws(() => validateRuntimeEnvironment({ ...web, PRIVATE_KEY: "private-value",
    PRIVATE_KEY_PATH: "/run/secrets/key" }, "web"), (error: unknown) => {
    assert.doesNotMatch(String(error), /private-value/u); return /PRIVATE_KEY/u.test(String(error));
  });
  assert.throws(() => validateRuntimeEnvironment({ ...web, WEBHOOK_BODY_LIMIT: "1gb" }, "web"),
    /WEBHOOK_BODY_LIMIT/u);
  assert.equal(validateRuntimeEnvironment({ ...web, PORT: "8080", WEBHOOK_BODY_LIMIT: "2mb" }, "web")
    .http?.port, 8080);
  assert.throws(() => validateRuntimeEnvironment({ ...web, NODE_ENV: "production",
    GITHUB_WEBHOOK_SKIP_SIGNATURE: "true" }, "web"), /GITHUB_WEBHOOK_SKIP_SIGNATURE/u);
  assert.throws(() => validateRuntimeEnvironment({ ...web, GITLAB_TOKEN: "token" }, "web"),
    /GITLAB_WEBHOOK_SECRET/u);
});

test("maintenance policy is bounded, ordered, and preview by default", () => {
  const configuration = validateRuntimeEnvironment(database, "maintenance");
  assert.deepEqual(configuration.maintenance, { mode: "preview", intervalMs: 60_000,
    batchLimit: 100, contentDays: 30, replayDays: 90, traceDays: 400 });
  assert.equal(configuration.poolMax, 4);
  assert.throws(() => validateRuntimeEnvironment({ ...database,
    HARNESS_MAINTENANCE_CONTENT_DAYS: "90", HARNESS_MAINTENANCE_REPLAY_DAYS: "30" }, "maintenance"),
  /CONTENT_DAYS/u);
  assert.throws(() => validateRuntimeEnvironment({ ...database, HARNESS_MAINTENANCE_MODE: "delete" }, "maintenance"),
    /MAINTENANCE_MODE/u);
});

test("configured numeric environment values no longer silently fall back", () => {
  const before = process.env.TEST_STRICT_NUMBER;
  try {
    process.env.TEST_STRICT_NUMBER = "invalid";
    assert.throws(() => readNumberEnv("TEST_STRICT_NUMBER", 10), /TEST_STRICT_NUMBER/u);
  } finally {
    if (before === undefined) delete process.env.TEST_STRICT_NUMBER;
    else process.env.TEST_STRICT_NUMBER = before;
  }
});

test("live review numeric settings are rejected during role startup", () => {
  for (const [name, configured] of [
    ["GITHUB_INCREMENTAL_STATE_TTL_MS", "invalid"],
    ["GITLAB_POLICY_CONFIG_CACHE_TTL_MS", "999999999999"],
    ["GITHUB_GUIDELINE_CACHE_TTL_MS", "0"],
    ["NOTIFY_HTTP_TIMEOUT_MS", "50"],
    ["NOTIFY_HTTP_RETRIES", "-1"],
  ] as const) {
    assert.throws(() => validateRuntimeEnvironment({ ...worker, [name]: configured }, "worker"),
      new RegExp(name, "u"));
  }
  assert.throws(() => validateRuntimeEnvironment({ ...web, FEATURE_FIX: "on",
    FIX_DEFAULT_POLICY_ID: "fixture", FIX_POLICY_REGISTRY_JSON: "{}",
    FIX_APPROVAL_TTL_SECONDS: "299" }, "web"), /FIX_APPROVAL_TTL_SECONDS/u);
});

test("environment examples become valid runtime and pricing profiles after placeholder replacement", () => {
  for (const file of [".env.example", ".env.github-app.min.example",
    ".env.github-webhook.min.example", ".env.gitlab.min.example"]) {
    const env = exampleEnvironment(file);
    assert.doesNotThrow(() => validateRuntimeEnvironment(env, "web"), `${file} web profile`);
    assert.doesNotThrow(() => validateRuntimeEnvironment(env, "worker"), `${file} worker profile`);
    const policy = getModelExecutionPolicy("openai", "gpt-4.1-mini", env);
    assert.equal(policy.version, "example-only-v1", file);
    assert.ok(policy.rates.inputMicrosPerMillion > 0, file);
    assert.ok(policy.tenantLimits.costMicros > 0, file);
    assert.ok(policy.runLimits.costMicros > 0, file);
  }

  const env = exampleEnvironment(".env.example");
  for (const [provider, model] of [["openai", "gpt-4.1-mini"],
    ["openai-compatible", "deepseek-chat"], ["anthropic", "claude-3-5-haiku-latest"],
    ["gemini", "gemini-2.0-flash"]] as const) {
    const policy = getModelExecutionPolicy(provider, model, env);
    assert.ok(Object.values(policy.rates).every((rate) => rate > 0), `${provider}:${model} rates`);
  }
  assert.equal(getModelExecutionPolicy("openai-compatible", "deepseek-chat", env)
    .openAiTokenParameter, "max_tokens");
});

function exampleEnvironment(file: string): NodeJS.ProcessEnv {
  const text = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
  const env: NodeJS.ProcessEnv = { HARNESS_DATABASE_URL: "postgres://fixture:fixture@postgres/pr_agent" };
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = /replace-with|YOUR_PRIVATE_KEY|\.\.\./u.test(value) ? `fixture-${key.toLowerCase()}` : value;
  }
  return env;
}
