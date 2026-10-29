import { Module } from "@nestjs/common";

import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";

@Module({ controllers: [RunsController], providers: [RunsService] })
export class HarnessModule {}
