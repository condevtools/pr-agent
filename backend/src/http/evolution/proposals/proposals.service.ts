import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { evolutionProposalRequestSchema } from "../../../evolution/proposals/candidate-contracts.js";
import { PgEvolutionCandidateStore } from "../../../evolution/proposals/candidate-store.js";
import { admitEvolutionProposalRun } from "../../../evolution/proposals/intake.js";
import { requireRunPermission, type RunPrincipal } from "../../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";

@Injectable()
export class EvolutionProposalsService {
  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  authenticate(request: Request): RunPrincipal { return this.context.authenticate(request); }

  async create(principal: RunPrincipal, key: unknown, body: unknown) {
    requireRunPermission(principal, "evolution:propose");
    const request = evolutionProposalRequestSchema.parse(body); const commandKey = z.string().min(1).max(200).parse(key);
    const services = await getAgentRuntimeServices(); const binding = await services.authority.get(principal.tenantId, principal.integrationId);
    return admitEvolutionProposalRun({ db: services.db, binding, principal, datasetId: request.datasetId, commandKey });
  }

  async read(principal: RunPrincipal, candidateId: string) {
    requireRunPermission(principal, "evaluations:read");
    return new PgEvolutionCandidateStore((await getAgentRuntimeServices()).db).read(principal, z.string().uuid().parse(candidateId));
  }
}
