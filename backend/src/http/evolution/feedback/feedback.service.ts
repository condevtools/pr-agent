import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { PgEvolutionFeedbackStore } from "../../../evolution/feedback/store.js";
import { requireRunPermission, type RunPrincipal } from "../../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";

@Injectable()
export class EvolutionFeedbackService {
  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  authenticate(request: Request): RunPrincipal { return this.context.authenticate(request); }

  async feedback(principal: RunPrincipal, runId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "feedback:create");
    return (await this.store()).recordObservation(principal, validRunId(runId), commandKey(key), body);
  }

  async annotate(principal: RunPrincipal, runId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "annotations:create");
    return (await this.store()).createAnnotation(principal, validRunId(runId), commandKey(key), body);
  }

  async arbitrate(principal: RunPrincipal, runId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "annotations:arbitrate");
    return (await this.store()).arbitrate(principal, validRunId(runId), commandKey(key), body);
  }

  private async store(): Promise<PgEvolutionFeedbackStore> { return new PgEvolutionFeedbackStore((await getAgentRuntimeServices()).db); }
}

function validRunId(value: string): string { return z.string().uuid().parse(value); }
function commandKey(value: unknown): string { return z.string().min(1).max(200).parse(value); }
