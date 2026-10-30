import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { PgEvolutionReleaseStore } from "../../../evolution/releases/store.js";
import { decideReleaseSchema, qualifyCandidateSchema, requestReleaseSchema,
  revokeReleaseSchema, rollbackReleaseSchema } from "../../../evolution/releases/contracts.js";
import { getModelExecutionPolicy } from "../../../agent-runtime/budget/model-budget-store.js";
import { RunControlError } from "../../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { runtimeVersionManifest } from "../../../agent-runtime/versions.js";
import { resolveModelConfiguration } from "../../../model/configuration.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";

@Injectable()
export class ReleasesService {
  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}
  async qualify(request: Request, body: unknown) {
    const input = qualifyCandidateSchema.parse(withCommand(body, request));
    const principal = this.context.authenticate(request);
    const model = resolveModelConfiguration();
    const manifest = await runtimeVersionManifest(getModelExecutionPolicy(model.provider, model.model));
    return (await store()).qualify(principal, input, manifest);
  }
  async request(request: Request, body: unknown) {
    const principal = this.context.authenticate(request);
    return (await store()).request(principal, requestReleaseSchema.parse(withCommand(body, request)),
      await currentManifest());
  }
  async approve(request: Request, body: unknown) {
    const principal = this.context.authenticate(request);
    const input = decideReleaseSchema.parse(withCommand(body, request));
    return (await store()).approve(principal, input,
      input.decision === "approve" ? await currentManifest() : undefined);
  }
  async revoke(request: Request, body: unknown) {
    const input = revokeReleaseSchema.parse(withCommand(body, request));
    const principal = this.context.authenticate(request);
    return (await store()).revoke(principal, input.requestId, input.commandKey);
  }
  async rollback(request: Request, body: unknown) {
    const principal = this.context.authenticate(request);
    return (await store()).rollback(principal, rollbackReleaseSchema.parse(withCommand(body, request)));
  }
  async read(request: Request) { return (await store()).read(this.context.authenticate(request)); }
}
async function store(): Promise<PgEvolutionReleaseStore> { return new PgEvolutionReleaseStore((await getAgentRuntimeServices()).db); }
async function currentManifest() {
  const model = resolveModelConfiguration();
  return runtimeVersionManifest(getModelExecutionPolicy(model.provider, model.model));
}
function withCommand(body: unknown, request: Request): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || "commandKey" in body) {
    throw new RunControlError("RELEASE_REQUEST_INVALID", 400, "Release request body is invalid");
  }
  const commandKey = request.header("idempotency-key")?.trim();
  if (!commandKey || commandKey.length > 200) throw new RunControlError("IDEMPOTENCY_KEY_REQUIRED", 400, "Idempotency-Key is required");
  return { ...(body as Record<string, unknown>), commandKey };
}
