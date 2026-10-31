import { randomUUID } from "node:crypto";

import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { RUN_PERMISSIONS, type RunPermission,
  type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { resolveQualityConfiguration,
  type QualityConfiguration } from "../config.js";
import { LangfuseQualityClient } from "../langfuse/client.js";
import type { LangfuseQualityPort } from "../langfuse/contracts.js";
import { PgQualityAnnotationStore } from "../storage/annotation-store.js";
import type { EnqueueQualitySyncJobInput, QualityScope, QualitySyncJob,
  QualitySyncLease } from "../storage/contracts.js";
import { PgQualityPromptStore } from "../storage/prompt-store.js";
import { PgQualitySyncJobStore } from "../storage/sync-job-store.js";
import { PgQualityTraceStore } from "../storage/trace-store.js";
import { createQualitySyncHandlers } from "./exporters.js";
import { createPromptPullHandler } from "./prompt-handler.js";

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type QualityLoopConfiguration = QualityConfiguration;

export interface DueQualityScope extends QualityScope {
  queueState: "ready" | "expired_lease" | "exhausted";
  dueJobs: number;
}

interface QualitySyncJobStorePort {
  enqueue(scope: QualityScope, input: EnqueueQualitySyncJobInput): Promise<QualitySyncJob>;
  claim(scope: QualityScope, input: { owner: string; limit?: number; leaseMs?: number }): Promise<QualitySyncLease[]>;
  heartbeat(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number },
    leaseMs: number): Promise<QualitySyncJob>;
  complete(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number },
    result: Record<string, unknown>): Promise<QualitySyncJob>;
  fail(scope: QualityScope, lease: { jobId: string; owner: string; epoch: number },
    input: { errorCode: string; retryAfterMs?: number }): Promise<QualitySyncJob>;
}

