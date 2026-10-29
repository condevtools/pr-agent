import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiContextService } from "../common/run-api-context.service.js";
import { RunApiErrorFilter } from "../runs/runs.error-filter.js";
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
  createFix(@Req() request: Request, @Headers("idempotency-key") key: string | undefined,
    @Param("id") id: string, @Body() body: unknown) {
    return this.service.createFix(this.context.authenticate(request), id, key, body);
  }

  @Post(":id/fix-approvals")
  @HttpCode(201)
  createFixApproval(@Req() request: Request, @Headers("idempotency-key") key: string | undefined,
    @Param("id") id: string, @Body() body: unknown) {
    return this.service.createFixApproval(this.context.authenticate(request), id, key, body);
  }

  @Post(":id/fix-relevance")
  @HttpCode(201)
  attestFixRelevance(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.attestFixRelevance(this.context.authenticate(request), id, body);
  }

  @Post(":id/fix-approvals/:approvalId/approve")
  @HttpCode(202)
  approveFix(@Req() request: Request, @Param("id") id: string, @Param("approvalId") approvalId: string,
    @Body() body: unknown) {
    return this.service.approveFix(this.context.authenticate(request), id, approvalId, body);
  }

  @Post(":id/fix-approvals/:approvalId/revoke")
  revokeFix(@Req() request: Request, @Param("id") id: string, @Param("approvalId") approvalId: string,
    @Body() body: unknown) {
    return this.service.revokeFix(this.context.authenticate(request), id, approvalId, body);
  }
}
