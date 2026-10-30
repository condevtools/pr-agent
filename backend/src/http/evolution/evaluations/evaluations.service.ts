import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { admitEvaluation } from "../../../evolution/evaluations/intake.js";
import { PgEvolutionEvaluationStore } from "../../../evolution/evaluations/store.js";
import { RunControlError } from "../../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";

@Injectable()
export class EvaluationsService {
  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  async create(request: Request, body: unknown) {
    const commandKey = idempotencyKey(request);
    const services = await getAgentRuntimeServices();
    return admitEvaluation({ db: services.db, principal: this.context.authenticate(request), commandKey, request: body });
  }

  async read(request: Request, id: string) {
    z.string().uuid().parse(id);
    return new PgEvolutionEvaluationStore((await getAgentRuntimeServices()).db).read(this.context.authenticate(request), id);
  }
}
function idempotencyKey(request: Request): string {
  const value = request.header("idempotency-key")?.trim();
  if (!value || value.length > 200) throw new RunControlError("IDEMPOTENCY_KEY_REQUIRED", 400, "Idempotency-Key is required");
  return value;
}
