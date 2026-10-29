import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiErrorFilter } from "../../runs/runs.error-filter.js";
import { EvaluationsService } from "./evaluations.service.js";

@Controller("evolution/evaluations")
@UseFilters(RunApiErrorFilter)
export class EvaluationsController {
  constructor(@Inject(EvaluationsService) private readonly service: EvaluationsService) {}

  @Post()
  @HttpCode(202)
  create(@Req() request: Request, @Body() body: unknown) { return this.service.create(request, body); }

  @Get(":id")
  read(@Req() request: Request, @Param("id") id: string) { return this.service.read(request, id); }
}
