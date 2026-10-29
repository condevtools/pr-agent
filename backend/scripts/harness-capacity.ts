import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";

import { PublicationAuthorityStore, type PublicationBinding } from "../src/harness/authority.js";
import { getModelExecutionPolicy, ModelBudgetExceededError, ModelBudgetStore } from "../src/harness/model-budget-store.js";
import { HarnessDatabase } from "../src/harness/postgres/database.js";
import { migrateHarness } from "../src/harness/postgres/migrations.js";
import { HarnessRunStore } from "../src/harness/postgres/run-store.js";
import { RunExecutionStore } from "../src/harness/run-execution-store.js";
import { appendRunFact } from "../src/harness/run-events.js";
import { parseRunCursor, RunQueryStore } from "../src/harness/run-query-store.js";
import { RunEventStreamHub } from "../src/harness/run-sse.js";
import { closeHarnessRuntime } from "../src/harness/runtime.js";
import { HarnessModule } from "../src/modules/harness/harness.module.js";

interface CapacityProfile {
  name: "quick" | "qualification";
  intake: { steadyRate: number; steadySeconds: number; burstRate: number; burstSeconds: number };
  workers: { runs: number; concurrency: number };
  sse: { connections: number; principals: number; reconnects: number };
  budget: { contenders: number; admitted: number };
}
interface PhaseResult { passed: boolean; durationMs: number; metrics: Record<string, unknown>; error?: string }
class CapacityGateError extends Error {
  constructor(message: string, readonly metrics: Record<string, unknown>) { super(message); this.name = "CapacityGateError"; }
}

const profiles: Record<CapacityProfile["name"], CapacityProfile> = {
  quick: { name: "quick", intake: { steadyRate: 5, steadySeconds: 2, burstRate: 10, burstSeconds: 1 },
    workers: { runs: 100, concurrency: 4 }, sse: { connections: 32, principals: 4, reconnects: 8 },
    budget: { contenders: 20, admitted: 10 } },
  qualification: { name: "qualification", intake: { steadyRate: 20, steadySeconds: 600, burstRate: 100, burstSeconds: 30 },
    workers: { runs: 10_000, concurrency: 4 }, sse: { connections: 1_000, principals: 16, reconnects: 100 },
    budget: { contenders: 100, admitted: 50 } },
};

const profileName = arg("--profile") === "qualification" ? "qualification" : "quick";
const profile = profiles[profileName];
const outputPath = resolve(arg("--output") ?? "../.omx/implementation/p0d-capacity.json");
const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("HARNESS_TEST_DATABASE_URL is required");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!databaseName.startsWith("harness_capacity_")) throw new Error("Disposable harness_capacity_* database required");

const startedAt = new Date();
const results: Record<string, PhaseResult> = {};
let currentPhase = "setup";
let currentProgress: Record<string, unknown> = {};
const heartbeat = setInterval(() => progress("capacity.progress", currentProgress), 30_000);
heartbeat.unref();

const adminPool = new Pool({ connectionString: databaseUrl, max: 8 });
const adminDb = new HarnessDatabase(adminPool);
const role = `capacity_${randomUUID().replaceAll("-", "")}`;
const rolePassword = randomUUID();
const tenantId = randomUUID();
const integrationId = randomUUID();
const budgetTenantId = randomUUID();
const budgetIntegrationId = randomUUID();
const repository = "acme/capacity";
const versionHash = hash("p0d-capacity-runtime-v1");
const apiToken = "capacity-api-token";
let providerOrigin = "";
let apiOrigin = "";
let providerRequests = 0;
let providerServer: Server | undefined;
let app: INestApplication | undefined;
let appPool: Pool | undefined;
let appDb: HarnessDatabase | undefined;
let runStore: HarnessRunStore | undefined;
let binding: PublicationBinding | undefined;

