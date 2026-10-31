import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";

import { RunApiErrorFilter } from "../common/filters/run-api-error.filter.js";
import { RouteAccess } from "../common/route-access.js";
import { RunApiContextService } from "../common/run-api-context.service.js";
import { QualityService } from "./quality.service.js";

@Controller("quality")
@UseFilters(RunApiErrorFilter)
export class QualityController {
  constructor(
    @Inject(QualityService) private readonly service: QualityService,
    @Inject(RunApiContextService) private readonly context: RunApiContextService,
  ) {}

  @Get("prompts")
  @RouteAccess("quality:prompts:read")
  listPrompts(@Req() request: Request) {
    return this.service.listPrompts(this.context.authenticate(request));
  }

  @Post("prompts/pull")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  pullPrompt(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.pullPrompt(this.context.authenticate(request), key, body);
  }

  @Post("prompts/:id/activate")
  @RouteAccess("quality:prompts:approve")
  activatePrompt(@Req() request: Request, @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.activatePrompt(this.context.authenticate(request), id, key, body);
  }

  @Post("exports/datasets")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  exportDataset(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.exportDataset(this.context.authenticate(request), key, body);
  }

  @Post("exports/evaluations")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  exportEvaluation(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.exportEvaluation(this.context.authenticate(request), key, body);
  }

  @Post("exports/scores")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  exportScores(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.exportScores(this.context.authenticate(request), key, body);
  }

  @Post("annotations/queue")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  queueAnnotation(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.queueAnnotation(this.context.authenticate(request), key, body);
  }

  @Post("annotations/pull")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  pullAnnotations(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.pullAnnotations(this.context.authenticate(request), key, body);
  }

  @Get("annotations/inbox")
  @RouteAccess("quality:annotations:review")
  listInbox(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.service.listInbox(this.context.authenticate(request), query);
  }

  @Post("annotations/inbox/:id/reject")
  @RouteAccess("quality:annotations:review")
  rejectAnnotation(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.rejectAnnotation(this.context.authenticate(request), id, body);
  }

  @Post("annotations/inbox/:id/promote")
  @RouteAccess("quality:annotations:review")
  promoteAnnotation(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.service.promoteAnnotation(this.context.authenticate(request), id, body);
  }

  @Get("jobs")
  @RouteAccess("quality:sync:read")
  listJobs(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.service.listJobs(this.context.authenticate(request), query);
  }

  @Get("jobs/:id")
  @RouteAccess("quality:sync:read")
  readJob(@Req() request: Request, @Param("id") id: string) {
    return this.service.readJob(this.context.authenticate(request), id);
  }

  @Post("jobs/:id/retry")
  @HttpCode(202)
  @RouteAccess("quality:sync:execute")
  retryJob(@Req() request: Request, @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.retryJob(this.context.authenticate(request), id, key, body);
  }

  @Post("evaluators/judge")
  @HttpCode(202)
  @RouteAccess("quality:evaluators:run")
  admitJudge(@Req() request: Request, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    return this.service.admitJudge(this.context.authenticate(request), key, body);
  }

  @Get("evaluators/judge/:id")
  @RouteAccess("quality:evaluators:run")
  readJudge(@Req() request: Request, @Param("id") id: string) {
    return this.service.readJudge(this.context.authenticate(request), id);
  }
}
