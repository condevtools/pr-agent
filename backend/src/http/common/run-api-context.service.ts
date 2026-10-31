import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { runNotFound, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { RunApiAuthenticator, readPrincipalConfiguration } from "./run-auth.js";
import { logCore } from "#core";

@Injectable()
export class RunApiContextService implements OnModuleDestroy {
  private readonly authenticator = new RunApiAuthenticator(readPrincipalConfiguration());
  private readonly principals = new WeakMap<Request, RunPrincipal>();
  private readonly reload = () => {
    try { this.authenticator.reload(readPrincipalConfiguration()); }
    catch {
      this.authenticator.reload(undefined);
      logCore("error", "run_api.credentials_reload_rejected", { domainCode: "RUN_API_DISABLED" });
    }
  };

  constructor() { process.on("SIGHUP", this.reload); }
  onModuleDestroy(): void { process.off("SIGHUP", this.reload); }

  authenticate(request: Request): RunPrincipal {
    const cached = this.principals.get(request);
    if (cached) { this.authenticator.assertCurrent(cached); return cached; }
    this.assertSingleAuthorizationHeader(request);
    const principal = this.authenticator.authenticate(request.headers.authorization);
    this.principals.set(request, principal);
    return principal;
  }

  private assertSingleAuthorizationHeader(request: Request): void {
    const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (headers.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
  }

  assertCurrentPrincipal(principal: RunPrincipal): void {
    this.authenticator.assertCurrent(principal);
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
