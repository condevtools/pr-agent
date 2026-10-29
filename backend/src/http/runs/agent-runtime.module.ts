import { Module } from "@nestjs/common";

import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { HttpCommonModule } from "../common/http-common.module.js";

@Module({ imports: [HttpCommonModule], controllers: [RunsController], providers: [RunsService] })
export class AgentRuntimeModule {}