try {
  await setup();
  await phase("workers", workerCapacity);
  await phase("budget", budgetCapacity);
  await phase("sse", sseCapacity);
  await phase("intake", intakeCapacity);
} catch (error) {
  if (!results[currentPhase]) results[currentPhase] = { passed: false, durationMs: 0, metrics: currentProgress,
    error: message(error) };
} finally {
  clearInterval(heartbeat);
  await app?.close().catch(() => undefined);
  await closeHarnessRuntime().catch(() => undefined);
  await appPool?.end().catch(() => undefined);
  await adminPool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE").catch(() => undefined);
  await adminPool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await adminPool.end().catch(() => undefined);
  if (providerServer) await closeServer(providerServer).catch(() => undefined);
}

const passed = ["workers", "budget", "sse", "intake"].every((name) => results[name]?.passed === true);
const report = { schemaVersion: 1, profile: profile.name, qualificationTarget: profile.name === "qualification",
  passed, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), environment: {
    node: process.version, postgres: "17-alpine", database: "isolated-docker", provider: "local-http-fixture",
    runtimeRole: { superuser: false, bypassRls: false },
  }, phases: results };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
progress("capacity.complete", { passed, outputPath });
if (!passed) process.exitCode = 1;

async function setup(): Promise<void> {
  providerServer = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    if (request.method === "GET" && /^\/repos\/acme\/capacity\/pulls\/\d+$/.test(request.url ?? "")) {
      providerRequests += 1;
      const number = Number(request.url!.split("/").at(-1));
      return json(response, 200, { id: number, number, title: `Capacity ${number}`, body: "local fixture",
        user: { login: "capacity" }, base: { ref: "main", sha: `base-${number}` },
        head: { ref: "feature", sha: `head-${number}` }, draft: false,
        html_url: `${providerOrigin}/acme/capacity/pull/${number}` });
    }
    return json(response, 404, { message: "fixture route not found" });
  });
  await listen(providerServer);
  const address = providerServer.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture did not bind");
  providerOrigin = `http://127.0.0.1:${address.port}`;

  await migrateHarness(adminPool);
  await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);
  await grantRuntimeRole(adminPool, role);
  const appUrl = new URL(databaseUrl!); appUrl.username = role; appUrl.password = rolePassword;
  process.env.HARNESS_DATABASE_URL = appUrl.toString();
  process.env.GITHUB_API_URL = providerOrigin;
  process.env.GITHUB_TOKEN = "capacity-local-provider-token";
  process.env.AI_PROVIDER = "openai-compatible";
  process.env.AI_MODEL = "capacity-model";
  const intakeRunCapacity = profile.intake.steadyRate * profile.intake.steadySeconds
    + (profile.intake.burstRate * profile.intake.burstSeconds) / 2 + 100;
  process.env.HARNESS_MODEL_PRICING_JSON = pricing(intakeRunCapacity);
  const principals = [{ subjectId: "capacity-api", actorType: "service", tokenSha256: hash(apiToken), tenantId,
    integrationId, permissions: ["runs:create", "runs:read", "runs:trace"] },
  ...Array.from({ length: profile.sse.principals }, (_, index) => ({ subjectId: `sse-${index}`, actorType: "service",
    tokenSha256: hash(`sse-token-${index}`), tenantId, integrationId, permissions: ["runs:read"] }))];
  process.env.HARNESS_API_PRINCIPALS_JSON = JSON.stringify(principals);

  appPool = new Pool({ connectionString: appUrl.toString(), max: 32 });
  appDb = new HarnessDatabase(appPool);
  runStore = new HarnessRunStore(appDb);
  const adminRuns = new HarnessRunStore(adminDb);
  binding = await activate(adminRuns, tenantId, integrationId, providerOrigin, repository, 7001);
  await activate(adminRuns, budgetTenantId, budgetIntegrationId, providerOrigin, "acme/capacity-budget", 7002);
  const roleState = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  if (roleState.rows[0]?.rolsuper || roleState.rows[0]?.rolbypassrls) throw new Error("Capacity runtime role is privileged");
  app = await NestFactory.create(HarnessModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const apiAddress = app.getHttpServer().address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("Harness API did not bind");
  apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
  progress("capacity.ready", { profile: profile.name, apiOrigin });
}

