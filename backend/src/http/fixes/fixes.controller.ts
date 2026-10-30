import { RouteAccess } from "../common/route-access.js";
import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiContextService } from "../common/run-api-context.service.js";
import { RunApiErrorFilter } from "../common/filters/run-api-error.filter.js";
import { FixesService } from "./fixes.service.js";

@Controller("runs")
@UseFilters(RunApiErrorFilter)
export class FixesController {
  constructor(
    @Inject(FixesService) private readonly service: FixesService,
    @Inject(RunApiContextService) private readonly context: RunApiContextService,
  ) {}

  @Post(":id/fixes")
  @HttpCode(202)
  @RouteAccess("fixes:create")
  createFix(@Req() request: Request, @Headers("idempotency-key") key: string | undefined,
    @Param("id") id: string, @Body() body: unknown) {
    return this.service.createFix(this.context.authenticate(request), id, key, body);
  }

  @Post(":id/fix-approvals")
  @HttpCode(201)
  @RouteAccess("fixes:create")
  createFixApproval(@Req() request: Request, @Headers("idempotency-key") key: string | undefined,
    @Param("id") id: string, @Body() body: unknown) {
    return this.service.createFixApproval(this.context.authenticate(request), id, key, body);
  }

  @Post(":id/fix-relevance")
  @HttpCode(201)
  @RouteAccess("fixes:approve")
  attestFixRelevance(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.attestFixRelevance(this.context.authenticate(request), id, body);
  }

  @Post(":id/fix-approvals/:approvalId/approve")
  @HttpCode(202)
  @RouteAccess("fixes:approve")
  approveFix(@Req() request: Request, @Param("id") id: string, @Param("approvalId") approvalId: string,
    @Body() body: unknown) {
    return this.service.approveFix(this.context.authenticate(request), id, approvalId, body);
  }

  @Post(":id/fix-approvals/:approvalId/revoke")
  @RouteAccess("fixes:revoke")
  revokeFix(@Req() request: Request, @Param("id") id: string, @Param("approvalId") approvalId: string,
    @Body() body: unknown) {
    return this.service.revokeFix(this.context.authenticate(request), id, approvalId, body);
  }
}
