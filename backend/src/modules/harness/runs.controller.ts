import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseFilters } from "@nestjs/common";
import type { Request, Response } from "express";

import { HarnessApiErrorFilter } from "./runs.error-filter.js";
import { RunsService } from "./runs.service.js";
import { RunControlError } from "../../harness/run-control-contracts.js";

@Controller("runs")
@UseFilters(HarnessApiErrorFilter)
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

  @Post(":id/commands/:kind")
  @HttpCode(202)
  command(@Req() request: Request, @Param("id") id: string, @Param("kind") kind: string, @Body() body: unknown) {
    return this.service.command(this.service.authenticate(request), id, kind, body);
  }
}
