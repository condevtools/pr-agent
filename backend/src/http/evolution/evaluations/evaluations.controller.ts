import { RouteAccess } from "../../common/route-access.js";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiErrorFilter } from "../../common/filters/run-api-error.filter.js";
import { EvaluationsService } from "./evaluations.service.js";

@Controller("evolution/evaluations")
@UseFilters(RunApiErrorFilter)
export class EvaluationsController {
  constructor(@Inject(EvaluationsService) private readonly service: EvaluationsService) {}

  @Post()
  @HttpCode(202)
  @RouteAccess("evaluations:create")
  create(@Req() request: Request, @Body() body: unknown) { return this.service.create(request, body); }

  @Get(":id")
  @RouteAccess("evaluations:read")
  read(@Req() request: Request, @Param("id") id: string) { return this.service.read(request, id); }
}
