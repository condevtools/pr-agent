import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { HarnessApiErrorFilter } from "../harness/runs.error-filter.js";
import { EvolutionProposalsService } from "./proposals.service.js";

@Controller("evolution/proposals")
@UseFilters(HarnessApiErrorFilter)
export class EvolutionProposalsController {
  constructor(@Inject(EvolutionProposalsService) private readonly service: EvolutionProposalsService) {}

  @Post()
  @HttpCode(201)
  create(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.create(this.service.authenticate(request), key, body);
  }

  @Get(":id")
  read(@Req() request: Request, @Param("id") id: string) {
    return this.service.read(this.service.authenticate(request), id);
  }
}
