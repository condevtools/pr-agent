import assert from "node:assert/strict";
import test from "node:test";

import { HealthService } from "../../src/http/system/health.service.ts";
import { SystemController } from "../../src/http/system/system.controller.ts";

test("health endpoint returns static status when deep check is disabled", async () => {
  const service = new HealthService();
  const result = await service.getHealth({
    mode: "nest",
    deep: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "nest");
  assert.equal(result.checks, undefined);
});

test("health remains liveness-only even when a legacy deep argument is supplied", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("liveness must not call providers"); };

  try {
    const service = new HealthService();
    const result = await service.getHealth({ mode: "nest", deep: true });
    assert.equal(result.ok, true);
    assert.equal(result.checks, undefined);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readiness endpoint returns 503 only for an unready runtime", async () => {
  const service = new HealthService();
  const controller = new SystemController(service);
  let responseStatus = 200;
  const response = { status: (status: number) => { responseStatus = status; } };
  const unavailable = {
    ok: false,
    role: "web" as const,
    capabilities: { reviewSingle: true as const, reviewDeep: true, fix: false, evolution: false },
    checks: { postgres: false, runtimeRole: false, schema: false,
      heartbeats: { worker: false, recovery: false } },
  };
  service.getReadiness = async () => unavailable;

  assert.deepEqual(await controller.ready(response as never), unavailable);
  assert.equal(responseStatus, 503);

  service.getReadiness = async () => ({ ...unavailable, ok: true });
  responseStatus = 200;
  assert.equal((await controller.ready(response as never)).ok, true);
  assert.equal(responseStatus, 200);
});
