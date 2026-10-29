import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiErrorFilter } from "../../runs/runs.error-filter.js";
import { EvolutionFeedbackService } from "./feedback.service.js";

@Controller("evolution/runs")
@UseFilters(RunApiErrorFilter)
export class EvolutionFeedbackController {
  constructor(@Inject(EvolutionFeedbackService) private readonly service: EvolutionFeedbackService) {}

  @Post(":id/feedback")
  @HttpCode(201)
  feedback(@Req() request: Request, @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.feedback(this.service.authenticate(request), id, key, body);
  }

  @Post(":id/annotations")
  @HttpCode(201)
  annotate(@Req() request: Request, @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.annotate(this.service.authenticate(request), id, key, body);
  }

  @Post(":id/annotations/arbitrate")
  @HttpCode(201)
  arbitrate(@Req() request: Request, @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.arbitrate(this.service.authenticate(request), id, key, body);
  }
}