async function workerCapacity(): Promise<Record<string, unknown>> {
  const target = profile.workers.runs;
  const deadline = Date.now() + 10 * 60_000;
  const claimLatencies: number[] = [];
  currentProgress = { created: 0, target, processed: 0 };
  await concurrent(target, Math.min(64, profile.workers.concurrency * 8), async (index) => {
    if (Date.now() >= deadline) throw new Error("Worker fixture exceeded its 10 minute deadline during intake");
    await runStore!.createRun(runInput(tenantId, integrationId, `worker-${index}`, binding!.generation,
      binding!.executionModeGeneration ?? 1));
    currentProgress.created = Number(currentProgress.created) + 1;
  });
  const store = new RunExecutionStore(appDb!);
  const seen = new Set<string>();
  let duplicateClaims = 0;
  let processed = 0;
  const workers = Array.from({ length: profile.workers.concurrency }, (_, index) => (async () => {
    let misses = 0;
    while (processed < target && misses < 100) {
      if (Date.now() >= deadline) throw new Error("Worker fixture exceeded its 10 minute deadline during claims");
      const claimStarted = performance.now();
      const lease = await store.claim({ tenantId, integrationId, authorityGeneration: binding!.generation,
        executionModeGeneration: binding!.executionModeGeneration ?? 1 }, `capacity-worker-${index}`, versionHash);
      claimLatencies.push(performance.now() - claimStarted);
      if (!lease) { misses += 1; await delay(2); continue; }
      misses = 0;
      if (seen.has(lease.runId)) duplicateClaims += 1;
      seen.add(lease.runId);
      await store.transition(lease, { to: "succeeded", outcomeCode: "capacity_noop" });
      processed += 1;
      currentProgress.processed = processed;
    }
  })());
  await Promise.all(workers);
  const db = await appDb!.transaction(tenantId, (client) => client.query<{ succeeded: string; duplicate_attempts: string }>(
    `SELECT count(*) FILTER (WHERE status='succeeded')::text AS succeeded,
            count(*) FILTER (WHERE execution_attempt_count<>1)::text AS duplicate_attempts
     FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND create_scope='capacity-worker'`, [tenantId]));
  const succeeded = Number(db.rows[0]?.succeeded ?? 0);
  const duplicateAttempts = Number(db.rows[0]?.duplicate_attempts ?? 0);
  const metrics = { target, processed, workers: profile.workers.concurrency, uniqueLeases: seen.size, duplicateClaims,
    duplicateAttempts, claimLatencyMs: percentileSummary(claimLatencies), deadlineMs: 10 * 60_000 };
  if (processed !== target || succeeded !== target || duplicateClaims !== 0 || duplicateAttempts !== 0
      || Number(metrics.claimLatencyMs.p95) >= 1_000) {
    throw new CapacityGateError(`Worker gate failed: processed=${processed}, succeeded=${succeeded}, duplicates=${duplicateClaims}/${duplicateAttempts}, claimP95=${metrics.claimLatencyMs.p95}`, metrics);
  }
  return metrics;
}

