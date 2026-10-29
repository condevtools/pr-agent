import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../postgres/database.js";
import {
  type ModelExecutionContext,
  type ModelProvider,
  type ModelRequestIntent,
  type ModelTransportResult,
  type NormalizedModelUsage,
} from "../../model/execution-context.js";
import { assertRunLease } from "../execution/store.js";
import type { RunLease } from "../runs/contracts.js";
import { deepBudgetSchema, deepRolePrefix } from "../../review/deep/budget.js";

export interface ModelPriceRates {
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  cacheWriteInputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  thoughtOutputMicrosPerMillion: number;
  toolInputMicrosPerMillion: number;
}

export interface ModelBudgetLimits {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface ModelExecutionPolicy {
  version: string;
  hash: string;
  currency: string;
  periodKey: string;
  provider: ModelProvider;
  model: string;
  rates: ModelPriceRates;
  tenantLimits: ModelBudgetLimits;
  runLimits: ModelBudgetLimits;
  maxOutputTokens: number;
  maxPhysicalCallsPerStep: number;
  openAiTokenParameter?: "max_completion_tokens" | "max_tokens";
}

export interface PreparedModelCall {
  id: string;
  tenantId: string;
  runId: string;
  stepId: string;
  stepAttemptId: string;
  physicalOrdinal: number;
  requestHash: string;
  status: "prepared" | "in_flight" | "succeeded" | "failed_definite" | "unknown";
  response?: unknown;
  reservationStatus: "reserved" | "settled" | "released" | "pending";
}

export class ModelBudgetExceededError extends Error {
  constructor(readonly scope: "tenant" | "run") {
    super(`${scope} model budget is exhausted`);
    this.name = "ModelBudgetExceededError";
  }
}

export class ModelCallConflictError extends Error {
  constructor() {
    super("physical model call ordinal was reused with a different request");
    this.name = "ModelCallConflictError";
  }
}

export class ModelBudgetStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async reserveRun(input: {
    tenantId: string;
    runId: string;
    policy: ModelExecutionPolicy;
  }): Promise<void> {
    return this.db.transaction(input.tenantId, (client) =>
      reserveRunBudgetInTransaction(client, input));
  }

