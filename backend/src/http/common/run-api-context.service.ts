import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { readFileSync, statSync } from "node:fs";
import type { Request } from "express";
import { z } from "zod";

import { runNotFound, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { RunApiAuthenticator } from "./run-auth.js";
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
    const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (headers.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
    const principal = this.authenticator.authenticate(request.headers.authorization);
    this.principals.set(request, principal);
    return principal;
  }

  assertCurrentPrincipal(principal: RunPrincipal): void { this.authenticator.assertCurrent(principal); }

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

function readPrincipalConfiguration(): string | undefined {
  const path = process.env.HARNESS_API_PRINCIPALS_FILE?.trim();
  if (!path) return process.env.HARNESS_API_PRINCIPALS_JSON;
  if (process.env.HARNESS_API_PRINCIPALS_JSON?.trim()) throw new Error("Configure one Run API credential source");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid Run API credential file");
  return readFileSync(path, "utf8");
}

export function validRunId(value: string): string { return z.string().uuid().parse(value); }
