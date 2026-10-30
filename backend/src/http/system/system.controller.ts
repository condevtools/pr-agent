import { RouteAccess } from "../common/route-access.js";
import { Controller, Get, Header, Res } from "@nestjs/common";
import type { Response } from "express";

import { HealthService } from "./health.service.js";
import type { HealthStatus } from "./health.js";
import { renderPrometheusMetrics } from "./metrics-runtime.js";

@Controller()
export class SystemController {
  constructor(private readonly healthService: HealthService) {}

  @Get("health")
  @RouteAccess("public")
  health(): Promise<HealthStatus> {
    return this.healthService.getHealth({ mode: "nest" });
  }

  @Get("ready")
  @RouteAccess("public")
  async ready(@Res({ passthrough: true }) response: Response) {
    const status = await this.healthService.getReadiness();
    if (!status.ok) response.status(503);
    return status;
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @RouteAccess("metrics:read")
  metrics(): string {
    return renderPrometheusMetrics();
  }
}