  async prepare(input: {
    lease: RunLease;
    stepId: string;
    stepAttemptId: string;
    physicalOrdinal: number;
    intent: ModelRequestIntent;
    policy: ModelExecutionPolicy;
  }): Promise<PreparedModelCall> {
    return this.db.transaction(input.lease.tenantId, async (client) => {
      await assertRunLease(client, input.lease);
      validatePolicy(input.policy);
      if (input.intent.provider !== input.policy.provider ||
          input.intent.model !== input.policy.model ||
          input.intent.maxOutputTokens > input.policy.maxOutputTokens ||
          input.physicalOrdinal > input.policy.maxPhysicalCallsPerStep) {
        throw new ModelCallConflictError();
      }
      await reconcilePriorAttemptCalls(
        client,
        input.lease.tenantId,
        input.lease.runId,
        input.stepId,
        input.stepAttemptId,
      );
      const existing = await selectCallByAttemptOrdinal(
        client,
        input.lease.tenantId,
        input.lease.runId,
        input.stepAttemptId,
        input.physicalOrdinal,
      );
      if (existing) {
        if (existing.request_hash !== input.intent.requestHash ||
            existing.provider !== input.intent.provider ||
            existing.model !== input.intent.model) {
          throw new ModelCallConflictError();
        }
        return mapCall(existing);
      }
      const reusable = await selectReusableKnownCall(
        client,
        input.lease.tenantId,
        input.lease.runId,
        input.stepId,
        input.intent,
      );
      if (reusable) return mapCall(reusable);

      const envelope = await client.query<EnvelopeRow>(
        `SELECT * FROM pr_agent_harness.run_budget_envelopes
         WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
        [input.lease.tenantId, input.lease.runId],
      );
      const budget = envelope.rows[0];
      if (!budget || budget.overdrawn ||
          !["active", "pending_reconciliation"].includes(budget.status) ||
          budget.pricing_hash !== input.policy.hash) {
        throw new ModelBudgetExceededError("run");
      }
      const physicalCalls = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pr_agent_harness.model_calls
         WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3
           AND (sent_at IS NOT NULL OR status='prepared')`,
        [input.lease.tenantId, input.lease.runId, input.stepId],
      );
      if (Number(physicalCalls.rows[0]?.count ?? 0) >= input.policy.maxPhysicalCallsPerStep) {
        throw new ModelBudgetExceededError("run");
      }
      const reservedCost = estimateMaximumCost(input.intent, input.policy.rates);
      if (input.lease.input.workflow === "review.deep.v1" || input.lease.input.workflow === "eval.replay.v1") {
        const partitions = deepBudgetSchema.parse(input.lease.runtimeConfig.deepBudget);
        const step = await client.query<{ step_key: string }>(
          `SELECT step_key FROM pr_agent_harness.agent_steps WHERE tenant_id=$1 AND run_id=$2 AND id=$3`,
          [input.lease.tenantId, input.lease.runId, input.stepId],
        );
        const role = deepRolePrefix(step.rows[0]?.step_key ?? "");
        const prefix = role === "critic" ? "deep.critic" : `deep.role.${role}.`;
        const used = await client.query<{ input: string; output: string; cost: string }>(
          `SELECT coalesce(sum(br.reserved_input_tokens),0)::text AS input,
                  coalesce(sum(br.reserved_output_tokens),0)::text AS output,
                  coalesce(sum(br.reserved_cost_micros),0)::text AS cost
           FROM pr_agent_harness.model_budget_reservations br
           JOIN pr_agent_harness.model_calls mc ON mc.tenant_id=br.tenant_id AND mc.id=br.model_call_id
           JOIN pr_agent_harness.agent_steps s ON s.tenant_id=mc.tenant_id AND s.id=mc.step_id AND s.run_id=mc.run_id
           WHERE br.tenant_id=$1 AND br.run_id=$2 AND br.status<>'released' AND starts_with(s.step_key,$3)`,
          [input.lease.tenantId, input.lease.runId, prefix],
        );
        const consumed = used.rows[0]!;
        const cap = partitions[role];
        if (Number(consumed.input) + input.intent.inputTokenUpperBound > cap.inputTokens ||
            Number(consumed.output) + input.intent.maxOutputTokens > cap.outputTokens ||
            Number(consumed.cost) + reservedCost > cap.costMicros) throw new ModelBudgetExceededError("run");
      }
      if (
        Number(budget.allocated_input_tokens) + input.intent.inputTokenUpperBound > Number(budget.input_token_limit) ||
        Number(budget.allocated_output_tokens) + input.intent.maxOutputTokens > Number(budget.output_token_limit) ||
        Number(budget.allocated_cost_micros) + reservedCost > Number(budget.cost_limit_micros)
      ) throw new ModelBudgetExceededError("run");

      const inserted = await client.query<ModelCallRow>(
        `INSERT INTO pr_agent_harness.model_calls (
           tenant_id,run_id,step_id,step_attempt_id,physical_ordinal,
           provider,model,request_kind,request_hash,request_metadata_json,
           input_token_bound,output_token_bound,lease_epoch
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
         RETURNING *`,
        [input.lease.tenantId, input.lease.runId, input.stepId, input.stepAttemptId,
          input.physicalOrdinal, input.intent.provider, input.intent.model,
          input.intent.requestKind, input.intent.requestHash,
          JSON.stringify(input.intent.metadata ?? {}), input.intent.inputTokenUpperBound,
          input.intent.maxOutputTokens, input.lease.epoch],
      );
      const row = inserted.rows[0]!;
      await client.query(
        `INSERT INTO pr_agent_harness.model_budget_reservations (
           tenant_id,run_id,model_call_id,reserved_input_tokens,
           reserved_output_tokens,reserved_cost_micros
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.lease.tenantId, input.lease.runId, row.id,
          input.intent.inputTokenUpperBound, input.intent.maxOutputTokens, reservedCost],
      );
      await client.query(
        `UPDATE pr_agent_harness.run_budget_envelopes
         SET allocated_input_tokens=allocated_input_tokens+$3,
             allocated_output_tokens=allocated_output_tokens+$4,
             allocated_cost_micros=allocated_cost_micros+$5,updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2`,
        [input.lease.tenantId, input.lease.runId,
          input.intent.inputTokenUpperBound, input.intent.maxOutputTokens, reservedCost],
      );
      return mapCall({ ...row, reservation_status: "reserved" });
    });
  }

  async markDispatched(call: PreparedModelCall, lease: RunLease): Promise<void> {
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease);
      const result = await client.query(
        `UPDATE pr_agent_harness.model_calls
         SET status='in_flight',sent_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='prepared'`,
        [lease.tenantId, lease.runId, call.id],
      );
      if (result.rowCount !== 1) throw new ModelCallConflictError();
    });
  }

  async settleKnown<T>(input: {
    call: PreparedModelCall;
    lease: RunLease;
    policy: ModelExecutionPolicy;
    result: ModelTransportResult<T>;
  }): Promise<void> {
    await this.db.transaction(input.lease.tenantId, async (client) => {
      await assertRunLease(client, input.lease);
      const response = sanitizeResponse(input.result.rawResponse);
      const responseHash = hashJson(response);
      const usage = input.result.usage;
      const actual = usage
        ? calculateActualModelUsage(usage, input.policy.rates, input.policy.provider)
        : undefined;
      const updated = await client.query(
        `UPDATE pr_agent_harness.model_calls
         SET status='succeeded',response_json=$4::jsonb,response_hash=$5,
             provider_request_id=$6,provider_model_version=$7,finished_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='in_flight'`,
        [input.lease.tenantId, input.lease.runId, input.call.id,
          JSON.stringify(response), responseHash, input.result.providerRequestId ?? null,
          input.result.modelVersion ?? null],
      );
      if (updated.rowCount !== 1) {
        if (await isMatchingSettledCall(
          client,
          input.call,
          "succeeded",
          responseHash,
        )) return;
        throw new ModelCallConflictError();
      }
      if (usage && actual) {
        await upsertUsage(client, input, usage, actual.costMicros, "actual");
        await settleReservation(client, input.call, actual);
      } else {
        await upsertUsage(client, input, undefined, undefined, "unavailable");
        await markReservationPending(client, input.call);
      }
    });
  }

  async settleUnknown(input: {
    call: PreparedModelCall;
    lease: RunLease;
    errorCode: string;
    providerRequestId?: string;
  }): Promise<void> {
    await this.db.transaction(input.lease.tenantId, async (client) => {
      // A lost lease cannot release or overwrite an uncertain external cost.
      const result = await client.query(
        `UPDATE pr_agent_harness.model_calls
         SET status='unknown',error_code=$4,provider_request_id=COALESCE($5,provider_request_id)
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status IN ('prepared','in_flight')`,
        [input.lease.tenantId, input.lease.runId, input.call.id,
          requiredText(input.errorCode, "model error code"), input.providerRequestId ?? null],
      );
      if (result.rowCount === 1) await markReservationPending(client, input.call);
    });
  }

  async settleProviderFailure<T>(input: {
    call: PreparedModelCall;
    lease: RunLease;
    policy: ModelExecutionPolicy;
    result: ModelTransportResult<T>;
  }): Promise<void> {
    await this.db.transaction(input.lease.tenantId, async (client) => {
      await assertRunLease(client, input.lease);
      const response = sanitizeResponse(input.result.rawResponse);
      const responseHash = hashJson(response);
      const updated = await client.query(
        `UPDATE pr_agent_harness.model_calls
         SET status='failed_definite',response_json=$4::jsonb,response_hash=$5,
             provider_request_id=$6,provider_model_version=$7,
             error_code=$8,finished_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='in_flight'`,
        [input.lease.tenantId, input.lease.runId, input.call.id,
          JSON.stringify(response), responseHash, input.result.providerRequestId ?? null,
          input.result.modelVersion ?? null, `provider_http_${input.result.httpStatus}`],
      );
      if (updated.rowCount !== 1) {
        if (await isMatchingSettledCall(
          client,
          input.call,
          "failed_definite",
          responseHash,
        )) return;
        throw new ModelCallConflictError();
      }
      if (input.result.usage) {
        const actual = calculateActualModelUsage(
          input.result.usage,
          input.policy.rates,
          input.policy.provider,
        );
        if (actual) {
          await upsertUsage(client, input, input.result.usage, actual.costMicros, "actual");
          await settleReservation(client, input.call, actual);
        } else {
          await upsertUsage(client, input, undefined, undefined, "unavailable");
          await markReservationPending(client, input.call);
        }
      } else {
        await upsertUsage(client, input, undefined, undefined, "unavailable");
        await markReservationPending(client, input.call);
      }
    });
  }

  async releaseUnsent(call: PreparedModelCall, lease: RunLease, errorCode: string): Promise<void> {
    await this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease);
      const reservation = await selectReservationForUpdate(client, call);
      if (!reservation || reservation.status !== "reserved") return;
      const result = await client.query(
        `UPDATE pr_agent_harness.model_calls
         SET status='failed_definite',error_code=$4,finished_at=now()
         WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND status='prepared'`,
        [lease.tenantId, lease.runId, call.id, requiredText(errorCode, "model error code")],
      );
      if (result.rowCount !== 1) return;
      await releaseReservation(client, call, reservation);
    });
  }

  async closeRunBudget(lease: RunLease): Promise<"closed" | "pending_reconciliation"> {
    return this.db.transaction(lease.tenantId, async (client) => {
      await assertRunLease(client, lease);
      return closeEnvelope(client, lease.tenantId, lease.runId);
    });
  }

  async closeTerminalBudgets(
    tenantId: string,
    limit = 100,
  ): Promise<{ closed: number; pending: number }> {
    positiveInteger(limit, "terminal budget close limit");
    return this.db.transaction(tenantId, async (client) => {
      const candidates = await client.query<{ run_id: string }>(
        `SELECT e.run_id
         FROM pr_agent_harness.run_budget_envelopes e
         JOIN pr_agent_harness.agent_runs r
           ON r.tenant_id=e.tenant_id AND r.id=e.run_id
         WHERE e.tenant_id=$1 AND e.status<>'closed'
           AND r.status IN ('succeeded','failed','cancelled')
         ORDER BY e.updated_at,e.run_id
         FOR UPDATE OF e SKIP LOCKED LIMIT $2`,
        [tenantId, limit],
      );
      let closed = 0;
      let pending = 0;
      for (const candidate of candidates.rows) {
        await releaseTerminalPreparedCalls(client, tenantId, candidate.run_id);
        await markTerminalInflightCallsUnknown(client, tenantId, candidate.run_id);
        if (await closeEnvelope(client, tenantId, candidate.run_id) === "closed") closed += 1;
        else pending += 1;
      }
      return { closed, pending };
    });
  }
}

export async function reserveRunBudgetInTransaction(
  client: PoolClient,
  input: { tenantId: string; runId: string; policy: ModelExecutionPolicy },
): Promise<void> {
  validatePolicy(input.policy);
  await client.query(
    `INSERT INTO pr_agent_harness.model_pricing_snapshots (
       tenant_id,pricing_hash,pricing_version,provider,model,currency,rates_json,policy_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
     ON CONFLICT (tenant_id,pricing_hash) DO NOTHING`,
    [input.tenantId, input.policy.hash, input.policy.version, input.policy.provider,
      input.policy.model, input.policy.currency, JSON.stringify(input.policy.rates),
      JSON.stringify(input.policy)],
  );
  await client.query(
    `INSERT INTO pr_agent_harness.tenant_budget_accounts (
       tenant_id,period_key,currency,input_token_limit,output_token_limit,cost_limit_micros
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id,period_key,currency) DO NOTHING`,
    [input.tenantId, input.policy.periodKey, input.policy.currency,
      input.policy.tenantLimits.inputTokens, input.policy.tenantLimits.outputTokens,
      input.policy.tenantLimits.costMicros],
  );
  const account = await client.query<AccountRow>(
    `SELECT * FROM pr_agent_harness.tenant_budget_accounts
     WHERE tenant_id=$1 AND period_key=$2 AND currency=$3 FOR UPDATE`,
    [input.tenantId, input.policy.periodKey, input.policy.currency],
  );
  const row = account.rows[0]!;
  const existingEnvelope = await client.query<{ pricing_hash: string }>(
    `SELECT pricing_hash FROM pr_agent_harness.run_budget_envelopes
     WHERE tenant_id=$1 AND run_id=$2`, [input.tenantId, input.runId]);
  if (existingEnvelope.rows[0]) {
    if (existingEnvelope.rows[0].pricing_hash !== input.policy.hash) {
      throw new Error("Run budget was already reserved with another pricing policy");
    }
    return;
  }
  if (
    Number(row.input_token_limit) !== input.policy.tenantLimits.inputTokens ||
    Number(row.output_token_limit) !== input.policy.tenantLimits.outputTokens ||
    Number(row.cost_limit_micros) !== input.policy.tenantLimits.costMicros || row.overdrawn ||
    Number(row.reserved_input_tokens) + Number(row.spent_input_tokens) + input.policy.runLimits.inputTokens > Number(row.input_token_limit) ||
    Number(row.reserved_output_tokens) + Number(row.spent_output_tokens) + input.policy.runLimits.outputTokens > Number(row.output_token_limit) ||
    Number(row.reserved_cost_micros) + Number(row.spent_cost_micros) + input.policy.runLimits.costMicros > Number(row.cost_limit_micros)
  ) throw new ModelBudgetExceededError("tenant");
  const inserted = await client.query(
    `INSERT INTO pr_agent_harness.run_budget_envelopes (
       tenant_id,run_id,period_key,currency,pricing_hash,
       input_token_limit,output_token_limit,cost_limit_micros
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id,run_id) DO NOTHING`,
    [input.tenantId, input.runId, input.policy.periodKey, input.policy.currency,
      input.policy.hash, input.policy.runLimits.inputTokens,
      input.policy.runLimits.outputTokens, input.policy.runLimits.costMicros],
  );
  if (inserted.rowCount !== 1) return;
  await client.query(
    `UPDATE pr_agent_harness.tenant_budget_accounts
     SET reserved_input_tokens=reserved_input_tokens+$4,
         reserved_output_tokens=reserved_output_tokens+$5,
         reserved_cost_micros=reserved_cost_micros+$6,updated_at=now()
     WHERE tenant_id=$1 AND period_key=$2 AND currency=$3`,
    [input.tenantId, input.policy.periodKey, input.policy.currency,
      input.policy.runLimits.inputTokens, input.policy.runLimits.outputTokens,
      input.policy.runLimits.costMicros],
  );
}

export function createBudgetedModelExecutionContext(input: {
  store: ModelBudgetStore;
  lease: RunLease;
  stepId: string;
  stepAttemptId: string;
  policy: ModelExecutionPolicy;
}): ModelExecutionContext {
  let ordinal = 0;
  return {
    policy: input.policy,
    async execute<T>(intent: ModelRequestIntent, transport: () => Promise<ModelTransportResult<T>>): Promise<T> {
      const bounded = { ...intent, maxOutputTokens: Math.min(intent.maxOutputTokens, input.policy.maxOutputTokens) };
      ordinal += 1;
      const call = await input.store.prepare({ ...input, physicalOrdinal: ordinal, intent: bounded });
      if (call.status === "succeeded" || call.status === "failed_definite") {
        return call.response as T;
      }
      if (call.status !== "prepared") throw new Error("model call requires reconciliation before retry");
      await input.store.markDispatched(call, input.lease);
      try {
        const result = await transport();
        if (result.httpStatus !== undefined && result.httpStatus >= 400) {
          await input.store.settleProviderFailure({ call, lease: input.lease, policy: input.policy, result });
        } else {
          await input.store.settleKnown({ call, lease: input.lease, policy: input.policy, result });
        }
        return result.value;
      } catch (error) {
        await input.store.settleUnknown({
          call,
          lease: input.lease,
          errorCode: error instanceof Error ? error.name : "model_transport_error",
        });
        throw error;
      }
    },
  };
}

export function getModelExecutionPolicy(
  provider: ModelProvider,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelExecutionPolicy {
  const raw = env.HARNESS_MODEL_PRICING_JSON?.trim();
  if (!raw) {
    if (env.NODE_ENV === "test" && env.HARNESS_ALLOW_ZERO_COST_MODEL_POLICY === "isolated-test-only") {
      return buildTestPolicy(provider, model);
    }
    throw new Error("HARNESS_MODEL_PRICING_JSON is required for durable model execution");
  }
  const root = JSON.parse(raw) as Record<string, unknown>;
  const models = object(root.models, "models");
  const selected = object(models[`${provider}:${model}`], "model pricing entry");
  const withoutHash = {
    version: text(root.version, "pricing version"),
    currency: currency(root.currency),
    periodKey: text(root.periodKey, "budget period"),
    provider,
    model,
    rates: rates(selected.rates),
    tenantLimits: limits(root.tenantLimits),
    runLimits: limits(root.runLimits),
    maxOutputTokens: positiveInteger(selected.maxOutputTokens, "max output tokens"),
    maxPhysicalCallsPerStep: positiveInteger(
      selected.maxPhysicalCallsPerStep,
      "maximum physical calls per step",
    ),
    ...(provider === "openai"
      ? { openAiTokenParameter: optionalOpenAiTokenParameter(selected.openAiTokenParameter) ?? "max_completion_tokens" }
      : provider === "openai-compatible"
        ? { openAiTokenParameter: requiredOpenAiTokenParameter(selected.openAiTokenParameter) }
        : {}),
  };
  return { ...withoutHash, hash: hashJson(withoutHash) };
}

interface ModelCallRow {
  id: string; tenant_id: string; run_id: string; step_id: string; step_attempt_id: string;
  physical_ordinal: number; provider: ModelProvider; model: string; request_hash: string;
  status: PreparedModelCall["status"]; response_json: unknown; reservation_status?: PreparedModelCall["reservationStatus"];
}
interface EnvelopeRow {
  period_key: string; currency: string; pricing_hash: string; status: string;
  overdrawn: boolean;
  input_token_limit: string; output_token_limit: string; cost_limit_micros: string;
  allocated_input_tokens: string; allocated_output_tokens: string; allocated_cost_micros: string;
  actual_input_tokens: string; actual_output_tokens: string; actual_cost_micros: string;
}
interface AccountRow {
  input_token_limit: string; output_token_limit: string; cost_limit_micros: string;
  reserved_input_tokens: string; reserved_output_tokens: string; reserved_cost_micros: string;
  spent_input_tokens: string; spent_output_tokens: string; spent_cost_micros: string; overdrawn: boolean;
}
interface ReservationRow {
  status: PreparedModelCall["reservationStatus"];
  reserved_input_tokens: string; reserved_output_tokens: string; reserved_cost_micros: string;
}

async function selectCallByAttemptOrdinal(client: PoolClient, tenantId: string, runId: string, stepAttemptId: string, ordinal: number): Promise<ModelCallRow | undefined> {
  const result = await client.query<ModelCallRow & { reservation_status: PreparedModelCall["reservationStatus"] }>(
    `SELECT mc.*,r.status AS reservation_status FROM pr_agent_harness.model_calls mc
     JOIN pr_agent_harness.model_budget_reservations r ON r.tenant_id=mc.tenant_id AND r.model_call_id=mc.id
     WHERE mc.tenant_id=$1 AND mc.run_id=$2 AND mc.step_attempt_id=$3 AND mc.physical_ordinal=$4`,
    [tenantId, runId, stepAttemptId, ordinal],
  );
  return result.rows[0];
}

async function selectReusableKnownCall(
  client: PoolClient,
  tenantId: string,
  runId: string,
  stepId: string,
  intent: ModelRequestIntent,
): Promise<ModelCallRow | undefined> {
  const result = await client.query<ModelCallRow & { reservation_status: PreparedModelCall["reservationStatus"] }>(
    `SELECT mc.*,r.status AS reservation_status
     FROM pr_agent_harness.model_calls mc
     JOIN pr_agent_harness.model_budget_reservations r
       ON r.tenant_id=mc.tenant_id AND r.model_call_id=mc.id
     WHERE mc.tenant_id=$1 AND mc.run_id=$2 AND mc.step_id=$3
       AND mc.provider=$4 AND mc.model=$5 AND mc.request_hash=$6
       AND mc.status IN ('succeeded','failed_definite')
       AND mc.response_json IS NOT NULL
     ORDER BY mc.finished_at DESC,mc.id DESC LIMIT 1`,
    [tenantId, runId, stepId, intent.provider, intent.model, intent.requestHash],
  );
  return result.rows[0];
}

async function reconcilePriorAttemptCalls(
  client: PoolClient,
  tenantId: string,
  runId: string,
  stepId: string,
  currentAttemptId: string,
): Promise<void> {
  const prepared = await client.query<{
    id: string;
    reserved_input_tokens: string;
    reserved_output_tokens: string;
    reserved_cost_micros: string;
  }>(
    `UPDATE pr_agent_harness.model_calls mc
     SET status='failed_definite',error_code='step_attempt_replaced_before_dispatch',finished_at=now()
     FROM pr_agent_harness.model_budget_reservations br
     WHERE mc.tenant_id=$1 AND mc.run_id=$2 AND mc.step_id=$3
       AND mc.step_attempt_id<>$4 AND mc.status='prepared'
       AND br.tenant_id=mc.tenant_id AND br.model_call_id=mc.id AND br.status='reserved'
     RETURNING mc.id,br.reserved_input_tokens,br.reserved_output_tokens,br.reserved_cost_micros`,
    [tenantId, runId, stepId, currentAttemptId],
  );
  for (const row of prepared.rows) {
    const released = await client.query(
      `UPDATE pr_agent_harness.model_budget_reservations
       SET status='released',updated_at=now()
       WHERE tenant_id=$1 AND model_call_id=$2 AND status='reserved'`,
      [tenantId, row.id],
    );
    if (released.rowCount !== 1) continue;
    await client.query(
      `UPDATE pr_agent_harness.run_budget_envelopes
       SET allocated_input_tokens=allocated_input_tokens-$3,
           allocated_output_tokens=allocated_output_tokens-$4,
           allocated_cost_micros=allocated_cost_micros-$5,updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, runId, Number(row.reserved_input_tokens),
        Number(row.reserved_output_tokens), Number(row.reserved_cost_micros)],
    );
  }
  const calls = await client.query<{ id: string }>(
    `UPDATE pr_agent_harness.model_calls
     SET status='unknown',error_code=COALESCE(error_code,'step_attempt_replaced')
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3
       AND step_attempt_id<>$4 AND status='in_flight'
     RETURNING id`,
    [tenantId, runId, stepId, currentAttemptId],
  );
  if (!calls.rowCount) return;
  await client.query(
    `UPDATE pr_agent_harness.model_budget_reservations
     SET status='pending',updated_at=now()
     WHERE tenant_id=$1 AND model_call_id=ANY($2::uuid[]) AND status='reserved'`,
    [tenantId, calls.rows.map((row) => row.id)],
  );
  await client.query(
    `UPDATE pr_agent_harness.run_budget_envelopes
     SET status='pending_reconciliation',updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId],
  );
}

function mapCall(row: ModelCallRow): PreparedModelCall {
  return { id: row.id, tenantId: row.tenant_id, runId: row.run_id, stepId: row.step_id,
    stepAttemptId: row.step_attempt_id, physicalOrdinal: Number(row.physical_ordinal),
    requestHash: row.request_hash, status: row.status, response: row.response_json,
    reservationStatus: row.reservation_status ?? "reserved" };
}

function estimateMaximumCost(intent: ModelRequestIntent, rates: ModelPriceRates): number {
  return pricedParts([
    [intent.inputTokenUpperBound, Math.max(
      rates.inputMicrosPerMillion,
      rates.cachedInputMicrosPerMillion,
      rates.cacheWriteInputMicrosPerMillion,
      rates.toolInputMicrosPerMillion,
    )],
    [intent.maxOutputTokens, Math.max(
      rates.outputMicrosPerMillion,
      rates.thoughtOutputMicrosPerMillion,
    )],
  ]);
}

export function calculateActualModelUsage(
  usage: NormalizedModelUsage,
  ratesValue: ModelPriceRates,
  provider: ModelProvider,
): { inputTokens: number; outputTokens: number; costMicros: number } | undefined {
  const values = [usage.inputTokens, usage.cachedInputTokens,
    usage.cacheWriteInputTokens, usage.outputTokens,
    usage.reasoningOrThoughtTokens, usage.toolInputTokens];
  if (values.some((value) => value !== undefined && !isNonnegativeInteger(value)) ||
      usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;

  const input = usage.inputTokens;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const output = usage.outputTokens;
  const thought = usage.reasoningOrThoughtTokens ?? 0;
  const tool = usage.toolInputTokens ?? 0;
  if ((provider === "openai" || provider === "openai-compatible" || provider === "gemini") &&
      cached > input) return undefined;

  if (provider === "anthropic") {
    return {
      inputTokens: input + cached + cacheWrite,
      outputTokens: output,
      costMicros: pricedParts([
        [input, ratesValue.inputMicrosPerMillion],
        [cached, ratesValue.cachedInputMicrosPerMillion],
        [cacheWrite, ratesValue.cacheWriteInputMicrosPerMillion],
        [output, ratesValue.outputMicrosPerMillion],
      ]),
    };
  }
  if (provider === "gemini") {
    return {
      inputTokens: input + tool,
      outputTokens: output + thought,
      costMicros: pricedParts([
        [input - cached, ratesValue.inputMicrosPerMillion],
        [cached, ratesValue.cachedInputMicrosPerMillion],
        [tool, ratesValue.toolInputMicrosPerMillion],
        [output, ratesValue.outputMicrosPerMillion],
        [thought, ratesValue.thoughtOutputMicrosPerMillion],
      ]),
    };
  }
  // OpenAI prompt/completion totals already include cached/reasoning subsets.
  return {
    inputTokens: input,
    outputTokens: output,
    costMicros: pricedParts([
      [input - cached, ratesValue.inputMicrosPerMillion],
      [cached, ratesValue.cachedInputMicrosPerMillion],
      [output, ratesValue.outputMicrosPerMillion],
    ]),
  };
}

async function settleReservation(client: PoolClient, call: PreparedModelCall, actual: { inputTokens: number; outputTokens: number; costMicros: number }) {
  const reservation = await selectReservationForUpdate(client, call);
  if (!reservation || reservation.status === "settled") return;
  if (reservation.status !== "reserved") throw new ModelCallConflictError();
  await client.query(
    `UPDATE pr_agent_harness.model_budget_reservations
     SET status='settled',actual_input_tokens=$3,actual_output_tokens=$4,
         actual_cost_micros=$5,updated_at=now()
     WHERE tenant_id=$1 AND model_call_id=$2`,
    [call.tenantId, call.id, actual.inputTokens, actual.outputTokens, actual.costMicros],
  );
  await client.query(
    `UPDATE pr_agent_harness.run_budget_envelopes
     SET actual_input_tokens=actual_input_tokens+$3,
         actual_output_tokens=actual_output_tokens+$4,
         actual_cost_micros=actual_cost_micros+$5,
         overdrawn=overdrawn
           OR actual_input_tokens+$3>input_token_limit
           OR actual_output_tokens+$4>output_token_limit
           OR actual_cost_micros+$5>cost_limit_micros,
         status=CASE WHEN actual_input_tokens+$3>input_token_limit
                           OR actual_output_tokens+$4>output_token_limit
                           OR actual_cost_micros+$5>cost_limit_micros
                     THEN 'pending_reconciliation' ELSE status END,
         updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2`,
    [call.tenantId, call.runId, actual.inputTokens, actual.outputTokens, actual.costMicros],
  );
}

async function markReservationPending(client: PoolClient, call: PreparedModelCall) {
  await client.query(
    `UPDATE pr_agent_harness.model_budget_reservations SET status='pending',updated_at=now()
     WHERE tenant_id=$1 AND model_call_id=$2 AND status='reserved'`,
    [call.tenantId, call.id],
  );
  await client.query(
    `UPDATE pr_agent_harness.run_budget_envelopes SET status='pending_reconciliation',updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2 AND status='active'`,
    [call.tenantId, call.runId],
  );
}

async function selectReservationForUpdate(client: PoolClient, call: PreparedModelCall): Promise<ReservationRow | undefined> {
  const result = await client.query<ReservationRow>(
    `SELECT * FROM pr_agent_harness.model_budget_reservations
     WHERE tenant_id=$1 AND model_call_id=$2 FOR UPDATE`, [call.tenantId, call.id]);
  return result.rows[0];
}

async function isMatchingSettledCall(
  client: PoolClient,
  call: PreparedModelCall,
  status: "succeeded" | "failed_definite",
  responseHash: string,
): Promise<boolean> {
  const result = await client.query<{ status: string; response_hash: string | null }>(
    `SELECT status,response_hash FROM pr_agent_harness.model_calls
     WHERE tenant_id=$1 AND run_id=$2 AND id=$3`,
    [call.tenantId, call.runId, call.id],
  );
  return result.rows[0]?.status === status && result.rows[0].response_hash === responseHash;
}

async function releaseReservation(client: PoolClient, call: PreparedModelCall, row: ReservationRow) {
  await client.query(
    `UPDATE pr_agent_harness.model_budget_reservations SET status='released',updated_at=now()
     WHERE tenant_id=$1 AND model_call_id=$2`, [call.tenantId, call.id]);
  await client.query(
    `UPDATE pr_agent_harness.run_budget_envelopes
     SET allocated_input_tokens=allocated_input_tokens-$3,
         allocated_output_tokens=allocated_output_tokens-$4,
         allocated_cost_micros=allocated_cost_micros-$5,updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2`,
    [call.tenantId, call.runId, Number(row.reserved_input_tokens),
      Number(row.reserved_output_tokens), Number(row.reserved_cost_micros)],
  );
}

async function releaseTerminalPreparedCalls(
  client: PoolClient,
  tenantId: string,
  runId: string,
): Promise<void> {
  const rows = await client.query<{
    id: string;
    reserved_input_tokens: string;
    reserved_output_tokens: string;
    reserved_cost_micros: string;
  }>(
    `UPDATE pr_agent_harness.model_calls mc
     SET status='failed_definite',error_code='run_terminal_before_dispatch',finished_at=now()
     FROM pr_agent_harness.model_budget_reservations br
     WHERE mc.tenant_id=$1 AND mc.run_id=$2 AND mc.status='prepared'
       AND br.tenant_id=mc.tenant_id AND br.model_call_id=mc.id AND br.status='reserved'
     RETURNING mc.id,br.reserved_input_tokens,br.reserved_output_tokens,br.reserved_cost_micros`,
    [tenantId, runId],
  );
  for (const row of rows.rows) {
    const released = await client.query(
      `UPDATE pr_agent_harness.model_budget_reservations
       SET status='released',updated_at=now()
       WHERE tenant_id=$1 AND model_call_id=$2 AND status='reserved'`,
      [tenantId, row.id],
    );
    if (released.rowCount !== 1) continue;
    await client.query(
      `UPDATE pr_agent_harness.run_budget_envelopes
       SET allocated_input_tokens=allocated_input_tokens-$3,
           allocated_output_tokens=allocated_output_tokens-$4,
           allocated_cost_micros=allocated_cost_micros-$5,updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, runId, Number(row.reserved_input_tokens),
        Number(row.reserved_output_tokens), Number(row.reserved_cost_micros)],
    );
  }
}

