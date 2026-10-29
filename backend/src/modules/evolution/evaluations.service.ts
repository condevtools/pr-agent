import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { admitEvaluation } from "../../evolution/replay-intake.js";
import { EvaluationStore } from "../../evolution/replay-store.js";
import { RunControlError } from "../../harness/run-control-contracts.js";
import { getHarnessServices } from "../../harness/runtime.js";
import { RunsService } from "../harness/runs.service.js";

@Injectable()
export class EvaluationsService {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  async create(request: Request, body: unknown) {
    const commandKey = idempotencyKey(request);
    const services = await getHarnessServices();
    return admitEvaluation({ db: services.db, principal: this.runs.authenticate(request), commandKey, request: body });
  }

  async read(request: Request, id: string) {
    z.string().uuid().parse(id);
    return new EvaluationStore((await getHarnessServices()).db).read(this.runs.authenticate(request), id);
  }
}
function idempotencyKey(request: Request): string {
  const value = request.header("idempotency-key")?.trim();
  if (!value || value.length > 200) throw new RunControlError("IDEMPOTENCY_KEY_REQUIRED", 400, "Idempotency-Key is required");
  return value;
}
