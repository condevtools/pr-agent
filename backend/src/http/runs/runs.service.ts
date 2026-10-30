import { Inject, Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";

import { DeepReviewStore } from "../../review/deep/persistence/store.js";
import { createReviewRequestSchema, reconcileModelUsageSchema, reviewApiSourceHash } from "./input.js";
import { requireRunPermission, runCommandSchema, runConflict, runNotFound, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { RunControlStore } from "../../agent-runtime/runs/control-store.js";
import { RunQueryStore } from "../../agent-runtime/runs/query-store.js";
import { RunEventStreamHub } from "./event-stream.js";
import { buildReviewRunCreationInput } from "../../review/intake/run-intake.js";
import { reviewCreationRequestHash, reviewRunInputSchema } from "../../review/intake/run-input.js";
import { resolveReviewInput } from "../../review/intake/resolve-input.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";
import { RunStore } from "../../agent-runtime/postgres/run-store.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import { PgFixStore } from "../../fix/persistence/store.js";
import { RunApiContextService, validRunId } from "../common/run-api-context.service.js";
import { ModelBudgetStore, ModelCallConflictError } from "../../agent-runtime/budget/model-budget-store.js";

@Injectable()
export class RunsService implements BeforeApplicationShutdown {
  private hub?: RunEventStreamHub;

  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  async create(principal: RunPrincipal, key: unknown, body: unknown) {
    requireRunPermission(principal, "runs:create");
    const commandKey = z.string().min(1).max(200).parse(key);
    const request = createReviewRequestSchema.parse(body);
    const services = await getAgentRuntimeServices();
    const binding = await this.context.binding(principal);
    const source = { key: `api:${binding.id}:${commandKey}`, hash: reviewApiSourceHash(request) };
    const requestHash = reviewCreationRequestHash({ source, platform: binding.platform,
      target: { origin: binding.origin, repository: binding.repository, number: request.number,
        providerRepositoryId: binding.providerRepositoryId }, mode: request.mode, trigger: "comment-command" });
    const previous = await services.db.transaction(principal.tenantId, (client) => client.query<{
      id: string; status: string; version: string; request_hash: string;
    }>(
      `SELECT id,status,version,request_hash
       FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND create_scope=$3 AND create_key=$4`,
      [principal.tenantId, principal.integrationId, `review.single.v1:${binding.id}`, source.key],
    ));
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash) throw runConflict("Idempotency key was used for a different review request");
      return { id: previous.rows[0].id, status: previous.rows[0].status, version: Number(previous.rows[0].version), created: false };
    }
    if (binding.reviewExecutionMode !== "harness_async" || binding.state !== "active") {
      throw runConflict("Asynchronous review admission is not active for this integration");
    }
    const input = await resolveReviewInput(binding, request, source);
    const creation = await buildReviewRunCreationInput(binding, input, { actorType: principal.actorType, actorId: principal.subjectId });
    const run = await new RunStore(services.db).createRun(creation);
    return { id: run.id, status: run.status, version: run.version, created: run.created };
  }

  async snapshot(principal: RunPrincipal, runId: string) {
    requireRunPermission(principal, "runs:read");
    return (await this.queries()).snapshot(principal, validRunId(runId));
  }
  async events(principal: RunPrincipal, runId: string, after?: string, limit?: string) {
    requireRunPermission(principal, "runs:read");
    const count = limit === undefined ? 100 : z.coerce.number().int().min(1).max(200).parse(limit);
    return (await this.queries()).events(principal, validRunId(runId), z.string().max(256).optional().parse(after), count);
  }
  async trace(principal: RunPrincipal, runId: string, after?: string) {
    requireRunPermission(principal, "runs:trace");
    return (await this.queries()).trace(principal, validRunId(runId), z.string().max(1024).optional().parse(after));
  }

  async artifact(principal: RunPrincipal, runId: string, raw?: string) {
    requireRunPermission(principal, "runs:read");
    const includeRaw = z.enum(["true", "false"]).optional().parse(raw) === "true";
    const id = validRunId(runId);
    const services = await getAgentRuntimeServices();
    const type = await services.db.transaction(principal.tenantId, (client) => client.query<{ run_type: string }>(
      `SELECT run_type FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
      [principal.tenantId, principal.integrationId, id]));
    if (!type.rows[0]) throw runNotFound();
    return type.rows[0].run_type === "fix.propose.v1"
      ? new PgFixStore(services.db).readArtifact(principal, id, { raw: includeRaw })
      : new DeepReviewStore(services.db).readArtifact(principal, id, { raw: includeRaw });
  }

  async command(principal: RunPrincipal, runId: string, kind: string, body: unknown) {
    validRunId(runId);
    const fields = z.record(z.unknown()).parse(body);
    if ("kind" in fields) throw new RunControlError("INVALID_REQUEST", 422, "Command kind is selected by the route");
    const command = runCommandSchema.parse({ ...fields, kind });
    requireRunPermission(principal, `runs:${command.kind}`);
    const services = await getAgentRuntimeServices();
    const store = new RunControlStore(services.db);
    if (command.kind !== "rerun") return store.apply(principal, runId, command);
    const previous = await store.lookupReceipt(principal, runId, command);
    if (previous) return previous;
    const original = reviewRunInputSchema.parse(await (await this.queries()).originalInput(principal, runId));
    const binding = await this.context.binding(principal);
    const source = { key: `rerun:${runId}:${command.commandKey}`, hash: fingerprint({ parentRunId: runId, command }) };
    const creation = await buildReviewRunCreationInput(binding, { ...original, source },
      { actorType: principal.actorType, actorId: principal.subjectId, parentRunId: runId });
    return store.apply(principal, runId, command, creation);
  }

  async reconcileModelUsage(
    principal: RunPrincipal,
    runId: string,
    modelCallId: string,
    body: unknown,
  ) {
    requireRunPermission(principal, "usage:reconcile");
    const id = validRunId(runId);
    const callId = z.string().uuid().parse(modelCallId);
    const input = reconcileModelUsageSchema.parse(body);
    try {
      return await new ModelBudgetStore((await getAgentRuntimeServices()).db).reconcileActualUsage({
        tenantId: principal.tenantId,
        integrationId: principal.integrationId,
        runId: id,
        modelCallId: callId,
        providerUsageRevision: input.providerUsageRevision,
        supersedesProviderUsageRevision: input.supersedesProviderUsageRevision,
        evidenceReference: input.evidenceReference,
        usage: input.usage,
        actorType: principal.actorType,
        actorId: principal.subjectId,
      });
    } catch (error) {
      if (error instanceof ModelCallConflictError) {
        throw runConflict("Model usage reconciliation conflicts with the durable ledger");
      }
      throw error;
    }
  }

  async stream(principal: RunPrincipal, runId: string, after: string | undefined, response: Response): Promise<void> {
    requireRunPermission(principal, "runs:read");
    validRunId(runId);
    const queries = await this.queries();
    this.hub ??= new RunEventStreamHub(queries);
    await this.hub.open(principal, runId, z.string().max(256).optional().parse(after), response);
  }

  async beforeApplicationShutdown(): Promise<void> { await this.hub?.stop(); }
  private async queries(): Promise<RunQueryStore> { return new RunQueryStore((await getAgentRuntimeServices()).db); }
}