async function markTerminalInflightCallsUnknown(
  client: PoolClient,
  tenantId: string,
  runId: string,
): Promise<void> {
  const calls = await client.query<{ id: string }>(
    `UPDATE pr_agent_harness.model_calls
     SET status='unknown',error_code='run_terminal_response_unknown'
     WHERE tenant_id=$1 AND run_id=$2 AND status='in_flight'
     RETURNING id`,
    [tenantId, runId],
  );
  if (!calls.rowCount) return;
  await client.query(
    `UPDATE pr_agent_harness.model_budget_reservations
     SET status='pending',updated_at=now()
     WHERE tenant_id=$1 AND model_call_id=ANY($2::uuid[]) AND status='reserved'`,
    [tenantId, calls.rows.map((row) => row.id)],
  );
  await client.query(
    `UPDATE pr_agent_harness.run_budget_envelopes
     SET status='pending_reconciliation',updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId],
  );
}

async function closeEnvelope(
  client: PoolClient,
  tenantId: string,
  runId: string,
): Promise<"closed" | "pending_reconciliation"> {
  const envelope = await client.query<EnvelopeRow>(
    `SELECT * FROM pr_agent_harness.run_budget_envelopes
     WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [tenantId, runId],
  );
  const row = envelope.rows[0];
  if (!row || row.status === "closed") return "closed";
  const pending = await client.query(
    `SELECT 1 FROM pr_agent_harness.model_budget_reservations
     WHERE tenant_id=$1 AND run_id=$2 AND status IN ('reserved','pending') LIMIT 1`,
    [tenantId, runId],
  );
  if (pending.rowCount) {
    await client.query(
      `UPDATE pr_agent_harness.run_budget_envelopes
       SET status='pending_reconciliation',updated_at=now()
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, runId],
    );
    return "pending_reconciliation";
  }
  await client.query(
    `UPDATE pr_agent_harness.tenant_budget_accounts
     SET reserved_input_tokens=reserved_input_tokens-$4,
         reserved_output_tokens=reserved_output_tokens-$5,
         reserved_cost_micros=reserved_cost_micros-$6,
         spent_input_tokens=spent_input_tokens+$7,
         spent_output_tokens=spent_output_tokens+$8,
         spent_cost_micros=spent_cost_micros+$9,
         overdrawn=overdrawn
           OR spent_input_tokens+$7>input_token_limit
           OR spent_output_tokens+$8>output_token_limit
           OR spent_cost_micros+$9>cost_limit_micros,
         updated_at=now()
     WHERE tenant_id=$1 AND period_key=$2 AND currency=$3`,
    [tenantId, row.period_key, row.currency, Number(row.input_token_limit),
      Number(row.output_token_limit), Number(row.cost_limit_micros),
      Number(row.actual_input_tokens), Number(row.actual_output_tokens),
      Number(row.actual_cost_micros)],
  );
  await client.query(
    `UPDATE pr_agent_harness.run_budget_envelopes
     SET status='closed',closed_at=now(),updated_at=now()
     WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId],
  );
  return "closed";
}

