import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import type { LangfuseQualityPort } from "../../src/quality/langfuse/contracts.js";
import { createQualitySyncLoop } from "../../src/quality/sync/loop.js";
import type { QualitySyncJob, QualitySyncLease } from "../../src/quality/storage/contracts.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const INTEGRATION = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const principal: RunPrincipal = { subjectId: "worker-user", actorType: "service", tenantId: TENANT,
  integrationId: INTEGRATION, permissions: ["evaluations:read"] };

describe("QualitySyncLoop", () => {
  it("is inert when the feature is disabled", async () => {
    let discovered = 0;
    const loop = createQualitySyncLoop({ db: {} as never, env: { LANGFUSE_QUALITY_ENABLED: "off" },
      discoverScopes: async () => { discovered += 1; return []; }, automatic: false });
    await loop.start();
    const result = await loop.tick();
    await loop.stop();
    assert.equal(loop.enabled, false);
    assert.equal(result.disabled, true);
    assert.equal(discovered, 0);
  });

  it("fails with a safe code when explicitly enabled without valid Worker credentials", () => {
    assert.throws(
      () => createQualitySyncLoop({ db: {} as never, env: { LANGFUSE_QUALITY_ENABLED: "on" } }),
      (error) => error instanceof Error && error.message === "QUALITY_SYNC_CONFIGURATION_INVALID",
    );
  });

  it("requires a current-principal validator whenever synchronization is enabled", () => {
    assert.throws(
      () => createQualitySyncLoop({ db: {} as never, configuration: enabledConfiguration(),
        client: unusedClient(), automatic: false }),
      (error) => error instanceof Error && error.message === "QUALITY_SYNC_PRINCIPAL_VALIDATOR_REQUIRED",
    );
  });

  it("claims bounded leases, validates the current principal, and completes outside database work", async () => {
    const store = new LoopStore([lease("dataset_export")]);
    let currentChecks = 0;
    const loop = createQualitySyncLoop({ db: {} as never, configuration: enabledConfiguration(),
      client: unusedClient(), jobStore: store, discoverScopes: async (limit) => {
        assert.equal(limit, 3); return [{ tenantId: TENANT, integrationId: INTEGRATION, queueState: "ready", dueJobs: 1 }];
      }, handlers: { dataset_export: async () => {
        assert.equal(store.inDatabaseOperation, false);
        return { exported: 1 };
      } }, assertPrincipalCurrent: async (candidate) => {
        currentChecks += 1; assert.equal(candidate.subjectId, principal.subjectId);
      }, env: { QUALITY_SYNC_SCOPE_LIMIT: "3", QUALITY_SYNC_CLAIM_LIMIT: "2" }, automatic: false });

    const result = await loop.tick();

    assert.deepEqual(result, { disabled: false, scopes: 1, claimed: 1, succeeded: 1, failed: 0 });
    assert.equal(currentChecks, 1);
    assert.equal(store.claimInputs[0]?.limit, 1);
    assert.equal(store.completed.length, 1);
  });

  it("hands sanitized failures to the store so its retry budget and jitter policy remain authoritative", async () => {
    const store = new LoopStore([lease("scores_export"), lease("annotation_pull", "44444444-4444-4444-8444-444444444444")]);
    const loop = createQualitySyncLoop({ db: {} as never, configuration: enabledConfiguration(),
      client: unusedClient(), jobStore: store, discoverScopes: async () => [{ tenantId: TENANT,
        integrationId: INTEGRATION, queueState: "ready", dueJobs: 2 }], handlers: {
        scores_export: async () => { throw Object.assign(new Error("secret response"), { code: "QUALITY_TARGET_CHANGED" }); },
        annotation_pull: async () => { throw new Error("contains a secret response body"); },
      }, assertPrincipalCurrent: () => undefined, automatic: false });

    const result = await loop.tick();

    assert.equal(result.failed, 2);
    assert.deepEqual(store.failed.map(({ errorCode, retryAfterMs }) => ({ errorCode, retryAfterMs })), [
      { errorCode: "QUALITY_TARGET_CHANGED", retryAfterMs: undefined },
      { errorCode: "QUALITY_SYNC_FAILED", retryAfterMs: undefined },
    ]);
  });

  it("renews the lease while a bounded long-running handler executes", async () => {
    const store = new LoopStore([lease("dataset_export")]);
    const loop = createQualitySyncLoop({ db: {} as never, configuration: enabledConfiguration(),
      client: unusedClient(), jobStore: store, discoverScopes: async () => [{ tenantId: TENANT,
        integrationId: INTEGRATION, queueState: "ready", dueJobs: 1 }],
      handlers: { dataset_export: async () => { await wait(1_100); return { exported: 1 }; } },
      assertPrincipalCurrent: () => undefined,
      env: { QUALITY_SYNC_LEASE_MS: "1000", QUALITY_SYNC_JOB_TIMEOUT_MS: "3000" }, automatic: false });

    const result = await loop.tick();

    assert.equal(result.succeeded, 1);
    assert.ok(store.heartbeats >= 2);
  });

  it("continues automatic polling after initial discovery failure", async () => {
    const store = new LoopStore([]);
    let attempts = 0;
    const errors: unknown[] = [];
    const loop = createQualitySyncLoop({ db: {} as never, configuration: enabledConfiguration(),
      client: unusedClient(), jobStore: store, discoverScopes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database temporarily unavailable");
        return [];
      }, assertPrincipalCurrent: () => undefined, onError: (error) => errors.push(error),
      env: { QUALITY_SYNC_POLL_MS: "100" }, automatic: true });

    await loop.start();
    await wait(160);
    await loop.stop();

    assert.ok(attempts >= 2);
    assert.equal(errors.length, 1);
  });

  it("aborts active work and returns it to retry during stop", async () => {
    const store = new LoopStore([lease("dataset_export")]);
    let observedAbort = false;
    const loop = createQualitySyncLoop({ db: {} as never, configuration: enabledConfiguration(),
      client: unusedClient(), jobStore: store, discoverScopes: async () => [{ tenantId: TENANT,
        integrationId: INTEGRATION, queueState: "ready", dueJobs: 1 }], handlers: {
        dataset_export: async (_job, context) => new Promise((_resolve, reject) => {
          context?.signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new Error("cancelled"));
          }, { once: true });
        }),
      }, assertPrincipalCurrent: () => undefined, env: { QUALITY_SYNC_STOP_WAIT_MS: "500" }, automatic: false });

    const ticking = loop.tick();
    await wait(20);
    await loop.stop();
    await ticking;

    assert.equal(observedAbort, true);
    assert.equal(store.failed.at(-1)?.errorCode, "QUALITY_SYNC_CANCELLED");
  });
});