async function budgetCapacity(): Promise<Record<string, unknown>> {
  const { contenders, admitted } = profile.budget;
  currentProgress = { contenders, created: 0, reservationsComplete: 0 };
  const budgetRuns: string[] = [];
  await concurrent(contenders, 32, async (index) => {
    const created = await runStore!.createRun(runInput(budgetTenantId, budgetIntegrationId, `budget-${index}`, 1, 1));
    budgetRuns[index] = created.id;
    currentProgress.created = Number(currentProgress.created) + 1;
  });
  const policy = getModelExecutionPolicy("openai-compatible", "capacity-model",
    { ...process.env, HARNESS_MODEL_PRICING_JSON: pricing(admitted) });
  const store = new ModelBudgetStore(appDb!);
  const outcomes = await Promise.all(budgetRuns.map(async (runId) => {
    try { await store.reserveRun({ tenantId: budgetTenantId, runId, policy }); return "admitted"; }
    catch (error) { if (error instanceof ModelBudgetExceededError) return "rejected"; throw error; }
    finally { currentProgress.reservationsComplete = Number(currentProgress.reservationsComplete) + 1; }
  }));
  const accepted = outcomes.filter((value) => value === "admitted").length;
  const rejected = outcomes.length - accepted;
  const ledger = await appDb!.transaction(budgetTenantId, (client) => client.query<{ reserved_input_tokens: string; input_token_limit: string }>(
    `SELECT reserved_input_tokens,input_token_limit FROM pr_agent_harness.tenant_budget_accounts
     WHERE tenant_id=$1 AND period_key='capacity' AND currency='USD'`, [budgetTenantId]));
  const reserved = Number(ledger.rows[0]?.reserved_input_tokens ?? -1);
  const limit = Number(ledger.rows[0]?.input_token_limit ?? -1);
  if (accepted !== admitted || rejected !== contenders - admitted || reserved > limit) {
    throw new Error(`Budget invariant failed: accepted=${accepted}, rejected=${rejected}, reserved=${reserved}, limit=${limit}`);
  }
  return { contenders, accepted, rejected, reservedInputTokens: reserved, tenantInputLimit: limit };
}

async function sseCapacity(): Promise<Record<string, unknown>> {
  const fixture = await runStore!.createRun(runInput(tenantId, integrationId, "sse-fixture", binding!.generation,
    binding!.executionModeGeneration ?? 1));
  const connections: Array<{ controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array>; cursor: string; principal: number }> = [];
  currentProgress = { target: profile.sse.connections, connected: 0, reconnected: 0 };
  await concurrent(profile.sse.connections, 100, async (index) => {
    const principal = index % profile.sse.principals;
    const stream = await openSse(fixture.id, `sse-token-${principal}`);
    connections[index] = { ...stream, principal };
    currentProgress.connected = Number(currentProgress.connected) + 1;
  });
  const reconnect = connections.slice(0, profile.sse.reconnects);
  await Promise.all(reconnect.map(async ({ controller, reader }) => { controller.abort(); await reader.cancel().catch(() => undefined); }));
  await delay(250);
  await adminDb.transaction(tenantId, (client) => appendRunFact(client, { tenantId, runId: fixture.id,
    eventType: "run.capacity_reconnect", actorType: "system", actorId: "capacity", visibility: "public",
    payload: { status: "queued" } }));
  await concurrent(reconnect.length, 50, async (index) => {
    const prior = reconnect[index]!;
    const stream = await openSse(fixture.id, `sse-token-${prior.principal}`, prior.cursor);
    connections[index] = { ...stream, principal: prior.principal };
    currentProgress.reconnected = Number(currentProgress.reconnected) + 1;
  });

  const blocked = blockedResponse();
  const hub = new RunEventStreamHub(new RunQueryStore(appDb!), { pollMs: 60_000, keepaliveMs: 60_000,
    drainTimeoutMs: 20, maxBufferBytes: 1024, maxConnections: 2, maxConnectionsPerPrincipal: 2 });
  await hub.open({ subjectId: "backpressure", actorType: "service", tenantId, integrationId,
    permissions: ["runs:read"] }, fixture.id, undefined, blocked as unknown as ServerResponse);
  await delay(50);
  if (!blocked.ended) throw new Error("Backpressured SSE subscriber was not closed");
  await hub.stop();
  await Promise.all(connections.map(async ({ controller, reader }) => { controller.abort(); await reader.cancel().catch(() => undefined); }));
  return { connections: profile.sse.connections, principals: profile.sse.principals,
    reconnects: profile.sse.reconnects, historyDelivered: connections.length, backpressureClosed: blocked.ended };
}

