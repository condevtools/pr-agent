import { Module } from "@nestjs/common";

import { HealthService } from "./health.service.js";
import { SystemController } from "./system.controller.js";

@Module({ controllers: [SystemController], providers: [HealthService] })
export class SystemModule {}
