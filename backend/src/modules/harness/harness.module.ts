import { Module } from "@nestjs/common";

import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { EvolutionFeedbackController } from "../evolution/feedback.controller.js";
import { EvolutionFeedbackService } from "../evolution/feedback.service.js";
import { DatasetsController } from "../evolution/datasets.controller.js";
import { DatasetsService } from "../evolution/datasets.service.js";
import { EvolutionProposalsController } from "../evolution/proposals.controller.js";
import { EvolutionProposalsService } from "../evolution/proposals.service.js";
import { EvaluationsController } from "../evolution/evaluations.controller.js";
import { EvaluationsService } from "../evolution/evaluations.service.js";

@Module({ controllers: [RunsController, EvolutionFeedbackController, DatasetsController, EvolutionProposalsController, EvaluationsController],
  providers: [RunsService, EvolutionFeedbackService, DatasetsService, EvolutionProposalsService, EvaluationsService] })
export class HarnessModule {}