async function intakeCapacity(): Promise<Record<string, unknown>> {
  const latencies: number[] = [];
  let requests = 0;
  let created = 0;
  let replayed = 0;
  let failures = 0;
  const providerAtStart = providerRequests;
  currentProgress = { mode: "steady", requests, target: profile.intake.steadyRate * profile.intake.steadySeconds };
  const steadyStart = Date.now();
  for (let second = 0; second < profile.intake.steadySeconds; second += 1) {
    await Promise.all(Array.from({ length: profile.intake.steadyRate }, async (_, offset) => {
      const sequence = second * profile.intake.steadyRate + offset;
      const outcome = await intake(`steady-${sequence}`, 100_000 + sequence, latencies);
      requests += 1; created += outcome.created ? 1 : 0; failures += outcome.ok ? 0 : 1;
    }));
    currentProgress = { mode: "steady", requests, target: profile.intake.steadyRate * profile.intake.steadySeconds };
    await delayUntil(steadyStart + (second + 1) * 1000);
  }
  const steadyElapsedMs = Date.now() - steadyStart;
  currentProgress = { mode: "burst", requests: 0, target: profile.intake.burstRate * profile.intake.burstSeconds };
  const burstStart = Date.now();
  for (let second = 0; second < profile.intake.burstSeconds; second += 1) {
    const unique = profile.intake.burstRate / 2;
    const outcomes = await Promise.all(Array.from({ length: unique }, async (_, offset) => {
      const sequence = second * unique + offset;
      return intake(`burst-${sequence}`, 500_000 + sequence, latencies);
    }));
    const duplicates = await Promise.all(Array.from({ length: unique }, async (_, offset) => {
      const sequence = second * unique + offset;
      return intake(`burst-${sequence}`, 500_000 + sequence, latencies);
    }));
    for (const outcome of [...outcomes, ...duplicates]) {
      requests += 1; created += outcome.created ? 1 : 0; replayed += outcome.ok && !outcome.created ? 1 : 0;
      failures += outcome.ok ? 0 : 1;
    }
    currentProgress = { mode: "burst", requests: (second + 1) * profile.intake.burstRate,
      target: profile.intake.burstRate * profile.intake.burstSeconds };
    await delayUntil(burstStart + (second + 1) * 1000);
  }
  const burstElapsedMs = Date.now() - burstStart;
  const steadyTotal = profile.intake.steadyRate * profile.intake.steadySeconds;
  const burstTotal = profile.intake.burstRate * profile.intake.burstSeconds;
  const expectedCreated = steadyTotal + burstTotal / 2;
  const providerCalls = providerRequests - providerAtStart;
  const metrics = { requests, created, replayed, failures, providerCalls,
    steady: { targetRps: profile.intake.steadyRate, achievedRps: steadyTotal / (steadyElapsedMs / 1000), durationMs: steadyElapsedMs },
    burst: { targetRps: profile.intake.burstRate, achievedRps: burstTotal / (burstElapsedMs / 1000), durationMs: burstElapsedMs,
      duplicateRatio: replayed / burstTotal }, latencyMs: percentileSummary(latencies) };
  const rateTolerance = 0.99;
  const invariantPassed = failures === 0 && created === expectedCreated && replayed === burstTotal / 2
    && providerCalls === expectedCreated;
  const schedulePassed = metrics.steady.achievedRps >= profile.intake.steadyRate * rateTolerance
    && metrics.burst.achievedRps >= profile.intake.burstRate * rateTolerance
    && steadyElapsedMs >= profile.intake.steadySeconds * 1_000
    && burstElapsedMs >= profile.intake.burstSeconds * 1_000;
  const latencyPassed = profile.name !== "qualification" || Number(metrics.latencyMs.p95) < 250;
  if (!invariantPassed || !schedulePassed || !latencyPassed) {
    throw new CapacityGateError(`Intake gate failed: invariant=${invariantPassed}, schedule=${schedulePassed}, latency=${latencyPassed}, p95=${metrics.latencyMs.p95}`, metrics);
  }
  return metrics;
}