async function upsertUsage<T>(client: PoolClient, input: { call: PreparedModelCall; lease: RunLease; policy: ModelExecutionPolicy; result: ModelTransportResult<T> }, usage: NormalizedModelUsage | undefined, cost: number | undefined, status: "actual" | "unavailable") {
  await client.query(
    `INSERT INTO pr_agent_harness.usage_records (
       tenant_id,run_id,model_call_id,measurement_status,input_tokens,cached_input_tokens,
       cache_write_input_tokens,output_tokens,reasoning_tokens,tool_input_tokens,total_tokens,
       cost_micros,currency,pricing_hash,original_usage_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT (tenant_id,model_call_id) DO NOTHING`,
    [input.lease.tenantId, input.lease.runId, input.call.id, status,
      usage?.inputTokens ?? null, usage?.cachedInputTokens ?? null,
      usage?.cacheWriteInputTokens ?? null, usage?.outputTokens ?? null,
      usage?.reasoningOrThoughtTokens ?? null, usage?.toolInputTokens ?? null,
      usage?.totalTokens ?? null, cost ?? null, input.policy.currency, input.policy.hash,
      JSON.stringify(usage?.original ?? {})],
  );
}

function sanitizeResponse(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > 1_048_576) {
    throw new Error("model response exceeds the durable checkpoint limit");
  }
  return JSON.parse(json) as unknown;
}

