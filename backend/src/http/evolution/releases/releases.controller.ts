import { RouteAccess } from "../../common/route-access.js";
import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";
import { RunApiErrorFilter } from "../../common/filters/run-api-error.filter.js";
import { ReleasesService } from "./releases.service.js";

@Controller("evolution/releases")
@UseFilters(RunApiErrorFilter)
export class ReleasesController {
  constructor(@Inject(ReleasesService) private readonly service: ReleasesService) {}
  @Post("qualify") @HttpCode(201) @RouteAccess("evolution:release:qualify")
  qualify(@Req() request: Request, @Body() body: unknown) { return this.service.qualify(request, body); }
  @Post("request") @HttpCode(202) @RouteAccess("evolution:release:request")
  createRequest(@Req() request: Request, @Body() body: unknown) { return this.service.request(request, body); }
  @Post("approve") @RouteAccess("evolution:release:approve")
  approve(@Req() request: Request, @Body() body: unknown) { return this.service.approve(request, body); }
  @Post("revoke") @RouteAccess("evolution:release:revoke")
  revoke(@Req() request: Request, @Body() body: unknown) { return this.service.revoke(request, body); }
  @Post("rollback") @RouteAccess("evolution:release:rollback")
  rollback(@Req() request: Request, @Body() body: unknown) { return this.service.rollback(request, body); }
  @Get() @RouteAccess("evolution:release:read")
  read(@Req() request: Request) { return this.service.read(request); }
}
