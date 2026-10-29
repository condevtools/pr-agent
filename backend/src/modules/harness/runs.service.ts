import { Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";

import { RunApiAuthenticator } from "../../harness/run-api-auth.js";
import { createReviewRequestSchema, resolveApiReviewInput } from "../../harness/run-api-input.js";
import { requireRunPermission, runCommandSchema, runConflict, runNotFound, RunControlError, type RunPrincipal } from "../../harness/run-control-contracts.js";
import { RunControlStore } from "../../harness/run-control-store.js";
import { RunQueryStore } from "../../harness/run-query-store.js";
import { RunEventStreamHub } from "../../harness/run-sse.js";
import { buildReviewRunCreationInput } from "../../harness/review-run-intake.js";
import { reviewRunInputSchema } from "../../harness/review-run-input.js";
import { getHarnessServices } from "../../harness/runtime.js";
import { HarnessRunStore } from "../../harness/postgres/run-store.js";
import { fingerprint } from "../../harness/versions.js";

@Injectable()
export class RunsService implements BeforeApplicationShutdown {
  private readonly authenticator = new RunApiAuthenticator();
  private hub?: RunEventStreamHub;

  authenticate(request: Request): RunPrincipal {
    const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (headers.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
    return this.authenticator.authenticate(request.headers.authorization);
  }

  async create(principal: RunPrincipal, key: unknown, body: unknown) {
    requireRunPermission(principal, "runs:create");
    const commandKey = z.string().min(1).max(200).parse(key);
    const request = createReviewRequestSchema.parse(body);
    const services = await getHarnessServices();
    const binding = await this.binding(principal);
    const source = { key: `api:${binding.id}:${commandKey}`, hash: fingerprint(request) };
    const previous = await services.db.transaction(principal.tenantId, (client) => client.query<{
      id: string; status: string; version: string; source_hash: string;
    }>(
      `SELECT id,status,version,input_json->'source'->>'hash' AS source_hash
       FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND create_scope=$3 AND create_key=$4`,
      [principal.tenantId, principal.integrationId, `review.single.v1:${binding.id}`, source.key],
    ));
    if (previous.rows[0]) {
      if (previous.rows[0].source_hash !== source.hash) throw runConflict("Idempotency key was used for a different review request");
      return { id: previous.rows[0].id, status: previous.rows[0].status, version: Number(previous.rows[0].version), created: false };
    }
    if (binding.reviewExecutionMode !== "harness_async" || binding.state !== "active") {
      throw runConflict("Asynchronous review admission is not active for this integration");
    }
    const input = await resolveApiReviewInput(binding, request, source);
    const creation = await buildReviewRunCreationInput(binding, input, { actorType: principal.actorType, actorId: principal.subjectId });
    const run = await new HarnessRunStore(services.db).createRun(creation);
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

  async command(principal: RunPrincipal, runId: string, kind: string, body: unknown) {
    validRunId(runId);
    const fields = z.record(z.unknown()).parse(body);
    if ("kind" in fields) throw new RunControlError("INVALID_REQUEST", 422, "Command kind is selected by the route");
    const command = runCommandSchema.parse({ ...fields, kind });
    requireRunPermission(principal, `runs:${command.kind}`);
    const services = await getHarnessServices();
    const store = new RunControlStore(services.db);
    if (command.kind !== "rerun") return store.apply(principal, runId, command);
    const previous = await store.lookupReceipt(principal, runId, command);
    if (previous) return previous;
    const original = reviewRunInputSchema.parse(await (await this.queries()).originalInput(principal, runId));
    const binding = await this.binding(principal);
    const source = { key: `rerun:${runId}:${command.commandKey}`, hash: fingerprint({ parentRunId: runId, command }) };
    const creation = await buildReviewRunCreationInput(binding, { ...original, source },
      { actorType: principal.actorType, actorId: principal.subjectId, parentRunId: runId });
    return store.apply(principal, runId, command, creation);
  }

  async stream(principal: RunPrincipal, runId: string, after: string | undefined, response: Response): Promise<void> {
    requireRunPermission(principal, "runs:read");
    validRunId(runId);
    const queries = await this.queries();
    this.hub ??= new RunEventStreamHub(queries);
    await this.hub.open(principal, runId, z.string().max(256).optional().parse(after), response);
  }

  async beforeApplicationShutdown(): Promise<void> { await this.hub?.stop(); }
  private async queries(): Promise<RunQueryStore> { return new RunQueryStore((await getHarnessServices()).db); }
  private async binding(principal: RunPrincipal) {
    const services = await getHarnessServices();
    const authorized = await services.db.transaction(principal.tenantId, (client) => client.query(
      "SELECT 1 FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2 AND active",
      [principal.tenantId, principal.integrationId],
    ));
    if (!authorized.rowCount) throw runNotFound();
    return services.authority.get(principal.tenantId, principal.integrationId);
  }
}

function validRunId(value: string): string { return z.string().uuid().parse(value); }
