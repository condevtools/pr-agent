import { RouteAccess } from "../../common/route-access.js";
import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";

import { readOptionalStringEnv } from "#core";
import { GithubWebhookService } from "./github-webhook.service.js";
import {
  buildHealthStatus,
  isDeepHealthQuery,
  type HealthStatus,
} from "../../system/health.js";
import { incrementMetricCounter } from "../../system/metrics-runtime.js";
import {
  getStoredWebhookEventById,
  replayNotFound,
  resolveStoredWebhookReplayPayload,
} from "../replay/store.js";
import type { RawBodyRequest } from "../../common/types/raw-body-request.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";
import { requireRunPermission } from "../../../agent-runtime/runs/control-contracts.js";

@Controller("github")
export class GithubWebhookController {
  constructor(private readonly githubWebhookService: GithubWebhookService,
    private readonly context: RunApiContextService) {}

  @Get("health")
  @RouteAccess("public")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    const webhookConfigured = Boolean(
      readOptionalStringEnv("GITHUB_WEBHOOK_SECRET") ??
        readOptionalStringEnv("WEBHOOK_SECRET"),
    );
    return buildHealthStatus({
      mode: "github-webhook",
      deep: isDeepHealthQuery(deep),
      webhook: {
        name: "github-webhook-secret",
        configured: webhookConfigured,
      },
    });
  }

  @Post("trigger")
  @RouteAccess("signed-webhook")
  async trigger(
    @Req() request: RawBodyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    return this.githubWebhookService.handleTrigger({ payload: request.body, rawBody: request.rawBody, headers });
  }

  @Post("replay/:eventId")
  @RouteAccess("replay:execute")
  async replay(
    @Param("eventId") eventId: string,
    @Req() request: RawBodyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    const principal = this.context.authenticate(request);
    requireRunPermission(principal, "replay:execute");
    const event = await getStoredWebhookEventById({
      principal, id: eventId,
      platform: "github",
    });
    if (!event) {
      throw replayNotFound(eventId);
    }

    const payload = resolveStoredWebhookReplayPayload(event);
    if (typeof payload === "undefined") {
      throw replayNotFound(eventId);
    }

    try {
      const result = await this.githubWebhookService.handleTrigger({
        payload,
        rawBody: JSON.stringify(payload),
        headers: {
          ...event.headers,
          "x-github-event": event.eventName,
        },
        trustReplay: true,
        sourceHash: event.payloadHash,
      });
      incrementMetricCounter("pr_agent_webhook_replay_total", {
        platform: "github",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("pr_agent_webhook_replay_total", {
        platform: "github",
        result: "error",
      });
      throw error;
    }
  }
}
