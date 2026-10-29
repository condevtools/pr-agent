import { Module } from "@nestjs/common";

import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { EvolutionFeedbackController } from "../evolution/feedback.controller.js";
import { EvolutionFeedbackService } from "../evolution/feedback.service.js";
import { DatasetsController } from "../evolution/datasets.controller.js";
import { DatasetsService } from "../evolution/datasets.service.js";

@Module({ controllers: [RunsController, EvolutionFeedbackController, DatasetsController],
  providers: [RunsService, EvolutionFeedbackService, DatasetsService] })
export class HarnessModule {}