export type QualitySyncRuntimeHandler = (job: QualitySyncJob,
  context?: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

export interface QualitySyncTickResult {
  disabled: boolean;
  busy?: boolean;
  scopes: number;
  claimed: number;
  succeeded: number;
  failed: number;
}

export interface CreateQualitySyncLoopInput {
  db: RuntimeDatabase;
  env?: NodeJS.ProcessEnv;
  configuration?: QualityLoopConfiguration;
  client?: LangfuseQualityPort;
  handlers?: Partial<Record<QualitySyncJob["kind"], QualitySyncRuntimeHandler>>;
  jobStore?: QualitySyncJobStorePort;
  discoverScopes?: (limit: number) => Promise<DueQualityScope[]>;
  assertPrincipalCurrent?: (principal: RunPrincipal) => void | Promise<void>;
  onError?: (error: unknown) => void;
  automatic?: boolean;
}

interface LoopPolicy {
  pollMs: number;
  scopeLimit: number;
  claimLimit: number;
  leaseMs: number;
  jobTimeoutMs: number;
  stopWaitMs: number;
  abortSettleMs: number;
}

export class QualitySyncLoop {
  readonly owner = `quality-sync:${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private active?: Promise<QualitySyncTickResult>;
  private started = false;
  private stopped = false;
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    readonly enabled: boolean,
    private readonly discoverScopes: (limit: number) => Promise<DueQualityScope[]>,
    private readonly store: QualitySyncJobStorePort,
    private readonly handlers: Partial<Record<QualitySyncJob["kind"], QualitySyncRuntimeHandler>>,
    private readonly policy: LoopPolicy,
    private readonly assertPrincipalCurrent: (principal: RunPrincipal) => void | Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly automatic: boolean,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.enabled) return;
    if (!this.automatic) { await this.tick(); return; }
    try { await this.tick(); }
    catch (error) { this.onError(error); }
    finally {
      if (!this.stopped) {
        this.timer = setInterval(() => { void this.tick().catch(this.onError); }, this.policy.pollMs);
        this.timer.unref();
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.activeControllers) controller.abort();
    if (this.active) {
      await Promise.race([this.active.catch(() => undefined), delay(this.policy.stopWaitMs)]);
    }
  }

  async tick(): Promise<QualitySyncTickResult> {
    if (!this.enabled || this.stopped) return { disabled: !this.enabled, scopes: 0, claimed: 0, succeeded: 0, failed: 0 };
    if (this.active) return { disabled: false, busy: true, scopes: 0, claimed: 0, succeeded: 0, failed: 0 };
    const active = this.runTick();
    this.active = active;
    try { return await active; }
    finally { if (this.active === active) this.active = undefined; }
  }

  private async runTick(): Promise<QualitySyncTickResult> {
    const scopes = await this.discoverScopes(this.policy.scopeLimit);
    const result: QualitySyncTickResult = { disabled: false, scopes: scopes.length,
      claimed: 0, succeeded: 0, failed: 0 };
    const available = new Set(scopes.map((_, index) => index));
    for (let round = 0; round < this.policy.claimLimit && available.size > 0 && !this.stopped; round += 1) {
      for (const index of [...available]) {
        if (this.stopped) break;
        const scope = scopes[index]!;
        const leases = await this.store.claim(scope, { owner: this.owner, limit: 1, leaseMs: this.policy.leaseMs });
        if (leases.length === 0) { available.delete(index); continue; }
        const lease = leases[0]!;
        result.claimed += 1;
        const handler = this.handlers[lease.kind];
        try {
          if (!handler) throw new QualitySyncRuntimeError("QUALITY_SYNC_HANDLER_MISSING");
          const output = await this.executeLease(scope, lease, handler);
          await this.store.complete(scope, { jobId: lease.id, owner: this.owner, epoch: lease.leaseEpoch }, output);
          result.succeeded += 1;
        } catch (error) {
          await this.store.fail(scope, { jobId: lease.id, owner: this.owner, epoch: lease.leaseEpoch },
            { errorCode: sanitizedErrorCode(error) });
          result.failed += 1;
        }
      }
    }
    return result;
  }

  private async executeLease(scope: QualityScope, lease: QualitySyncLease,
    handler: QualitySyncRuntimeHandler): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let rejectGuard: (reason: QualitySyncRuntimeError) => void = () => undefined;
    const guard = new Promise<never>((_resolve, reject) => { rejectGuard = reject; });
    const abort = (code: string) => {
      rejectGuard(new QualitySyncRuntimeError(code));
      if (!controller.signal.aborted) controller.abort();
    };
    const onAbort = () => rejectGuard(new QualitySyncRuntimeError("QUALITY_SYNC_CANCELLED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => abort("QUALITY_SYNC_JOB_TIMEOUT"), this.policy.jobTimeoutMs);
    deadline.unref();
    let heartbeatActive = false;
    const heartbeat = setInterval(() => {
      if (heartbeatActive || controller.signal.aborted) return;
      heartbeatActive = true;
      void this.store.heartbeat(scope, { jobId: lease.id, owner: this.owner, epoch: lease.leaseEpoch },
        this.policy.leaseMs).catch(() => abort("QUALITY_SYNC_LEASE_LOST")).finally(() => { heartbeatActive = false; });
    }, Math.max(250, Math.floor(this.policy.leaseMs / 3)));
    heartbeat.unref();
    try {
      await this.assertPrincipalCurrent(parsePrincipalSnapshot(lease.principal));
      const work = handler(lease, { signal: controller.signal });
      try { return await Promise.race([work, guard]); }
      catch (error) {
        if (controller.signal.aborted) {
          await Promise.race([work.then(() => undefined, () => undefined), delay(this.policy.abortSettleMs)]);
        }
        throw error;
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      controller.signal.removeEventListener("abort", onAbort);
      this.activeControllers.delete(controller);
    }
  }
}

export class QualitySyncRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QualitySyncRuntimeError";
  }
}

export function createQualitySyncLoop(input: CreateQualitySyncLoopInput): QualitySyncLoop {
  const env = input.env ?? process.env;
  const configuration = input.configuration ?? resolveLoopConfiguration(env);
  const policy = readPolicy(env);
  if (!configuration.enabled) {
    return new QualitySyncLoop(false, async () => [], input.jobStore ?? new PgQualitySyncJobStore(input.db), {},
      policy, input.assertPrincipalCurrent ?? (() => undefined), input.onError ?? (() => undefined), input.automatic ?? true);
  }
  if (!HASH.test(configuration.targetFingerprint) || !configuration.secretKey) {
    throw new QualitySyncRuntimeError("QUALITY_SYNC_CONFIGURATION_INVALID");
  }
  if (!input.assertPrincipalCurrent) {
    throw new QualitySyncRuntimeError("QUALITY_SYNC_PRINCIPAL_VALIDATOR_REQUIRED");
  }
  const client = input.client ?? new LangfuseQualityClient({ publicKey: configuration.publicKey,
    secretKey: configuration.secretKey, baseUrl: configuration.baseUrl,
    timeoutMs: readInteger(env.QUALITY_SYNC_REQUEST_TIMEOUT_MS, 5_000, 100, 30_000,
      "QUALITY_SYNC_REQUEST_TIMEOUT_MS"), maxRetries: 1 });
  const promptStore = new PgQualityPromptStore(input.db);
  const store = input.jobStore ?? new PgQualitySyncJobStore(input.db);
  const handlers: Partial<Record<QualitySyncJob["kind"], QualitySyncRuntimeHandler>> = {
    ...createQualitySyncHandlers({ db: input.db, client, traceStore: new PgQualityTraceStore(input.db),
      annotationStore: new PgQualityAnnotationStore(input.db), targetFingerprint: configuration.targetFingerprint, env,
      enqueueContinuation: (scope, job) => store.enqueue(scope, job) }),
    prompt_pull: createPromptPullHandler({ client, promptStore, targetFingerprint: configuration.targetFingerprint }),
    ...input.handlers,
  };
  const discover = input.discoverScopes ?? ((limit) => discoverDueScopes(input.db, limit));
  return new QualitySyncLoop(true, discover, store, handlers,
    policy, input.assertPrincipalCurrent, input.onError ?? (() => undefined), input.automatic ?? true);
}

export async function discoverDueScopes(db: RuntimeDatabase, limit: number): Promise<DueQualityScope[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new QualitySyncRuntimeError("QUALITY_SYNC_SCOPE_LIMIT_INVALID");
  }
  return db.trustedTransaction(async (client) => {
    const result = await client.query<{ tenant_id: string; integration_id: string;
      queue_state: DueQualityScope["queueState"]; due_jobs: number }>(
      "SELECT * FROM pr_agent_harness.quality_sync_due_scopes($1)", [limit]);
    return result.rows.map((row) => ({ tenantId: row.tenant_id, integrationId: row.integration_id,
      queueState: row.queue_state, dueJobs: Number(row.due_jobs) }));
  });
}

function resolveLoopConfiguration(env: NodeJS.ProcessEnv): QualityLoopConfiguration {
  try { return resolveQualityConfiguration(env); }
  catch { throw new QualitySyncRuntimeError("QUALITY_SYNC_CONFIGURATION_INVALID"); }
}

function readPolicy(env: NodeJS.ProcessEnv): LoopPolicy {
  return {
    pollMs: readInteger(env.QUALITY_SYNC_POLL_MS, 1_000, 100, 60_000, "QUALITY_SYNC_POLL_MS"),
    scopeLimit: readInteger(env.QUALITY_SYNC_SCOPE_LIMIT, 20, 1, 100, "QUALITY_SYNC_SCOPE_LIMIT"),
    claimLimit: readInteger(env.QUALITY_SYNC_CLAIM_LIMIT, 4, 1, 20, "QUALITY_SYNC_CLAIM_LIMIT"),
    leaseMs: readInteger(env.QUALITY_SYNC_LEASE_MS, 60_000, 1_000, 15 * 60_000, "QUALITY_SYNC_LEASE_MS"),
    jobTimeoutMs: readInteger(env.QUALITY_SYNC_JOB_TIMEOUT_MS, 15 * 60_000, 1_000, 2 * 60 * 60_000,
      "QUALITY_SYNC_JOB_TIMEOUT_MS"),
    stopWaitMs: readInteger(env.QUALITY_SYNC_STOP_WAIT_MS, 5_000, 100, 45_000, "QUALITY_SYNC_STOP_WAIT_MS"),
    abortSettleMs: readInteger(env.QUALITY_SYNC_REQUEST_TIMEOUT_MS, 5_000, 100, 30_000,
      "QUALITY_SYNC_REQUEST_TIMEOUT_MS"),
  };
}

function readInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (raw === undefined || !raw.trim()) return fallback;
  if (!/^[0-9]+$/u.test(raw.trim())) throw new QualitySyncRuntimeError(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new QualitySyncRuntimeError(`${name}_INVALID`);
  }
  return value;
}

function sanitizedErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,159}$/u.test(code)
    ? code : "QUALITY_SYNC_FAILED";
}

function parsePrincipalSnapshot(value: Record<string, unknown>): RunPrincipal {
  if (typeof value.subjectId !== "string" || value.subjectId.length < 1 || value.subjectId.length > 512
      || (value.actorType !== "user" && value.actorType !== "service")
      || typeof value.tenantId !== "string" || !UUID.test(value.tenantId)
      || typeof value.integrationId !== "string" || !UUID.test(value.integrationId)
      || !Array.isArray(value.permissions) || value.permissions.some((permission) => typeof permission !== "string"
        || !RUN_PERMISSIONS.includes(permission as RunPermission))) {
    throw new QualitySyncRuntimeError("QUALITY_PRINCIPAL_INVALID");
  }
  return { subjectId: value.subjectId, actorType: value.actorType, tenantId: value.tenantId,
    integrationId: value.integrationId, permissions: [...new Set(value.permissions as RunPermission[])] };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
