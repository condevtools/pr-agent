import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiErrorFilter } from "../harness/runs.error-filter.js";
import { DatasetsService } from "./datasets.service.js";

@Controller("evaluation-datasets")
@UseFilters(RunApiErrorFilter)
export class DatasetsController {
  constructor(@Inject(DatasetsService) private readonly service: DatasetsService) {}

  @Post()
  @HttpCode(201)
  create(@Req() request: Request, @Body() body: unknown) { return this.service.create(request, body); }

  @Post(":id/cases")
  @HttpCode(201)
  addCase(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.addCase(request, id, body);
  }

  @Post(":id/freeze")
  freeze(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.freeze(request, id, body);
  }

  @Get(":id")
  read(@Req() request: Request, @Param("id") id: string) { return this.service.read(request, id); }

  @Get(":id/cases/:caseId/fixture")
  fixture(@Req() request: Request, @Param("id") id: string, @Param("caseId") caseId: string) {
    return this.service.readFixture(request, id, caseId);
  }
}
