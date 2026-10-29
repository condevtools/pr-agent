import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseFilters } from "@nestjs/common";
import type { Request, Response } from "express";

import { RunApiErrorFilter } from "./runs.error-filter.js";
import { RunsService } from "./runs.service.js";
import { RunControlError } from "../../agent-runtime/runs/control-contracts.js";

@Controller("runs")
@UseFilters(RunApiErrorFilter)
export class RunsController {
  constructor(@Inject(RunsService) private readonly service: RunsService) {}

  @Post()
  @HttpCode(202)
  async create(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const result = await this.service.create(this.service.authenticate(request), key, body);
    return { ...result, links: { self: `/runs/${result.id}`, events: `/runs/${result.id}/events` } };
  }

  @Get(":id")
  snapshot(@Req() request: Request, @Param("id") id: string) { return this.service.snapshot(this.service.authenticate(request), id); }

  @Get(":id/events")
  events(@Req() request: Request, @Param("id") id: string, @Query("after") after?: string, @Query("limit") limit?: string) {
    return this.service.events(this.service.authenticate(request), id, after, limit);
  }

  @Get(":id/events/stream")
  async stream(@Req() request: Request, @Res() response: Response, @Param("id") id: string, @Query("after") after?: string): Promise<void> {
    const lastEventId = request.headers["last-event-id"];
    if (Array.isArray(lastEventId)) throw new RunControlError("INVALID_CURSOR", 400, "Ambiguous event cursor");
    await this.service.stream(this.service.authenticate(request), id, lastEventId ?? after, response);
  }

  @Get(":id/trace")
  trace(@Req() request: Request, @Param("id") id: string, @Query("after") after?: string) {
    return this.service.trace(this.service.authenticate(request), id, after);
  }

  @Get(":id/artifact")
  artifact(@Req() request: Request, @Param("id") id: string, @Query("raw") raw?: string) {
    return this.service.artifact(this.service.authenticate(request), id, raw);
  }

  @Post(":id/fixes")
  @HttpCode(202)
  createFix(@Req() request: Request, @Headers("idempotency-key") key: string | undefined,
    @Param("id") id: string, @Body() body: unknown) {
    return this.service.createFix(this.service.authenticate(request), id, key, body);
  }

  @Post(":id/fix-approvals")
  @HttpCode(201)
  createFixApproval(@Req() request: Request, @Headers("idempotency-key") key: string | undefined,
    @Param("id") id: string, @Body() body: unknown) {
    return this.service.createFixApproval(this.service.authenticate(request), id, key, body);
  }

  @Post(":id/fix-relevance")
  @HttpCode(201)
  attestFixRelevance(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.attestFixRelevance(this.service.authenticate(request), id, body);
  }

  @Post(":id/fix-approvals/:approvalId/approve")
  @HttpCode(202)
  approveFix(@Req() request: Request, @Param("id") id: string, @Param("approvalId") approvalId: string,
    @Body() body: unknown) {
    return this.service.approveFix(this.service.authenticate(request), id, approvalId, body);
  }

  @Post(":id/fix-approvals/:approvalId/revoke")
  revokeFix(@Req() request: Request, @Param("id") id: string, @Param("approvalId") approvalId: string,
    @Body() body: unknown) {
    return this.service.revokeFix(this.service.authenticate(request), id, approvalId, body);
  }

  @Post(":id/commands/:kind")
  @HttpCode(202)
  command(@Req() request: Request, @Param("id") id: string, @Param("kind") kind: string, @Body() body: unknown) {
    return this.service.command(this.service.authenticate(request), id, kind, body);
  }
}
