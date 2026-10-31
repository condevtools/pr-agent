import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { SpanContext } from "@opentelemetry/api";

import {
  createAgentObservability, observeAgentOperation, sanitizeObservationValue, withAgentObservability,
  sanitizeObservationMaskValue,
  type AgentObservationAttributes, type AgentObservationDriver, type AgentObservationType,
} from "../../src/observability/index.js";

test("disabled observability executes business action exactly once", async () => {
  const adapter = createAgentObservability({ env: { LANGFUSE_ENABLED: "off" } });
  let calls = 0;
  const value = await withAgentObservability(adapter, () => observeAgentOperation(
    "review-run", "agent", { input: "private" }, async (handle) => {
      calls += 1;
      assert.equal(handle.traceId, undefined);
      return 42;
    },
  ));
  assert.equal(value, 42);
  assert.equal(calls, 1);
});

test("auto mode without credentials and invalid enabled mode stay disabled", async () => {
  const driver = new RecordingDriver();
  const automatic = createAgentObservability({ env: {}, driver });
  const invalid = createAgentObservability({ env: {
    ...enabledEnv(), LANGFUSE_ENABLED: "enabled",
  }, driver });
  await automatic.observe("run", "agent", {}, async () => undefined);
  await invalid.observe("run", "agent", {}, async () => undefined);
  assert.equal(automatic.enabled, false);
  assert.equal(invalid.enabled, false);
  assert.equal(driver.records.length, 0);
});

test("partially configured auto mode warns without leaking configuration values", (t) => {
  const logs: string[] = [];
  t.mock.method(console, "warn", (message: string) => logs.push(message));
  const adapter = createAgentObservability({ env: { LANGFUSE_ENABLED: "auto",
    LANGFUSE_SECRET_KEY: "secret-value-should-not-be-logged" }, driver: new RecordingDriver() });
  assert.equal(adapter.enabled, false);
  assert.ok(logs.some((log) => log.includes("observability.configuration_invalid")));
  assert.ok(!logs.join("").includes("secret-value-should-not-be-logged"));
});

test("invalid endpoint credentials and SDK construction failure disable telemetry", async () => {
  const driver = new RecordingDriver();
  const credentialUrl = createAgentObservability({ env: {
    ...enabledEnv(), LANGFUSE_BASE_URL: "https://user:password@langfuse.example.test",
  }, driver });
  const throwingOptions = { env: enabledEnv() } as { env: NodeJS.ProcessEnv; driver?: AgentObservationDriver };
  Object.defineProperty(throwingOptions, "driver", { get() { throw new Error("constructor failure"); } });
  const failed = createAgentObservability(throwingOptions);
  assert.equal(credentialUrl.enabled, false);
  assert.equal(failed.enabled, false);
});

test("public plaintext Langfuse requires an explicit override", async () => {
  const driver = new RecordingDriver();
  const blocked = createAgentObservability({ env: {
    ...enabledEnv(), LANGFUSE_BASE_URL: "http://langfuse.example.test",
  }, driver });
  const allowed = createAgentObservability({ env: {
    ...enabledEnv(), LANGFUSE_BASE_URL: "http://langfuse.example.test",
    LANGFUSE_ALLOW_INSECURE_HTTP: "true",
  }, driver });
  assert.equal(blocked.enabled, false);
  assert.equal(allowed.enabled, true);
  await allowed.shutdown();
});

test("nested concurrent operations preserve branch parents", async () => {
  const driver = new RecordingDriver();
  const adapter = createAgentObservability({ env: enabledEnv(), driver });
  await withAgentObservability(adapter, () => observeAgentOperation(
    "run-attempt", "agent", {}, async () => Promise.all([
      observeAgentOperation("security", "agent", {}, async () => {
        await Promise.resolve();
        await observeAgentOperation("security-model", "generation", {}, async () => undefined);
      }),
      observeAgentOperation("correctness", "agent", {}, async () => {
        await Promise.resolve();
        await observeAgentOperation("correctness-model", "generation", {}, async () => undefined);
      }),
    ]),
    { root: true, sessionId: "run-1" },
  ));

  assert.equal(driver.records[0]?.sessionId, "run-1");
  assert.equal(driver.records[1]?.parentSpanId, "0000000000000001");
  assert.equal(driver.records[2]?.parentSpanId, "0000000000000001");
  assert.equal(driver.records[3]?.parentSpanId, "0000000000000002");
  assert.equal(driver.records[4]?.parentSpanId, "0000000000000003");
});

