import assert from "node:assert/strict";
import test from "node:test";

import { logCore, sanitizeLogMetadata } from "../../src/core/index.js";

test("structured log metadata recursively redacts secrets and URL credentials", () => {
  const metadata = sanitizeLogMetadata({ authorization: "Bearer secret", nested: {
    apiKey: "key-secret", url: "https://user:pass@example.test/path?token=query#fragment",
    safe: "visible",
  }, error: Object.assign(new Error("database postgres://user:secret@host/db"), { code: "23505" }),
  untrustedField: "postgres://user:secret@host/db", message: "postgres://user:secret@host/db" });
  const serialized = JSON.stringify(metadata);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.match(serialized, /https:\/\/example\.test/u);
  assert.doesNotMatch(serialized, /\/path/u);
  assert.match(serialized, /23505/u);
  assert.match(serialized, /visible/u);
  assert.doesNotMatch(serialized, /Bearer secret|key-secret|user:pass|token=query|postgres:\/\//u);
});

test("error identifiers cannot smuggle arbitrary secret strings", () => {
  const unsafe = Object.assign(new Error("hidden"), { name: "SECRET_API_TOKEN_ABC123",
    code: "SECRET_API_TOKEN_ABC123",
    cause: Object.assign(new Error("cause"), { name: "SECRET_API_TOKEN_CAUSE" }) });
  const serialized = JSON.stringify(sanitizeLogMetadata({ error: unsafe }));
  assert.doesNotMatch(serialized, /SECRET_API_TOKEN|hidden|cause/u);
  assert.match(serialized, /"errorType":"Error"/u);
  assert.doesNotMatch(serialized, /domainCode|causeClass/u);
});

test("known domain error classes and PostgreSQL SQLSTATE codes remain observable", () => {
  const known = Object.assign(new Error("private detail"), { name: "ModelBudgetExceededError", code: "23505" });
  assert.deepEqual(sanitizeLogMetadata({ error: known }), { error: {
    causeClass: undefined, domainCode: "23505", errorType: "ModelBudgetExceededError",
  } });
});

test("error logs are emitted even when optional core logging is disabled", (t) => {
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => { messages.push(message); });
  const before = process.env.PR_AGENT_CORE_LOGS;
  try {
    delete process.env.PR_AGENT_CORE_LOGS;
    logCore("error", "fixture.failed", { requestBody: { private: "secret" }, timestamp: "forged",
      level: "debug", component: "forged", event: "forged",
      path: "/runs?access_token=secret", error: new TypeError("secret message") });
  } finally {
    if (before === undefined) delete process.env.PR_AGENT_CORE_LOGS;
    else process.env.PR_AGENT_CORE_LOGS = before;
  }
  assert.equal(messages.length, 1);
  const record = JSON.parse(messages[0]!) as Record<string, unknown>;
  assert.equal(record.level, "error"); assert.equal(record.event, "fixture.failed");
  assert.equal(record.component, "core"); assert.notEqual(record.timestamp, "forged");
  assert.equal(record.path, "/runs"); assert.equal(record.requestBody, "[REDACTED]");
  assert.doesNotMatch(messages[0]!, /access_token|secret message|private/u);
});