function validatePolicy(policy: ModelExecutionPolicy) {
  requiredText(policy.version, "pricing version");
  requiredText(policy.periodKey, "budget period");
  requiredText(policy.model, "model");
  if (!["openai", "openai-compatible", "anthropic", "gemini"].includes(policy.provider)) {
    throw new Error("unsupported model provider in pricing policy");
  }
  currency(policy.currency);
  positiveInteger(policy.maxOutputTokens, "max output tokens");
  positiveInteger(policy.maxPhysicalCallsPerStep, "maximum physical calls per step");
  if ((policy.provider === "openai" || policy.provider === "openai-compatible") &&
      policy.openAiTokenParameter !== "max_tokens" &&
      policy.openAiTokenParameter !== "max_completion_tokens") {
    throw new Error("OpenAI token parameter capability must be frozen in the pricing policy");
  }
  if (hashJson({ ...policy, hash: undefined }) !== policy.hash) {
    // getModelExecutionPolicy hashes the object before adding hash; tolerate callers that do the same explicitly.
    const { hash: _hash, ...withoutHash } = policy;
    if (hashJson(withoutHash) !== policy.hash) throw new Error("model pricing policy hash mismatch");
  }
  limits(policy.tenantLimits); limits(policy.runLimits); rates(policy.rates);
}