async function phase(name: string, operation: () => Promise<Record<string, unknown>>): Promise<void> {
  currentPhase = name; currentProgress = {}; const started = Date.now(); progress("capacity.phase.start", { name });
  try {
    const metrics = await operation();
    results[name] = { passed: true, durationMs: Date.now() - started, metrics };
    progress("capacity.phase.complete", { name, ...metrics });
  } catch (error) {
    const metrics = error instanceof CapacityGateError ? error.metrics : currentProgress;
    results[name] = { passed: false, durationMs: Date.now() - started, metrics, error: message(error) };
    progress("capacity.phase.failed", { name, error: message(error), ...metrics });
    throw error;
  }
}

async function activate(store: HarnessRunStore, currentTenant: string, currentIntegration: string, origin: string,
  currentRepository: string, repositoryId: number): Promise<PublicationBinding> {
  await store.registerIntegration({ tenantId: currentTenant, id: currentIntegration, platform: "github", origin,
    repository: currentRepository });
  const authority = new PublicationAuthorityStore(adminDb);
  await authority.configure({ tenantId: currentTenant, integrationId: currentIntegration, providerRepositoryId: repositoryId,
    providerActorId: 99, credentialRef: "env:GITHUB_TOKEN", expectedVersion: 0 });
  const active = await authority.transition({ tenantId: currentTenant, integrationId: currentIntegration, expectedVersion: 1,
    action: "activate", actor: "capacity", actorType: "service", quiescenceEvidence: "isolated capacity fixture" });
  await adminPool.query(`UPDATE pr_agent_harness.integration_bindings
    SET review_execution_mode='harness_async',execution_mode_generation=1 WHERE tenant_id=$1 AND id=$2`,
  [currentTenant, currentIntegration]);
  return { ...active, reviewExecutionMode: "harness_async", executionModeGeneration: 1 };
}

function runInput(currentTenant: string, currentIntegration: string, key: string, authorityGeneration: number,
  executionModeGeneration: number) {
  return { tenantId: currentTenant, integrationId: currentIntegration, actorType: "service" as const,
    actorId: "capacity", createScope: key.startsWith("worker-") ? "capacity-worker" : "capacity-fixture", createKey: key,
    requestHash: hash(key), runType: "capacity.noop.v1", baseSha: "base", headSha: "head",
    workflowVersionHash: versionHash, promptVersionHash: versionHash, modelVersionHash: versionHash,
    toolVersionHash: versionHash, policyVersionHash: versionHash, runtimeVersionHash: versionHash,
    authorityGeneration, executionModeGeneration, runtimeConfig: { maxJobAttempts: 3, maxStepAttempts: 3 },
    limits: { maxRunMs: 3_600_000, maxJobAttempts: 3, maxStepAttempts: 3 }, input: { capacityKey: key } };
}

