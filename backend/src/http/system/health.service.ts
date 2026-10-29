import { Injectable } from "@nestjs/common";
import { buildHealthStatus, type HealthStatus } from "./health.js";

@Injectable()
export class HealthService {
  getHealth(params?: { mode?: string; deep?: boolean }): Promise<HealthStatus> {
    return buildHealthStatus({
      mode: params?.mode ?? "nest",
      deep: Boolean(params?.deep),
    });
  }
}
