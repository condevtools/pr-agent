import { Module } from "@nestjs/common";

import { HttpCommonModule } from "../common/http-common.module.js";
import { FixesController } from "./fixes.controller.js";
import { FixesService } from "./fixes.service.js";

@Module({ imports: [HttpCommonModule], controllers: [FixesController], providers: [FixesService] })
export class FixesModule {}
