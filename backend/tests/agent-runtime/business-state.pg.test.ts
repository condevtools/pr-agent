import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { PgBusinessStateStore } from "../../src/agent-runtime/state/business-state.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (!databaseUrl) test.skip("PostgreSQL business state requires Docker test database", () => {});
else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("Disposable database required");
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new RuntimeDatabase(pool);
  const store = new PgBusinessStateStore(db);
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const otherTenant = randomUUID();
  const otherIntegration = randomUUID();

  before(async () => {
    await migrateRuntime(pool);
    await pool.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository) VALUES
      ($1,$2,'github','https://api.github.com','acme/project'),
      ($3,$4,'github','https://api.github.com','other/project')`,
    [integrationId, tenantId, otherIntegration, otherTenant]);
  });
  after(async () => { await pool.end(); });

  test("rate limit is atomic, shared and tenant scoped", async () => {
    const scope = { tenantId, integrationId, key: "github:acme/project:pr:7:user:9:review", limit: 2, windowMs: 60_000 };
    const results = await Promise.all([store.isRateLimited(scope), store.isRateLimited(scope), store.isRateLimited(scope)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await store.isRateLimited({ ...scope, tenantId: otherTenant, integrationId: otherIntegration }), false);
  });

  test("incremental cursors and feedback preserve full integration scope", async () => {
    const scope = { tenantId, integrationId, platform: "github" as const, origin: "https://api.github.com",
      repository: "acme/project", target: "pr:7" };
    await store.rememberIncrementalHead({ ...scope, headSha: "abc123", ttlMs: 60_000 });
    assert.equal(await store.loadIncrementalHead(scope), "abc123");
    await store.recordFeedbackSignal({ ...scope, signal: "accepted finding", ttlMs: 60_000 });
    await store.recordFeedbackSignal({ ...scope, target: "repository", signal: "prefer concise findings", ttlMs: 60_000 });
    const otherOriginScope = { ...scope, origin: "https://github.example.test/api/v3" };
    await store.rememberIncrementalHead({ ...otherOriginScope, headSha: "def456", ttlMs: 60_000 });
    await store.recordFeedbackSignal({ ...otherOriginScope, signal: "accepted finding", ttlMs: 60_000 });
    assert.deepEqual(await store.loadFeedbackSignals(scope), ["prefer concise findings", "accepted finding"]);
    assert.equal(await store.loadIncrementalHead(otherOriginScope), "def456");
    assert.deepEqual(await store.loadFeedbackSignals(otherOriginScope), ["accepted finding"]);
    assert.deepEqual(await store.loadFeedbackSignals({ ...scope, tenantId: otherTenant,
      integrationId: otherIntegration, repository: "other/project" }), []);
  });
}
