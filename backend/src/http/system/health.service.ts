import { Injectable } from "@nestjs/common";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { resolveAgentProcessRole } from "../../agent-runtime/runtime/config.js";
import { checkRuntimeReadiness, type RuntimeReadinessStatus } from "../../agent-runtime/runtime/readiness.js";
import { resolveRuntimeCapabilities } from "../../agent-runtime/runtime/capabilities.js";
import { buildHealthStatus, type HealthStatus } from "./health.js";
import { logCore } from "#core";

@Injectable()
export class HealthService {
  private lastReadinessFailure = "";
  private lastReadinessFailureAt = 0;

  getHealth(params?: { mode?: string; deep?: boolean }): Promise<HealthStatus> {
    return buildHealthStatus({
      mode: params?.mode ?? "nest",
      deep: false,
    });
  }

  async getReadiness(): Promise<RuntimeReadinessStatus> {
    const role = resolveAgentProcessRole();
    try {
      return await checkRuntimeReadiness({ pool: (await getAgentRuntimeServices()).pool, role });
    } catch (error) {
      this.logReadinessFailure(error);
      return { ok: false, role, capabilities: resolveRuntimeCapabilities(), checks: {
        postgres: false, runtimeRole: false, schema: false,
        heartbeats: {},
      } };
    }
  }

  private logReadinessFailure(error: unknown): void {
    const reason = error instanceof Error ? error.name : "unknown";
    const signature = `READINESS_CONFIGURATION_FAILED:${reason}`;
    const now = Date.now();
    if (signature === this.lastReadinessFailure && now - this.lastReadinessFailureAt < 60_000) return;
    this.lastReadinessFailure = signature;
    this.lastReadinessFailureAt = now;
    logCore("warn", "runtime_readiness.configuration_failed", {
      domainCode: "READINESS_CONFIGURATION_FAILED", reason });
  }
}