test("tracer failures do not replay or replace business behavior", async () => {
  const unavailable = createAgentObservability({
    env: enabledEnv(), driver: new RecordingDriver({ failStart: true }),
  });
  let calls = 0;
  assert.equal(await unavailable.observe("run", "agent", {}, async () => {
    calls += 1;
    return "done";
  }), "done");

  const hostile = createAgentObservability({
    env: enabledEnv(), driver: new RecordingDriver({ failUpdate: true, failEnd: true }),
  });
  await assert.rejects(hostile.observe("run", "agent", {}, async (handle) => {
    calls += 1;
    handle.update({ output: "secret" });
    throw new TypeError("business failure includes secret");
  }), TypeError);
  assert.equal(calls, 2);
});

test("content capture is opt-in and metadata updates merge", async () => {
  const offDriver = new RecordingDriver();
  const off = createAgentObservability({ env: enabledEnv(), driver: offDriver });
  await off.observe("model", "generation", {
    input: "private", output: "private", metadata: { workflow: "review.single.v1" },
    model: "fixture-model", usageDetails: { input: 10, invalid: -1 },
  }, async (handle) => {
    handle.update({ metadata: { settlementStatus: "settled" } });
  });
  assert.deepEqual(offDriver.records[0]?.initial, {
    metadata: { workflow: "review.single.v1" }, model: "fixture-model", usageDetails: { input: 10 },
  });
  assert.deepEqual(offDriver.records[0]?.updates[0]?.metadata, {
    workflow: "review.single.v1", settlementStatus: "settled",
  });

  const onDriver = new RecordingDriver();
  const on = createAgentObservability({
    env: { ...enabledEnv(), LANGFUSE_CAPTURE_CONTENT: "redacted" }, driver: onDriver,
  });
  await on.observe("model", "generation", {
    input: { prompt: "Bearer visible-token-value", apiKey: "never-export" }, output: "ok",
  }, async () => undefined);
  assert.deepEqual(onDriver.records[0]?.initial, {
    input: { prompt: "Bearer [REDACTED]", apiKey: "[REDACTED]" }, output: "ok",
  });
});

test("privacy sanitizer handles secrets, credential URLs, cycles and bounds", () => {
  const cyclic: Record<string, unknown> = {
    key: "configured-secret-value", url: "https://alice:password@example.com/path",
    privateKey: "hidden", huge: "x".repeat(40_000),
  };
  cyclic.self = cyclic;
  const serialized = JSON.stringify(sanitizeObservationValue(cyclic, {
    LANGFUSE_SECRET_KEY: "configured-secret-value",
  }));
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 16 * 1024);
  assert.ok(!serialized.includes("configured-secret-value"));
  assert.ok(!serialized.includes("alice:password"));
  assert.ok(serialized.includes("[REDACTED]"));
});

test("compound credential suffixes are redacted and escaped previews stay within the byte budget", () => {
  assert.deepEqual(sanitizeObservationValue({ myApiKey: "credential", githubAccessToken: "credential",
    databasePassword: "credential", nestedClientSecret: "credential", tokenUsage: 4, inputTokens: 2 }), {
    myApiKey: "[REDACTED]", githubAccessToken: "[REDACTED]", databasePassword: "[REDACTED]",
    nestedClientSecret: "[REDACTED]", tokenUsage: 4, inputTokens: 2,
  });
  const large = sanitizeObservationValue({ text: '\\"\n中'.repeat(10_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") <= 16 * 1024);
});

test("compound credential keys redact without hiding token usage metrics", () => {
  const sanitized = sanitizeObservationValue({
    accessToken: "access-value", clientSecret: "client-value", refresh_token: "refresh-value",
    sessionCookie: "cookie-value", tokenUsage: 17, inputTokens: 11,
    connection: "postgres://db-user:db-pass@postgres/pr_agent",
  }, { HARNESS_DATABASE_URL: "postgres://db-user:db-pass@postgres/pr_agent" });
  assert.deepEqual(sanitized, {
    accessToken: "[REDACTED]", clientSecret: "[REDACTED]", refresh_token: "[REDACTED]",
    sessionCookie: "[REDACTED]", tokenUsage: 17, inputTokens: 11, connection: "[REDACTED]",
  });
});

test("SDK mask keeps large serialized attributes as valid bounded JSON strings", () => {
  const masked = sanitizeObservationMaskValue(JSON.stringify({
    accessToken: "secret-value", prompt: "x".repeat(40_000),
  }), {});
  assert.equal(typeof masked, "string");
  assert.doesNotThrow(() => JSON.parse(masked as string));
  assert.ok(Buffer.byteLength(masked as string, "utf8") <= 17 * 1024);
  assert.ok(!(masked as string).includes("secret-value"));
});

test("unsafe getters fail closed without blocking business work", async () => {
  const driver = new RecordingDriver();
  const adapter = createAgentObservability({ env: enabledEnv(), driver });
  const hostile = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("getter"); } });
  assert.equal(await adapter.observe("run", "agent", { metadata: hostile }, async () => "ok"), "ok");
  assert.deepEqual(driver.records[0]?.initial, {});
});

