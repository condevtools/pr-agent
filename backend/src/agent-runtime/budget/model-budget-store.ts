import { createHash } from "node:crypto";
import { logCore } from "#core";

import type { PoolClient } from "pg";

import { RuntimeDatabase } from "../postgres/database.js";
import { measureDatabaseOperation } from "../database-timing.js";
import {
  type ModelExecutionContext,
  type ModelObservationPayload,
  type ModelProvider,
  type ModelRequestIntent,
  type ModelTransportResult,
  type NormalizedModelUsage,
} from "../../model/execution-context.js";
import { assertRunLease } from "../execution/store.js";
import type { RunLease } from "../runs/contracts.js";
import { deepBudgetSchema, deepRolePrefix } from "../../review/deep/budget.js";
import { observeAgentOperation, parseAgentPromptReference } from "../../observability/index.js";
import { modelObservationUsage } from "../../model/observability.js";

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

export interface ModelUsageReconciliationInput {
  tenantId: string;
  integrationId: string;
  runId: string;
  modelCallId: string;
  providerUsageRevision: string;
  supersedesProviderUsageRevision: string | null;
  evidenceReference: string;
  usage: NormalizedModelUsage;
  actorType: "user" | "service";
  actorId: string;
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

  async closeRunBudgetInTransaction(
    client: PoolClient,
    lease: RunLease,
  ): Promise<"closed" | "pending_reconciliation"> {
    await assertRunLease(client, lease, { lock: "update" });
    return closeEnvelope(client, lease.tenantId, lease.runId);
  }

