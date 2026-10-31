import { Module } from "@nestjs/common";

import { HttpCommonModule } from "../common/http-common.module.js";
import { QualityController } from "./quality.controller.js";
import { QualityService } from "./quality.service.js";

@Module({
  imports: [HttpCommonModule],
  controllers: [QualityController],
  providers: [QualityService],
})
export class QualityModule {}