test("shutdown is idempotent", async () => {
  const driver = new RecordingDriver();
  const adapter = createAgentObservability({ env: enabledEnv(), driver });
  await Promise.all([adapter.shutdown(), adapter.shutdown()]);
  assert.equal(driver.shutdownCalls, 1);
});

test("public DNS lookalikes and public IPv6 cannot bypass the HTTP guard", () => {
  for (const host of ["127.evil.example", "10.evil.example", "192.168.evil.example",
    "172.16.evil.example", "[2606:4700::1111]", "8.8.8.8"]) {
    const adapter = createAgentObservability({ env: { ...enabledEnv(),
      LANGFUSE_BASE_URL: `http://${host}` }, driver: new RecordingDriver() });
    assert.equal(adapter.enabled, false, host);
  }
  for (const host of ["127.0.0.1", "10.0.0.1", "192.168.0.1", "172.16.0.1", "[::1]", "langfuse-web"]) {
    const adapter = createAgentObservability({ env: { ...enabledEnv(),
      LANGFUSE_BASE_URL: `http://${host}` }, driver: new RecordingDriver() });
    assert.equal(adapter.enabled, true, host);
  }
});

test("shutdown deadline is bounded", async () => {
  const driver = new RecordingDriver({ hangShutdown: true });
  const adapter = createAgentObservability({ env: enabledEnv(), driver, shutdownTimeoutMs: 10 });
  const started = Date.now();
  await adapter.shutdown();
  assert.ok(Date.now() - started < 500);
});

test("official SDK exports a redacted nested trace to a local OTLP endpoint", async () => {
  const bodies: Buffer[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const adapter = createAgentObservability({ env: {
      ...enabledEnv(),
      LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
      LANGFUSE_CAPTURE_CONTENT: "redacted",
    } });
    assert.equal(adapter.enabled, true);
    await adapter.observe("fixture-run", "agent", { input: {
      prompt: `Bearer should-not-leave-process ${"x".repeat(40_000)}`,
    } }, async () => adapter.observe("fixture-model", "generation", {
      model: "fixture-model", modelParameters: { temperature: 0.2, schema: { secret: "nested" } },
      usageDetails: { input: 2, output: 1 }, output: "safe-output",
    }, async () => undefined), { root: true, sessionId: "fixture-session" });
    await adapter.shutdown();
    assert.ok(bodies.length >= 1);
    const exported = Buffer.concat(bodies).toString("utf8");
    assert.ok(!exported.includes("should-not-leave-process"));
    assert.ok(exported.includes("fixture-run"));
    assert.ok(exported.includes("fixture-model"));
    assert.ok(exported.includes("pr-agent"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function enabledEnv(): NodeJS.ProcessEnv {
  return { LANGFUSE_ENABLED: "on", LANGFUSE_BASE_URL: "https://langfuse.example.test",
    LANGFUSE_PUBLIC_KEY: "pk-test-value", LANGFUSE_SECRET_KEY: "sk-test-value" };
}

interface RecordEntry { initial: AgentObservationAttributes; updates: AgentObservationAttributes[];
  parentSpanId?: string; sessionId?: string }

class RecordingDriver implements AgentObservationDriver {
  readonly records: RecordEntry[] = [];
  shutdownCalls = 0;
  private sequence = 0;
  constructor(private readonly failures: { failStart?: boolean; failUpdate?: boolean; failEnd?: boolean;
    hangShutdown?: boolean } = {}) {}

  start(_name: string, _type: AgentObservationType, attributes: AgentObservationAttributes,
    options: { parentSpanContext?: SpanContext; sessionId?: string }) {
    if (this.failures.failStart) throw new Error("tracer start failed");
    this.sequence += 1;
    const spanId = this.sequence.toString(16).padStart(16, "0");
    const record: RecordEntry = { initial: attributes, updates: [],
      parentSpanId: options.parentSpanContext?.spanId, sessionId: options.sessionId };
    this.records.push(record);
    return { traceId: "trace-1", spanId,
      spanContext: { traceId: "1".repeat(32), spanId, traceFlags: 1 },
      update: (update: AgentObservationAttributes) => {
        if (this.failures.failUpdate) throw new Error("tracer update failed");
        record.updates.push(update);
      },
      end: () => { if (this.failures.failEnd) throw new Error("tracer end failed"); },
    };
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.failures.hangShutdown) await new Promise<void>(() => undefined);
  }
}
