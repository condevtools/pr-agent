import { RouteAccess } from "../../common/route-access.js";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiErrorFilter } from "../../common/filters/run-api-error.filter.js";
import { EvolutionProposalsService } from "./proposals.service.js";

@Controller("evolution/proposals")
@UseFilters(RunApiErrorFilter)
export class EvolutionProposalsController {
  constructor(@Inject(EvolutionProposalsService) private readonly service: EvolutionProposalsService) {}

  @Post()
  @HttpCode(201)
  @RouteAccess("evolution:propose")
  create(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.create(this.service.authenticate(request), key, body);
  }

  @Get(":id")
  @RouteAccess("evaluations:read")
  read(@Req() request: Request, @Param("id") id: string) {
    return this.service.read(this.service.authenticate(request), id);
  }
}