function buildTestPolicy(provider: ModelProvider, model: string): ModelExecutionPolicy {
  const withoutHash = { version: "isolated-test-zero-v1", currency: "USD", periodKey: "isolated-test",
    provider, model, rates: { inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0,
      cacheWriteInputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      thoughtOutputMicrosPerMillion: 0, toolInputMicrosPerMillion: 0 },
    tenantLimits: { inputTokens: 10_000_000, outputTokens: 10_000_000, costMicros: 0 },
    runLimits: { inputTokens: 100_000, outputTokens: 100_000, costMicros: 0 },
    maxOutputTokens: 8192, maxPhysicalCallsPerStep: 8,
    ...(provider === "openai" || provider === "openai-compatible"
      ? { openAiTokenParameter: "max_completion_tokens" as const }
      : {}) };
  return { ...withoutHash, hash: hashJson(withoutHash) };
}

function rates(value: unknown): ModelPriceRates { const row = object(value, "model rates"); return {
  inputMicrosPerMillion: nonnegativeInteger(row.inputMicrosPerMillion, "input rate"),
  cachedInputMicrosPerMillion: nonnegativeInteger(row.cachedInputMicrosPerMillion, "cached input rate"),
  cacheWriteInputMicrosPerMillion: nonnegativeInteger(row.cacheWriteInputMicrosPerMillion, "cache write rate"),
  outputMicrosPerMillion: nonnegativeInteger(row.outputMicrosPerMillion, "output rate"),
  thoughtOutputMicrosPerMillion: nonnegativeInteger(row.thoughtOutputMicrosPerMillion, "thought rate"),
  toolInputMicrosPerMillion: nonnegativeInteger(row.toolInputMicrosPerMillion, "tool input rate") } }