async function intake(key: string, number: number, latencies: number[]): Promise<{ ok: boolean; created: boolean }> {
  const started = performance.now();
  const response = await fetch(`${apiOrigin}/runs`, { method: "POST", headers: { authorization: `Bearer ${apiToken}`,
    "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify({ number, mode: "report" }) });
  latencies.push(performance.now() - started);
  const value = await response.json() as { created?: boolean };
  return { ok: response.status === 202, created: value.created === true };
}

async function openSse(runId: string, token: string, after?: string) {
  const controller = new AbortController();
  const url = `${apiOrigin}/runs/${runId}/events/stream${after ? `?after=${encodeURIComponent(after)}` : ""}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  if (response.status !== 200 || !response.body) throw new Error(`SSE open failed with ${response.status}`);
  const reader = response.body.getReader();
  let text = "";
  let cursor: string | undefined;
  for (let chunk = 0; chunk < 8 && !cursor; chunk += 1) {
    const next = await boundedRead(reader, 5_000, controller);
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
    cursor = /^id: (.+)$/m.exec(text)?.[1];
  }
  if (!cursor) throw new Error("SSE history did not include a durable cursor");
  if (after && parseRunCursor(runId, cursor) <= parseRunCursor(runId, after)) {
    controller.abort();
    throw new Error("SSE reconnect did not advance beyond the supplied cursor");
  }
  return { controller, reader, cursor };
}

async function boundedRead(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number,
  controller: AbortController): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error(`SSE first frame exceeded ${timeoutMs}ms`));
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function concurrent(count: number, concurrency: number, fn: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) { const index = next; next += 1; await fn(index); }
  }));
}

async function grantRuntimeRole(pool: Pool, roleName: string): Promise<void> {
  await pool.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${roleName};
    GRANT SELECT ON pr_agent_harness.integration_bindings,pr_agent_harness.review_artifacts TO ${roleName};
    GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.agent_runs,pr_agent_harness.job_queue,
      pr_agent_harness.repository_operations,pr_agent_harness.publication_slots,pr_agent_harness.publication_batches TO ${roleName};
    GRANT SELECT,INSERT ON pr_agent_harness.publication_batch_operations,pr_agent_harness.run_events,
      pr_agent_harness.audit_logs,pr_agent_harness.publication_command_receipts TO ${roleName};
    REVOKE UPDATE,DELETE ON pr_agent_harness.publication_batch_operations FROM ${roleName};
    GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(uuid,uuid,text,text,text,bigint),
      pr_agent_harness.skip_failed_batch_successors(uuid,uuid),
      pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
      pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
      pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO ${roleName};
    GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.agent_steps,pr_agent_harness.step_attempts,
      pr_agent_harness.tool_calls,pr_agent_harness.model_calls,pr_agent_harness.tenant_budget_accounts,
      pr_agent_harness.run_budget_envelopes,pr_agent_harness.model_budget_reservations,
      pr_agent_harness.run_command_receipts,pr_agent_harness.run_waits TO ${roleName};
    GRANT SELECT,INSERT ON pr_agent_harness.checkpoints,pr_agent_harness.run_publication_batches,
      pr_agent_harness.dead_letter_jobs,pr_agent_harness.usage_records,pr_agent_harness.model_pricing_snapshots,
      pr_agent_harness.run_wait_decisions TO ${roleName}`);
}

function pricing(admitted: number): string {
  return JSON.stringify({ version: "capacity-pricing-v1", currency: "USD", periodKey: "capacity",
    tenantLimits: { inputTokens: admitted * 1_000, outputTokens: admitted * 1_000, costMicros: 0 },
    runLimits: { inputTokens: 1_000, outputTokens: 1_000, costMicros: 0 }, models: {
      "openai-compatible:capacity-model": { rates: { inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0,
        cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0, thoughtOutputMicrosPerMillion: 0,
        toolInputMicrosPerMillion: 0 }, maxOutputTokens: 1_000, maxPhysicalCallsPerStep: 3,
      openAiTokenParameter: "max_tokens" },
    } });
}

function blockedResponse(): EventEmitter & { destroyed: boolean; writableEnded: boolean; writableLength: number;
  ended: boolean; writeHead: () => unknown; flushHeaders: () => void; write: (chunk: string) => boolean; end: () => unknown } {
  const response = new EventEmitter() as EventEmitter & { destroyed: boolean; writableEnded: boolean; writableLength: number;
    ended: boolean; writeHead: () => unknown; flushHeaders: () => void; write: (chunk: string) => boolean; end: () => unknown };
  response.destroyed = false; response.writableEnded = false; response.writableLength = 0; response.ended = false;
  response.writeHead = () => response; response.flushHeaders = () => undefined;
  response.write = (chunk) => { response.writableLength += Buffer.byteLength(chunk); return false; };
  response.end = () => { response.ended = true; response.writableEnded = true; return response; };
  return response;
}

function percentileSummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(2));
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Number((sorted.at(-1) ?? 0).toFixed(2)) };
}
function arg(name: string): string | undefined { return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function progress(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, phase: currentPhase, elapsedMs: Date.now() - startedAt.getTime(), ...details }));
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function delayUntil(target: number): Promise<void> { const remaining = target - Date.now(); if (remaining > 0) await delay(remaining); }
