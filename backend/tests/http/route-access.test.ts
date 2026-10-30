import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Controller, Get, Module, type LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { HttpCommonModule } from "../../src/http/common/http-common.module.js";
import { RouteAccess } from "../../src/http/common/route-access.js";
import { renderPrometheusMetrics } from "../../src/http/system/metrics-runtime.js";
import { clearMetricState } from "../support/metrics-test-api.ts";

class ProtectedFixture {
  publicRoute() { return { ok: true }; }
  read() { return { ok: true }; }
  write() { return { ok: true }; }
}
Controller("fixture")(ProtectedFixture);
for (const [name, path, policy] of [["publicRoute", "public", "public"], ["read", "read", "runs:read"],
  ["write", "write", "runs:create"]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(ProtectedFixture.prototype, name)!;
  Get(path)(ProtectedFixture.prototype, name, descriptor);
  RouteAccess(policy)(ProtectedFixture.prototype, name, descriptor);
}
class FixtureModule {}
Module({ imports: [HttpCommonModule], controllers: [ProtectedFixture] })(FixtureModule);
class ForgottenFixture { route() { return "unprotected"; } }
Controller("forgotten")(ForgottenFixture);
Get()(ForgottenFixture.prototype, "route", Object.getOwnPropertyDescriptor(ForgottenFixture.prototype, "route")!);
class ForgottenModule {}
Module({ imports: [HttpCommonModule], controllers: [ForgottenFixture] })(ForgottenModule);

test("central guard rejects forgotten routes during initialization", async () => {
  const app = await NestFactory.create(ForgottenModule, { logger: false, abortOnError: false });
  try { await assert.rejects(app.init(), /Missing route access policy/); }
  finally { await app.close(); }
});

test("global guard authorizes by capability before an endpoint executes", async () => {
  const old = process.env.HARNESS_API_PRINCIPALS_JSON;
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  process.env.HARNESS_API_PRINCIPALS_JSON = JSON.stringify([
    { subjectId: "reader", actorType: "user", tenantId, integrationId,
      tokenSha256: createHash("sha256").update("reader-token").digest("hex"), permissions: ["runs:read"] },
    { subjectId: "expired", actorType: "user", tenantId, integrationId,
      tokenSha256: createHash("sha256").update("expired-token").digest("hex"),
      expiresAt: "2020-01-01T00:00:00.000Z", permissions: ["runs:read"] },
  ]);
  clearMetricState();
  const warnings: unknown[] = [];
  const logger: LoggerService = {
    log: () => undefined,
    error: () => undefined,
    warn: (message) => { warnings.push(message); },
  };
  const app = await NestFactory.create(FixtureModule, { logger, abortOnError: false });
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/fixture/public`)).status, 200);
    assert.equal((await fetch(`${base}/fixture/read?raw_path_secret=never-log-this`)).status, 401);
    assert.equal((await fetch(`${base}/fixture/read`, {
      headers: { authorization: "Bearer expired-token" },
    })).status, 401);
    const headers = { authorization: "Bearer reader-token" };
    assert.equal((await fetch(`${base}/fixture/read`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/fixture/write?body_secret=never-log-body`, { headers })).status, 403);

    const denials = warnings.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && "code" in entry));
    assert.deepEqual(denials, [
      { code: "UNAUTHORIZED", policy: "runs:read", controllerMethod: "ProtectedFixture.read", status: 401 },
      { code: "UNAUTHORIZED", policy: "runs:read", controllerMethod: "ProtectedFixture.read", status: 401 },
      { code: "FORBIDDEN", policy: "runs:create", controllerMethod: "ProtectedFixture.write", status: 403 },
    ]);
    const telemetry = JSON.stringify(denials);
    assert.doesNotMatch(telemetry, /reader-token|expired-token|never-log-this|never-log-body|authorization|tokenSha256/u);

    const metrics = renderPrometheusMetrics();
    assert.match(metrics,
      /pr_agent_route_access_denials_total\{code="UNAUTHORIZED",controller_method="ProtectedFixture\.read",policy="runs:read",status="401"\} 2/u);
    assert.match(metrics,
      /pr_agent_route_access_denials_total\{code="FORBIDDEN",controller_method="ProtectedFixture\.write",policy="runs:create",status="403"\} 1/u);
    assert.doesNotMatch(metrics, /reader-token|expired-token|never-log-this|never-log-body/u);
  } finally {
    await app.close();
    if (old === undefined) delete process.env.HARNESS_API_PRINCIPALS_JSON;
    else process.env.HARNESS_API_PRINCIPALS_JSON = old;
  }
});
