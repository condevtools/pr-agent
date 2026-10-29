import { Controller, Get, Header, Query } from "@nestjs/common";

import { HealthService } from "./health.service.js";
import { isDeepHealthQuery, type HealthStatus } from "./health.js";
import { renderPrometheusMetrics } from "./metrics-runtime.js";

@Controller()
export class SystemController {
  constructor(private readonly healthService: HealthService) {}

  @Get("health")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    return this.healthService.getHealth({
      mode: "nest",
      deep: isDeepHealthQuery(deep),
    });
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  metrics(): string {
    return renderPrometheusMetrics();
  }
}
