import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";
import { RunApiErrorFilter } from "../../runs/runs.error-filter.js";
import { ReleasesService } from "./releases.service.js";

@Controller("evolution/releases")
@UseFilters(RunApiErrorFilter)
export class ReleasesController {
  constructor(@Inject(ReleasesService) private readonly service: ReleasesService) {}
  @Post("qualify") @HttpCode(201) qualify(@Req() request: Request, @Body() body: unknown) { return this.service.qualify(request, body); }
  @Post("request") @HttpCode(202) createRequest(@Req() request: Request, @Body() body: unknown) { return this.service.request(request, body); }
  @Post("approve") approve(@Req() request: Request, @Body() body: unknown) { return this.service.approve(request, body); }
  @Post("revoke") revoke(@Req() request: Request, @Body() body: unknown) { return this.service.revoke(request, body); }
  @Post("rollback") rollback(@Req() request: Request, @Body() body: unknown) { return this.service.rollback(request, body); }
  @Get() read(@Req() request: Request) { return this.service.read(request); }
}
