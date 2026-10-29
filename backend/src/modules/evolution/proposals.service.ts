import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { evolutionProposalRequestSchema } from "../../evolution/proposals/candidate-contracts.js";
import { PgEvolutionCandidateStore } from "../../evolution/proposals/candidate-store.js";
import { admitEvolutionProposalRun } from "../../evolution/proposals/intake.js";
import { RunApiAuthenticator } from "../../http/common/run-auth.js";
import { requireRunPermission, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";

@Injectable()
export class EvolutionProposalsService {
  private readonly authenticator = new RunApiAuthenticator();

  authenticate(request: Request): RunPrincipal {
    const names = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (names.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
    return this.authenticator.authenticate(request.headers.authorization);
  }

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