function limits(value: unknown): ModelBudgetLimits { const row = object(value, "model limits"); return {
  inputTokens: nonnegativeInteger(row.inputTokens, "input limit"), outputTokens: nonnegativeInteger(row.outputTokens, "output limit"),
  costMicros: nonnegativeInteger(row.costMicros, "cost limit") } }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown>; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`); return value.trim(); }
function requiredText(value: string, name: string): string { return text(value, name); }
function currency(value: unknown): string { const result = text(value, "currency").toUpperCase(); if (!/^[A-Z]{3}$/.test(result)) throw new Error("currency must be an ISO-style code"); return result; }
function optionalOpenAiTokenParameter(value: unknown): "max_completion_tokens" | "max_tokens" | undefined { if (value === undefined) return undefined; return requiredOpenAiTokenParameter(value); }
function requiredOpenAiTokenParameter(value: unknown): "max_completion_tokens" | "max_tokens" { if (value === "max_completion_tokens" || value === "max_tokens") return value; throw new Error("openAiTokenParameter must declare max_completion_tokens or max_tokens"); }
function positiveInteger(value: unknown, name: string): number { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be positive`); return result; }
function nonnegativeInteger(value: unknown, name: string): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} must be nonnegative`); return result; }
function isNonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function pricedParts(parts: ReadonlyArray<readonly [number, number]>): number {
  const numerator = parts.reduce(
    (sum, [tokens, rate]) => sum + BigInt(tokens) * BigInt(rate),
    0n,
  );
  const result = (numerator + 999_999n) / 1_000_000n;
  const numeric = Number(result);
  if (!Number.isSafeInteger(numeric)) throw new Error("model cost exceeds safe integer precision");
  return numeric;
}
function hashJson(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([,item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
