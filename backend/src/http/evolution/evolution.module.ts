import { Module } from "@nestjs/common";

import { HttpCommonModule } from "../common/http-common.module.js";
import { DatasetsController } from "./datasets/datasets.controller.js";
import { DatasetsService } from "./datasets/datasets.service.js";
import { EvaluationsController } from "./evaluations/evaluations.controller.js";
import { EvaluationsService } from "./evaluations/evaluations.service.js";
import { EvolutionFeedbackController } from "./feedback/feedback.controller.js";
import { EvolutionFeedbackService } from "./feedback/feedback.service.js";
import { EvolutionProposalsController } from "./proposals/proposals.controller.js";
import { EvolutionProposalsService } from "./proposals/proposals.service.js";
import { ReleasesController } from "./releases/releases.controller.js";
import { ReleasesService } from "./releases/releases.service.js";

@Module({
  imports: [HttpCommonModule],
  controllers: [EvolutionFeedbackController, DatasetsController, EvolutionProposalsController, EvaluationsController, ReleasesController],
  providers: [EvolutionFeedbackService, DatasetsService, EvolutionProposalsService, EvaluationsService, ReleasesService],
})
export class EvolutionModule {}
