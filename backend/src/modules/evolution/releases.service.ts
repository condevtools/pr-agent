import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { PgEvolutionReleaseStore } from "../../evolution/release-store.js";
import { decideReleaseSchema, qualifyCandidateSchema, requestReleaseSchema,
  revokeReleaseSchema, rollbackReleaseSchema } from "../../evolution/release-contracts.js";
import { getModelExecutionPolicy } from "../../harness/model-budget-store.js";
import { RunControlError } from "../../harness/run-control-contracts.js";
import { getHarnessServices } from "../../harness/runtime.js";
import { reviewVersionManifest } from "../../harness/versions.js";
import { resolveReviewModelConfiguration } from "../../review/ai-reviewer.js";
import { RunsService } from "../harness/runs.service.js";

@Injectable()
export class ReleasesService {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}
  async qualify(request: Request, body: unknown) {
    const input = qualifyCandidateSchema.parse(withCommand(body, request));
    const model = resolveReviewModelConfiguration();
    const manifest = await reviewVersionManifest(getModelExecutionPolicy(model.provider, model.model));
    return (await store()).qualify(this.runs.authenticate(request), input, manifest);
  }
  async request(request: Request, body: unknown) {
    return (await store()).request(this.runs.authenticate(request), requestReleaseSchema.parse(withCommand(body, request)),
      await currentManifest());
  }
  async approve(request: Request, body: unknown) {
    return (await store()).approve(this.runs.authenticate(request), decideReleaseSchema.parse(withCommand(body, request)),
      await currentManifest());
  }
  async revoke(request: Request, body: unknown) {
    const input = revokeReleaseSchema.parse(withCommand(body, request));
    return (await store()).revoke(this.runs.authenticate(request), input.requestId, input.commandKey);
  }
  async rollback(request: Request, body: unknown) {
    return (await store()).rollback(this.runs.authenticate(request), rollbackReleaseSchema.parse(withCommand(body, request)));
  }
  async read(request: Request) { return (await store()).read(this.runs.authenticate(request)); }
}
async function store(): Promise<PgEvolutionReleaseStore> { return new PgEvolutionReleaseStore((await getHarnessServices()).db); }
async function currentManifest() {
  const model = resolveReviewModelConfiguration();
  return reviewVersionManifest(getModelExecutionPolicy(model.provider, model.model));
}
function withCommand(body: unknown, request: Request): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || "commandKey" in body) {
    throw new RunControlError("RELEASE_REQUEST_INVALID", 400, "Release request body is invalid");
  }
  const commandKey = request.header("idempotency-key")?.trim();
  if (!commandKey || commandKey.length > 200) throw new RunControlError("IDEMPOTENCY_KEY_REQUIRED", 400, "Idempotency-Key is required");
  return { ...(body as Record<string, unknown>), commandKey };
}
