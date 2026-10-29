import type { PoolClient } from "pg";

import { HarnessDatabase } from "./database.js";

export type IntegrationPlatform = "github" | "gitlab";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "retry_wait"
  | "waiting_for_reconciliation";

export interface RegisterIntegrationInput {
  tenantId: string;
  id: string;
  platform: IntegrationPlatform;
  origin: string;
  repository: string;
}

export interface CreateRunInput {
  tenantId: string;
  integrationId: string;
  actorType: "user" | "service" | "system";
  actorId: string;
  createScope: string;
  createKey: string;
  requestHash: string;
  runType: string;
  baseSha: string;
  headSha: string;
  workflowVersionHash: string;
  promptVersionHash: string;
  modelVersionHash: string;
  toolVersionHash: string;
  policyVersionHash: string;
  runtimeVersionHash: string;
  input: Record<string, unknown>;
  authorityGeneration?: number;
  runtimeConfig?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  deadlineAt?: string;
  parentRunId?: string;
  executionModeGeneration?: number;
  admission?: (client: PoolClient, runId: string) => Promise<void>;
}

export interface CreatedRun {
  id: string;
  tenantId: string;
  status: RunStatus;
  version: number;
  created: boolean;
  jobId: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class HarnessRunStore {
  constructor(private readonly db: HarnessDatabase) {}

  async registerIntegration(input: RegisterIntegrationInput): Promise<void> {
    const target = normalizeIntegrationTarget(input.platform, input.origin, input.repository);
    await this.db.trustedTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO pr_agent_harness.integration_bindings
            (id, tenant_id, platform, origin, repository)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (platform, origin, repository) DO NOTHING
        `,
        [input.id, input.tenantId, input.platform, target.origin, target.repository],
      );
      const binding = await this.lookupIntegration(
        client,
        input.platform,
        target.origin,
        target.repository,
      );
      if (!binding || binding.id !== input.id || binding.tenantId !== input.tenantId) {
        throw new Error("integration target is already bound to another tenant or identity");
      }
    });
  }

  async resolveIntegration(
    platform: IntegrationPlatform,
    origin: string,
    repository: string,
  ): Promise<{ tenantId: string; id: string }> {
    const target = normalizeIntegrationTarget(platform, origin, repository);
    return this.db.trustedTransaction(async (client) => {
      const binding = await this.lookupIntegration(
        client,
        platform,
        target.origin,
        target.repository,
      );
      if (!binding) {
        throw new Error("trusted integration binding not found");
      }
      return binding;
    });
  }

  async createRun(input: CreateRunInput): Promise<CreatedRun> {
    return this.db.transaction(input.tenantId, (client) => createRunInTransaction(client, input));
  }

  static async createRunInTransaction(
    client: PoolClient,
    input: CreateRunInput,
  ): Promise<CreatedRun> {
    validateCreateRunInput(input);
    const execution = normalizeRunExecutionConfig(input);
      const binding = await client.query(
        `
          SELECT 1
          FROM pr_agent_harness.integration_bindings
          WHERE tenant_id = $1 AND id = $2 AND active
        `,
        [input.tenantId, input.integrationId],
      );
      if (binding.rowCount !== 1) {
        throw new Error("active integration binding not found for tenant");
      }
      if (input.executionModeGeneration !== undefined) {
        const duplicate = await client.query<{ integration_id: string; request_hash: string }>(
          `SELECT integration_id,request_hash
           FROM pr_agent_harness.agent_runs
           WHERE tenant_id=$1 AND create_scope=$2 AND create_key=$3`,
          [input.tenantId, input.createScope, input.createKey],
        );
        if (duplicate.rows[0]) {
          if (duplicate.rows[0].integration_id !== input.integrationId
              || duplicate.rows[0].request_hash !== input.requestHash) {
            throw new RunCreateConflictError();
          }
          const resumable = await client.query<{ allowed: boolean }>(
            `SELECT pr_agent_harness.lock_resumable_review_execution_authority(
               $1::uuid,$2::uuid,$3::bigint,$4::bigint
             ) AS allowed`,
            [input.tenantId, input.integrationId, input.authorityGeneration ?? 0,
              input.executionModeGeneration],
          );
          if (!resumable.rows[0]?.allowed) {
            throw new Error("asynchronous review execution authority no longer matches the Run");
          }
        } else {
          const authority = await client.query<{ allowed: boolean }>(
            `SELECT pr_agent_harness.lock_active_review_execution_authority(
               $1::uuid,$2::uuid,$3::bigint,$4::bigint
             ) AS allowed`,
            [input.tenantId, input.integrationId, input.authorityGeneration ?? 0,
              input.executionModeGeneration],
          );
          if (!authority.rows[0]?.allowed) {
            throw new Error("active asynchronous review execution authority not found");
          }
        }
      }

      const inserted = await client.query<{
        id: string;
        tenant_id: string;
        status: RunStatus;
        version: string;
      }>(
        `
          INSERT INTO pr_agent_harness.agent_runs (
            tenant_id, integration_id, created_by_actor_type, created_by_actor_id,
            create_scope, create_key, request_hash, run_type, base_sha, head_sha,
            workflow_version_hash, prompt_version_hash, model_version_hash,
            tool_version_hash, policy_version_hash, runtime_version_hash, input_json,
            authority_generation, execution_mode_generation,
            runtime_config_json, limits_json, deadline_at,
            parent_run_id, next_event_seq
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17::jsonb,
            $18, $19, $20::jsonb, $21::jsonb,
            CASE WHEN $22::double precision IS NOT NULL
              THEN now() + ($22::double precision * interval '1 millisecond')
              ELSE COALESCE($23::timestamptz, now() + interval '15 minutes')
            END,
            $24, 2
          )
          ON CONFLICT (tenant_id, create_scope, create_key) DO NOTHING
          RETURNING id, tenant_id, status, version
        `,
        [
          input.tenantId,
          input.integrationId,
          input.actorType,
          input.actorId,
          input.createScope,
          input.createKey,
          input.requestHash,
          input.runType,
          input.baseSha,
          input.headSha,
          input.workflowVersionHash,
          input.promptVersionHash,
          input.modelVersionHash,
          input.toolVersionHash,
          input.policyVersionHash,
          input.runtimeVersionHash,
          JSON.stringify(input.input),
          input.authorityGeneration ?? 0,
          input.executionModeGeneration ?? 0,
          JSON.stringify(execution.runtimeConfig),
          JSON.stringify(execution.limits),
          execution.maxRunMs,
          input.deadlineAt ?? null,
          input.parentRunId ?? null,
        ],
      );

      let run = inserted.rows[0];
      const created = Boolean(run);
      if (!run) {
        const existing = await client.query<{
          id: string;
          tenant_id: string;
          status: RunStatus;
          version: string;
          request_hash: string;
        }>(
          `
            SELECT id, tenant_id, status, version, request_hash
            FROM pr_agent_harness.agent_runs
            WHERE tenant_id = $1 AND create_scope = $2 AND create_key = $3
          `,
          [input.tenantId, input.createScope, input.createKey],
        );
        const found = existing.rows[0];
        if (!found) {
          throw new Error("run idempotency conflict could not be resolved");
        }
        if (found.request_hash !== input.requestHash) {
          throw new RunCreateConflictError();
        }
        run = found;
      }

      let jobId: string;
      if (created) {
        await input.admission?.(client, run.id);
        await client.query(
          `
            INSERT INTO pr_agent_harness.run_events
              (tenant_id, run_id, sequence, event_type, visibility, actor_type, actor_id, payload_json)
            VALUES ($1, $2, 1, 'run.created', 'public', $3, $4, $5::jsonb)
          `,
          [
            input.tenantId,
            run.id,
            input.actorType,
            input.actorId,
            JSON.stringify({ runType: input.runType, baseSha: input.baseSha, headSha: input.headSha }),
          ],
        );
        const job = await client.query<{ id: string }>(
          `INSERT INTO pr_agent_harness.job_queue
             (tenant_id,run_id,job_kind,max_attempts)
           VALUES ($1,$2,'start',$3) RETURNING id`,
          [input.tenantId, run.id, execution.maxJobAttempts],
        );
        jobId = requiredRow(job.rows[0], "created run job").id;
        await client.query(
          `
            INSERT INTO pr_agent_harness.audit_logs
              (tenant_id, run_id, actor_type, actor_id, action, decision, resource_type, resource_ref, details_json)
            VALUES ($1, $2, $3, $4, 'run.create', 'allowed', 'agent_run', $2::uuid::text, $5::jsonb)
          `,
          [
            input.tenantId,
            run.id,
            input.actorType,
            input.actorId,
            JSON.stringify({ createScope: input.createScope, requestHash: input.requestHash }),
          ],
        );
      } else {
        const existingJob = await client.query<{ id: string }>(
          `
            SELECT id FROM pr_agent_harness.job_queue
            WHERE tenant_id = $1 AND run_id = $2 AND job_kind = 'start'
            ORDER BY created_at ASC LIMIT 1
          `,
          [input.tenantId, run.id],
        );
        jobId = requiredRow(existingJob.rows[0], "existing run job").id;
      }

      return {
        id: run.id,
        tenantId: run.tenant_id,
        status: run.status,
        version: Number(run.version),
        created,
        jobId,
      };
  }

  private async lookupIntegration(
    client: PoolClient,
    platform: IntegrationPlatform,
    origin: string,
    repository: string,
  ): Promise<{ tenantId: string; id: string } | undefined> {
    const result = await client.query<{ tenant_id: string; id: string }>(
      `
        SELECT tenant_id, id
        FROM pr_agent_harness.integration_bindings
        WHERE platform = $1 AND origin = $2 AND repository = $3 AND active
      `,
      [platform, origin, repository],
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, id: row.id } : undefined;
  }
}

export async function createRunInTransaction(
  client: PoolClient,
  input: CreateRunInput,
): Promise<CreatedRun> {
  return HarnessRunStore.createRunInTransaction(client, input);
}

export class RunCreateConflictError extends Error {
  constructor() {
    super("create key was already used with a different request hash");
    this.name = "RunCreateConflictError";
  }
}

export function normalizeIntegrationTarget(
  platform: IntegrationPlatform,
  origin: string,
  repository: string,
): { origin: string; repository: string } {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("integration origin must be HTTP(S)");
  }
  if (parsed.username || parsed.password) {
    throw new Error("integration origin must not contain credentials");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  let normalizedRepository = repository.trim();
  if (!normalizedRepository || normalizedRepository.startsWith("/") || normalizedRepository.endsWith("/")) {
    throw new Error(`${platform} repository must be a non-empty canonical path`);
  }
  if (platform === "github") {
    normalizedRepository = normalizedRepository.toLowerCase();
  }
  return { origin: parsed.toString().replace(/\/$/, ""), repository: normalizedRepository };
}

function validateCreateRunInput(input: CreateRunInput): void {
  const hashes = [
    input.requestHash,
    input.workflowVersionHash,
    input.promptVersionHash,
    input.modelVersionHash,
    input.toolVersionHash,
    input.policyVersionHash,
    input.runtimeVersionHash,
  ];
  if (hashes.some((value) => !SHA256_PATTERN.test(value))) {
    throw new Error("run request and component hashes must be lowercase SHA-256 values");
  }
  const required = [
    input.actorId,
    input.createScope,
    input.createKey,
    input.runType,
    input.baseSha,
    input.headSha,
  ];
  if (required.some((value) => !value.trim())) {
    throw new Error("run identity and revision fields must be non-empty");
  }
  for (const [name, value] of [
    ["authority generation", input.authorityGeneration],
    ["execution mode generation", input.executionModeGeneration],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  if (input.executionModeGeneration !== undefined
      && (input.executionModeGeneration === 0 || !input.authorityGeneration)) {
    throw new Error("asynchronous Run creation requires positive authority generations");
  }
  if (input.deadlineAt !== undefined && Number.isNaN(Date.parse(input.deadlineAt))) {
    throw new Error("run deadline must be an ISO-compatible timestamp");
  }
  if (input.executionModeGeneration !== undefined && input.deadlineAt !== undefined) {
    throw new Error("asynchronous Run deadlines must use runtimeConfig.maxRunMs");
  }
}

function normalizeRunExecutionConfig(input: CreateRunInput): {
  runtimeConfig: Record<string, unknown>;
  limits: Record<string, unknown>;
  maxRunMs: number | null;
  maxJobAttempts: number;
} {
  const runtimeConfig = {
    pollMs: 1_000,
    leaseTtlMs: 60_000,
    heartbeatMs: 15_000,
    sweeperMs: 5_000,
    maxRunMs: 15 * 60_000,
    maxJobAttempts: 3,
    ...input.runtimeConfig,
  };
  const limits = { maxStepAttempts: 3, ...input.limits };
  const maxRunMs = input.deadlineAt === undefined
    ? positiveConfigInteger(runtimeConfig.maxRunMs, "runtimeConfig.maxRunMs")
    : null;
  const runtimeAttempts = optionalConfigInteger(
    input.runtimeConfig?.maxJobAttempts,
    "runtimeConfig.maxJobAttempts",
  );
  const limitAttempts = optionalConfigInteger(input.limits?.maxJobAttempts, "limits.maxJobAttempts");
  if (runtimeAttempts !== undefined && limitAttempts !== undefined
      && runtimeAttempts !== limitAttempts) {
    throw new Error("runtimeConfig.maxJobAttempts and limits.maxJobAttempts must match");
  }
  const maxJobAttempts = runtimeAttempts ?? limitAttempts ?? 3;
  runtimeConfig.maxJobAttempts = maxJobAttempts;
  limits.maxStepAttempts = positiveConfigInteger(limits.maxStepAttempts, "limits.maxStepAttempts");
  return { runtimeConfig, limits, maxRunMs, maxJobAttempts };
}

function optionalConfigInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveConfigInteger(value, name);
}

function positiveConfigInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requiredRow<T>(row: T | undefined, description: string): T {
  if (!row) {
    throw new Error(`missing ${description}`);
  }
  return row;
}
