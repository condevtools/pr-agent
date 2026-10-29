import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { runNotFound, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";
import { RunApiAuthenticator } from "./run-auth.js";

@Injectable()
export class RunApiContextService {
  private readonly authenticator = new RunApiAuthenticator();

  authenticate(request: Request): RunPrincipal {
    const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (headers.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
    return this.authenticator.authenticate(request.headers.authorization);
  }

  async binding(principal: RunPrincipal) {
    const services = await getAgentRuntimeServices();
    const authorized = await services.db.transaction(principal.tenantId, (client) => client.query(
      "SELECT 1 FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2 AND active",
      [principal.tenantId, principal.integrationId],
    ));
    if (!authorized.rowCount) throw runNotFound();
    return services.authority.get(principal.tenantId, principal.integrationId);
  }
}

export function validRunId(value: string): string { return z.string().uuid().parse(value); }