describe("quality sync discovery migration", () => {
  it("uses a bounded security-definer surface with explicit grants", async () => {
    const sql = await readFile(new URL("../../src/agent-runtime/postgres/migrations/035_langfuse_quality_runtime.sql",
      import.meta.url), "utf8");
    assert.match(sql, /quality_sync_due_scopes\(requested_limit integer\)/u);
    assert.match(sql, /SECURITY DEFINER/u);
    assert.match(sql, /SET search_path=pg_catalog,pr_agent_harness/u);
    assert.match(sql, /LIMIT requested_limit\*16/u);
    assert.match(sql, /REVOKE ALL ON FUNCTION pr_agent_harness\.quality_sync_due_scopes\(integer\) FROM PUBLIC/u);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION pr_agent_harness\.quality_sync_due_scopes\(integer\) TO pr_agent_app/u);
  });
});

class LoopStore {
  inDatabaseOperation = false;
  claimInputs: Array<{ limit?: number; leaseMs?: number }> = [];
  completed: unknown[] = [];
  failed: Array<{ errorCode: string; retryAfterMs?: number }> = [];
  heartbeats = 0;
  private nextLease = 0;

  constructor(private readonly leases: QualitySyncLease[]) {}

  async enqueue(_scope: unknown, input: Parameters<import("../../src/quality/storage/sync-job-store.js").PgQualitySyncJobStore["enqueue"]>[1]): Promise<QualitySyncJob> {
    return lease(input.kind);
  }

  async claim(_scope: unknown, input: { limit?: number; leaseMs?: number }): Promise<QualitySyncLease[]> {
    this.inDatabaseOperation = true;
    try {
      this.claimInputs.push(input);
      const lease = this.leases[this.nextLease];
      if (!lease) return [];
      this.nextLease += 1;
      return [lease];
    } finally { this.inDatabaseOperation = false; }
  }
  async heartbeat(): Promise<QualitySyncJob> {
    this.inDatabaseOperation = true;
    try { this.heartbeats += 1; return this.leases[0]!; }
    finally { this.inDatabaseOperation = false; }
  }
  async complete(_scope: unknown, _lease: unknown, result: Record<string, unknown>): Promise<QualitySyncJob> {
    this.inDatabaseOperation = true;
    try { this.completed.push(result); return this.leases[0]!; }
    finally { this.inDatabaseOperation = false; }
  }
  async fail(_scope: unknown, _lease: unknown, input: { errorCode: string; retryAfterMs?: number }): Promise<QualitySyncJob> {
    this.inDatabaseOperation = true;
    try { this.failed.push(input); return this.leases[0]!; }
    finally { this.inDatabaseOperation = false; }
  }
}

function enabledConfiguration() {
  return { enabled: true, targetFingerprint: HASH, baseUrl: "https://langfuse.example.test",
    publicKey: "pk-test", secretKey: "sk-test" };
}

function lease(kind: QualitySyncLease["kind"], id = JOB): QualitySyncLease {
  return { id, scope: { tenantId: TENANT, integrationId: INTEGRATION }, kind,
    externalId: `${kind}:1`, idempotencyKey: `${kind}:1`, requestHash: HASH, targetFingerprint: HASH,
    payload: {}, principal: principal as unknown as Record<string, unknown>, status: "running", attemptCount: 1,
    maxAttempts: 3, maxAgeSeconds: 3600, availableAt: new Date(0).toISOString(), leaseOwner: "worker",
    leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), version: 1 };
}

function unusedClient(): LangfuseQualityPort {
  return new Proxy({}, { get: () => async () => { throw new Error("unexpected client call"); } }) as LangfuseQualityPort;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