  async listDueTenantIds(limit = 100): Promise<string[]> {
    positiveInteger(limit, "model reconciliation tenant limit");
    return this.db.trustedTransaction(async (client) => {
      const result = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id
         FROM pr_agent_harness.list_due_model_budget_tenants($1)`,
        [Math.min(1_000, limit)],
      );
      return result.rows.map((row) => row.tenant_id);
    });
  }

  async reconcilePending(
    tenantId: string,
    limit = 100,
  ): Promise<{ estimated: number; pending: number }> {
    positiveInteger(limit, "model reconciliation limit");
    return this.db.transaction(tenantId, async (client) => {
      const candidates = await client.query<{
        model_call_id: string; run_id: string; reserved_input_tokens: string;
        reserved_output_tokens: string; reserved_cost_micros: string;
      }>(
        `SELECT br.model_call_id,br.run_id,br.reserved_input_tokens,
                br.reserved_output_tokens,br.reserved_cost_micros
         FROM pr_agent_harness.model_budget_reservations br
         WHERE br.tenant_id=$1 AND br.status='pending'
           AND br.reconciliation_due_at<=now() AND br.next_reconcile_at<=now()
         ORDER BY br.next_reconcile_at,br.model_call_id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [tenantId, Math.min(1_000, limit)],
      );
      let estimated = 0;
      for (const row of candidates.rows) {
        const actual = {
          inputTokens: Number(row.reserved_input_tokens),
          outputTokens: Number(row.reserved_output_tokens),
          costMicros: Number(row.reserved_cost_micros),
        };
        await client.query(
          `UPDATE pr_agent_harness.model_budget_reservations
           SET status='settled',actual_input_tokens=$3,actual_output_tokens=$4,
               actual_cost_micros=$5,settlement_kind='estimated_upper_bound',
               next_reconcile_at=NULL,last_reconcile_error=NULL,updated_at=now()
           WHERE tenant_id=$1 AND model_call_id=$2 AND status='pending'`,
          [tenantId, row.model_call_id, actual.inputTokens, actual.outputTokens, actual.costMicros],
        );
        const envelope = await client.query<{ currency: string; pricing_hash: string }>(
          `UPDATE pr_agent_harness.run_budget_envelopes
           SET actual_input_tokens=actual_input_tokens+$3,
               actual_output_tokens=actual_output_tokens+$4,
               actual_cost_micros=actual_cost_micros+$5,
               overdrawn=overdrawn OR actual_input_tokens+$3>input_token_limit
                 OR actual_output_tokens+$4>output_token_limit
                 OR actual_cost_micros+$5>cost_limit_micros,
               updated_at=now()
           WHERE tenant_id=$1 AND run_id=$2
           RETURNING currency,pricing_hash`,
          [tenantId, row.run_id, actual.inputTokens, actual.outputTokens, actual.costMicros],
        );
        const budget = envelope.rows[0];
        if (!budget) throw new ModelCallConflictError();
        await client.query(
          `INSERT INTO pr_agent_harness.usage_records (
             tenant_id,run_id,model_call_id,measurement_status,input_tokens,output_tokens,
             total_tokens,cost_micros,currency,pricing_hash,original_usage_json
           ) VALUES ($1,$2,$3,'estimated_upper_bound',$4,$5,$6,$7,$8,$9,'{}'::jsonb)
           ON CONFLICT (tenant_id,model_call_id) DO UPDATE
           SET measurement_status='estimated_upper_bound',input_tokens=EXCLUDED.input_tokens,
               output_tokens=EXCLUDED.output_tokens,total_tokens=EXCLUDED.total_tokens,
               cost_micros=EXCLUDED.cost_micros,updated_at=now()
           WHERE pr_agent_harness.usage_records.measurement_status='unavailable'`,
          [tenantId, row.run_id, row.model_call_id, actual.inputTokens, actual.outputTokens,
            actual.inputTokens + actual.outputTokens, actual.costMicros, budget.currency, budget.pricing_hash],
        );
        estimated += 1;
      }
      const pending = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pr_agent_harness.model_budget_reservations
         WHERE tenant_id=$1 AND status='pending'`, [tenantId]);
      return { estimated, pending: pending.rows[0]?.count ?? 0 };
    });
  }

  async reconcileActualUsage(input: ModelUsageReconciliationInput): Promise<{
    providerUsageRevision: string;
    delta: { inputTokens: number; outputTokens: number; costMicros: number };
    created: boolean;
  }> {
    requiredText(input.providerUsageRevision, "provider usage revision");
    if (input.supersedesProviderUsageRevision !== null) {
      requiredText(input.supersedesProviderUsageRevision, "superseded provider usage revision");
    }
    requiredText(input.evidenceReference, "usage evidence reference");
    requiredText(input.actorId, "usage reconciliation actor");
    return this.db.transaction(input.tenantId, async (client) => {
      const run = await client.query<{ integration_id: string; content_purged_at: Date | null }>(
        `SELECT integration_id,content_purged_at
         FROM pr_agent_harness.agent_runs
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [input.tenantId, input.runId],
      );
      if (run.rows[0]?.integration_id !== input.integrationId) {
        throw new ModelCallConflictError();
      }
      const retainedEvidenceReference = run.rows[0].content_purged_at === null
        ? input.evidenceReference : "retained-ledger-only";
      const call = await client.query<{
        provider: ModelProvider; pricing_hash: string; period_key: string; currency: string;
        rates_json: ModelPriceRates; status: string; current_provider_usage_revision: string | null;
        actual_input_tokens: string; actual_output_tokens: string; actual_cost_micros: string;
      }>(
        `SELECT mc.provider,e.pricing_hash,e.period_key,e.currency,p.rates_json,br.status,
                br.current_provider_usage_revision,br.actual_input_tokens,
                br.actual_output_tokens,br.actual_cost_micros
         FROM pr_agent_harness.model_calls mc
         JOIN pr_agent_harness.model_budget_reservations br
           ON br.tenant_id=mc.tenant_id AND br.model_call_id=mc.id
         JOIN pr_agent_harness.run_budget_envelopes e
           ON e.tenant_id=mc.tenant_id AND e.run_id=mc.run_id
         JOIN pr_agent_harness.model_pricing_snapshots p
           ON p.tenant_id=e.tenant_id AND p.pricing_hash=e.pricing_hash
         WHERE mc.tenant_id=$1 AND mc.run_id=$2 AND mc.id=$3
         FOR UPDATE OF mc,br`,
        [input.tenantId, input.runId, input.modelCallId],
      );
      const row = call.rows[0];
      if (!row || row.status !== "settled") {
        throw new ModelCallConflictError();
      }
      await client.query(
        `SELECT run_id FROM pr_agent_harness.run_budget_envelopes
         WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
        [input.tenantId, input.runId],
      );
      const actual = calculateActualModelUsage(input.usage, row.rates_json, row.provider);
      if (!actual) throw new Error("provider usage is invalid");
      const payloadHash = hashJson({ usage: input.usage, evidenceReference: input.evidenceReference,
        supersedesProviderUsageRevision: input.supersedesProviderUsageRevision });
      const existing = await client.query<{ payload_hash: string; delta_input_tokens: string;
        delta_output_tokens: string; delta_cost_micros: string }>(
        `SELECT payload_hash,delta_input_tokens,delta_output_tokens,delta_cost_micros
         FROM pr_agent_harness.model_usage_adjustments
         WHERE tenant_id=$1 AND model_call_id=$2 AND provider_usage_revision=$3`,
        [input.tenantId, input.modelCallId, input.providerUsageRevision],
      );
      if (row.current_provider_usage_revision === input.providerUsageRevision) {
        if (existing.rows[0]?.payload_hash !== payloadHash) throw new ModelCallConflictError();
        return { providerUsageRevision: input.providerUsageRevision, delta: {
          inputTokens: Number(existing.rows[0].delta_input_tokens),
          outputTokens: Number(existing.rows[0].delta_output_tokens),
          costMicros: Number(existing.rows[0].delta_cost_micros),
        }, created: false };
      }
      if (existing.rowCount || row.current_provider_usage_revision !== input.supersedesProviderUsageRevision) {
        throw new ModelCallConflictError();
      }
      const delta = {
        inputTokens: actual.inputTokens - Number(row.actual_input_tokens),
        outputTokens: actual.outputTokens - Number(row.actual_output_tokens),
        costMicros: actual.costMicros - Number(row.actual_cost_micros),
      };
      await client.query(
        `INSERT INTO pr_agent_harness.model_usage_adjustments (
           tenant_id,run_id,model_call_id,provider_usage_revision,supersedes_provider_usage_revision,
           payload_hash,evidence_reference,
           actual_input_tokens,actual_output_tokens,actual_cost_micros,
           delta_input_tokens,delta_output_tokens,delta_cost_micros,actor_type,actor_id,
           content_purged_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [input.tenantId, input.runId, input.modelCallId, input.providerUsageRevision,
          input.supersedesProviderUsageRevision, payloadHash, retainedEvidenceReference,
          actual.inputTokens, actual.outputTokens,
          actual.costMicros, delta.inputTokens, delta.outputTokens, delta.costMicros,
          input.actorType, input.actorId, run.rows[0].content_purged_at],
      );
      const reservation = await client.query(
        `UPDATE pr_agent_harness.model_budget_reservations
         SET actual_input_tokens=$3,actual_output_tokens=$4,actual_cost_micros=$5,
             settlement_kind='actual',current_provider_usage_revision=$6,updated_at=now()
         WHERE tenant_id=$1 AND model_call_id=$2
           AND current_provider_usage_revision IS NOT DISTINCT FROM $7`,
        [input.tenantId, input.modelCallId, actual.inputTokens, actual.outputTokens,
          actual.costMicros, input.providerUsageRevision, input.supersedesProviderUsageRevision],
      );
      if (reservation.rowCount !== 1) throw new ModelCallConflictError();
      const updatedEnvelope = await client.query<{ status: string }>(
        `UPDATE pr_agent_harness.run_budget_envelopes
         SET actual_input_tokens=actual_input_tokens+$3,
             actual_output_tokens=actual_output_tokens+$4,
             actual_cost_micros=actual_cost_micros+$5,
             overdrawn=actual_input_tokens+$3>input_token_limit
               OR actual_output_tokens+$4>output_token_limit
               OR actual_cost_micros+$5>cost_limit_micros,
             updated_at=now()
         WHERE tenant_id=$1 AND run_id=$2
           AND actual_input_tokens+$3>=0 AND actual_output_tokens+$4>=0 AND actual_cost_micros+$5>=0
         RETURNING status`,
        [input.tenantId, input.runId, delta.inputTokens, delta.outputTokens, delta.costMicros],
      );
      if (!updatedEnvelope.rows[0]) throw new ModelCallConflictError();
      if (updatedEnvelope.rows[0].status === "closed") {
        const account = await client.query(
          `UPDATE pr_agent_harness.tenant_budget_accounts
           SET spent_input_tokens=spent_input_tokens+$4,
               spent_output_tokens=spent_output_tokens+$5,
               spent_cost_micros=spent_cost_micros+$6,
               overdrawn=spent_input_tokens+$4+reserved_input_tokens>input_token_limit
                 OR spent_output_tokens+$5+reserved_output_tokens>output_token_limit
                 OR spent_cost_micros+$6+reserved_cost_micros>cost_limit_micros,
               updated_at=now()
           WHERE tenant_id=$1 AND period_key=$2 AND currency=$3
             AND spent_input_tokens+$4>=0 AND spent_output_tokens+$5>=0 AND spent_cost_micros+$6>=0`,
          [input.tenantId, row.period_key, row.currency,
            delta.inputTokens, delta.outputTokens, delta.costMicros],
        );
        if (account.rowCount !== 1) throw new ModelCallConflictError();
      }
      await client.query(
        `UPDATE pr_agent_harness.usage_records
         SET measurement_status='actual',input_tokens=$3,cached_input_tokens=$4,
             cache_write_input_tokens=$5,output_tokens=$6,reasoning_tokens=$7,
             tool_input_tokens=$8,total_tokens=$9,cost_micros=$10,
             original_usage_json=CASE WHEN content_purged_at IS NULL THEN $11::jsonb ELSE '{}'::jsonb END,
             updated_at=now()
         WHERE tenant_id=$1 AND model_call_id=$2`,
        [input.tenantId, input.modelCallId, input.usage.inputTokens,
          input.usage.cachedInputTokens ?? null, input.usage.cacheWriteInputTokens ?? null,
          input.usage.outputTokens, input.usage.reasoningOrThoughtTokens ?? null,
          input.usage.toolInputTokens ?? null,
          input.usage.totalTokens ?? actual.inputTokens + actual.outputTokens,
          actual.costMicros, JSON.stringify(input.usage.original)],
      );
      return { providerUsageRevision: input.providerUsageRevision, delta, created: true };
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
         LIMIT $2`,
        [tenantId, limit],
      );
      let closed = 0;
      let pending = 0;
      for (const candidate of candidates.rows) {
        const locked = await client.query(
          `SELECT id FROM pr_agent_harness.agent_runs
           WHERE tenant_id=$1 AND id=$2 AND status IN ('succeeded','failed','cancelled')
           FOR UPDATE SKIP LOCKED`,
          [tenantId, candidate.run_id],
        );
        if (!locked.rowCount) continue;
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
  const account = await measureDatabaseOperation("tenant_budget_lock", () => client.query<AccountRow>(
    `SELECT * FROM pr_agent_harness.tenant_budget_accounts
     WHERE tenant_id=$1 AND period_key=$2 AND currency=$3 FOR UPDATE`,
    [input.tenantId, input.policy.periodKey, input.policy.currency],
  ));
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
  stepKey?: string;
}): ModelExecutionContext {
  const workflow = text(input.lease.runType ?? input.lease.input.workflow, "model request workflow");
  let ordinal = 0;
  return {
    policy: input.policy,
    async execute<T>(intent: ModelRequestIntent, transport: () => Promise<ModelTransportResult<T>>,
      observation?: ModelObservationPayload): Promise<T> {
      const promptReferences = validatedPromptReferences(intent.metadata?.promptReferences);
      const primaryPromptReference = promptReferences[0]
        ? parseAgentPromptReference(promptReferences[0]) : undefined;
      const bounded = {
        ...intent,
        requestKind: `${workflow}:${input.stepKey ?? input.stepId}:${intent.provider}:${intent.requestKind}`,
        metadata: { ...intent.metadata, workflow,
          step: input.stepKey ?? input.stepId, provider: intent.provider },
        maxOutputTokens: Math.min(intent.maxOutputTokens, input.policy.maxOutputTokens),
      };
      ordinal += 1;
      const call = await input.store.prepare({ ...input, physicalOrdinal: ordinal, intent: bounded });
      if (call.status === "succeeded" || call.status === "failed_definite") {
        return call.response as T;
      }
      if (call.status !== "prepared") throw new Error("model call requires reconciliation before retry");
      await input.store.markDispatched(call, input.lease);
      return observeAgentOperation("model.generate", "generation", {
        model: intent.model,
        promptReference: primaryPromptReference,
        input: observation?.input,
        modelParameters: observation?.parameters,
        metadata: {
          runId: input.lease.runId, modelCallId: call.id, provider: intent.provider,
          workflow, stepKey: input.stepKey, stepId: input.stepId,
          stepAttemptId: input.stepAttemptId, physicalOrdinal: ordinal,
          requestKind: intent.requestKind, requestHash: intent.requestHash,
          role: intent.metadata?.role, turn: intent.metadata?.turn,
          schemaName: intent.metadata?.schemaName,
          ...(promptReferences.length > 0 ? { promptReferences } : {}),
          maxOutputTokens: bounded.maxOutputTokens, pricingHash: input.policy.hash,
          currency: input.policy.currency, usageStatus: "unavailable", settlementStatus: "pending",
        },
      }, async (generation) => {
        try {
          const result = await transport();
          if (result.httpStatus !== undefined && result.httpStatus >= 400) {
            await input.store.settleProviderFailure({ call, lease: input.lease, policy: input.policy, result });
          } else {
            await input.store.settleKnown({ call, lease: input.lease, policy: input.policy, result });
          }
          // Observability must never turn a settled provider request into a business failure.
          try {
            const actual = result.usage
              ? calculateActualModelUsage(result.usage, input.policy.rates, input.policy.provider)
              : undefined;
            generation.update({
              output: result.observationOutput,
              usageDetails: actual && result.usage
                ? modelObservationUsage(intent.provider, result.usage) : undefined,
              costDetails: actual && input.policy.currency === "USD"
                ? { total: actual.costMicros / 1_000_000 } : undefined,
              level: result.httpStatus !== undefined && result.httpStatus >= 400 ? "ERROR" : "DEFAULT",
              statusMessage: result.httpStatus !== undefined && result.httpStatus >= 400
                ? "provider_http_failure" : undefined,
              metadata: {
                providerRequestId: result.providerRequestId, modelVersion: result.modelVersion,
                httpStatus: result.httpStatus, usageStatus: actual ? "actual" : "unavailable",
                settlementStatus: actual ? "settled" : "pending",
                actualCostMicros: actual?.costMicros,
                costSource: "frozen_run_pricing", currency: input.policy.currency,
              },
            });
          } catch (error) {
            logCore("warn", "observability.generation_update_failed", {
              runId: input.lease.runId, modelCallId: call.id, error,
            });
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
      });
    },
  };
}

function validatedPromptReferences(value: unknown): Array<{
  name: string;
  version: number;
  contentHash: string;
}> {
  if (!Array.isArray(value)) return [];
  const references: Array<{ name: string; version: number; contentHash: string }> = [];
  for (const item of value.slice(0, 16)) {
    const reference = parseAgentPromptReference(item);
    const contentHash = item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).contentHash : undefined;
    if (!reference || typeof contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(contentHash)) continue;
    references.push({ ...reference, contentHash });
  }
  return references;
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
    periodKey: new Date().toISOString().slice(0, 7),
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
     SET status='pending',
         reconciliation_due_at=COALESCE(reconciliation_due_at,now()+(reconciliation_grace_ms*interval '1 millisecond')),
         next_reconcile_at=COALESCE(next_reconcile_at,now()+(reconciliation_grace_ms*interval '1 millisecond')),
         updated_at=now()
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
         actual_cost_micros=$5,settlement_kind='actual',next_reconcile_at=NULL,
         last_reconcile_error=NULL,updated_at=now()
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
    `UPDATE pr_agent_harness.model_budget_reservations
     SET status='pending',
         reconciliation_due_at=COALESCE(reconciliation_due_at,now()+(reconciliation_grace_ms*interval '1 millisecond')),
         next_reconcile_at=COALESCE(next_reconcile_at,now()+(reconciliation_grace_ms*interval '1 millisecond')),
         updated_at=now()
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
     SET status='pending',
         reconciliation_due_at=COALESCE(reconciliation_due_at,now()+(reconciliation_grace_ms*interval '1 millisecond')),
         next_reconcile_at=COALESCE(next_reconcile_at,now()+(reconciliation_grace_ms*interval '1 millisecond')),
         updated_at=now()
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
