import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { BadWebhookRequestError, readOptionalStringEnv } from "@mr-agent/core";
import { SubscriptionGuard } from "../../common/guards/subscription.guard.js";
import type { GitLabWebhookBody } from "#integrations/gitlab";
import {
  GitlabWebhookService,
  shouldRequireGitLabWebhookSecret,
} from "./gitlab.webhook.service.js";
import {
  buildHealthStatus,
  isDeepHealthQuery,
  type HealthStatus,
} from "../webhook/health.js";
import { incrementMetricCounter } from "../webhook/metrics-runtime.js";
import {
  assertWebhookReplayAuthorized,
  getStoredWebhookEventById,
  scheduleWebhookEventRecord,
  resolveStoredWebhookReplayPayload,
} from "../webhook/webhook-replay.js";
import { readHeaderValue, readRawBody, safeJsonStringify } from "../webhook/webhook.utils.js";
import type { RawBodyRequest } from "../../common/types/raw-body-request.js";

@Controller("gitlab")
export class GitlabWebhookController {
  constructor(private readonly gitlabWebhookService: GitlabWebhookService) {}

  @Get("health")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    const requiresSecret = shouldRequireGitLabWebhookSecret();
    const webhookConfigured =
      !requiresSecret || Boolean(readOptionalStringEnv("GITLAB_WEBHOOK_SECRET"));
    return buildHealthStatus({
      mode: "gitlab-webhook",
      deep: isDeepHealthQuery(deep),
      webhook: {
        name: "gitlab-webhook-secret",
        configured: webhookConfigured,
      },
    });
  }

  @Post("trigger")
  @UseGuards(SubscriptionGuard)
  async trigger(
    @Req() request: RawBodyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    const eventName = (readHeaderValue(headers, "x-gitlab-event") ?? "unknown").toLowerCase();
    const metricEvent = normalizeGitLabMetricEventName(eventName);
    incrementMetricCounter("mr_agent_webhook_requests_total", {
      platform: "gitlab",
      event: metricEvent,
    });

    try {
      const result = await this.gitlabWebhookService.handleTrigger({
        payload: request.body as GitLabWebhookBody | undefined,
        headers,
        rawBody: request.rawBody,
      });
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "gitlab",
        result: "ok",
      });
      scheduleWebhookEventRecord({
        platform: "gitlab",
        eventName,
        headers,
        payload: request.body as GitLabWebhookBody | undefined,
        rawBody:
          readRawBody(request.rawBody) ??
          (typeof request.body === "undefined"
            ? undefined
            : safeJsonStringify(request.body, "")),
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "gitlab",
        result: "error",
      });
      throw error;
    }
  }

  @Post("replay/:eventId")
  async replay(
    @Param("eventId") eventId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    assertWebhookReplayAuthorized(headers);
    const event = await getStoredWebhookEventById({
      id: eventId,
      platform: "gitlab",
    });
    if (!event) {
      throw new BadWebhookRequestError(`webhook replay event not found: ${eventId}`);
    }

    const payload = resolveStoredWebhookReplayPayload(event);
    if (!payload || typeof payload !== "object") {
      throw new BadWebhookRequestError(`replay payload is invalid for event: ${eventId}`);
    }

    const replayHeaders: Record<string, string> = {
      ...event.headers,
      "x-gitlab-event": event.eventName,
    };
    const overrideApiToken = readHeaderValue(headers, "x-gitlab-api-token");
    if (overrideApiToken) {
      replayHeaders["x-gitlab-api-token"] = overrideApiToken;
    }
    const overrideWebhookToken = readHeaderValue(headers, "x-gitlab-token");
    if (overrideWebhookToken) {
      replayHeaders["x-gitlab-token"] = overrideWebhookToken;
    }

    try {
      const result = await this.gitlabWebhookService.handleTrigger({
        payload: payload as GitLabWebhookBody,
        headers: replayHeaders,
        trustReplay: true,
      });
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "gitlab",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "gitlab",
        result: "error",
      });
      throw error;
    }
  }
}

const GITLAB_METRIC_EVENT_NAMES = new Set([
  "merge request hook",
  "note hook",
]);

function normalizeGitLabMetricEventName(eventName: string): string {
  if (GITLAB_METRIC_EVENT_NAMES.has(eventName)) {
    return eventName;
  }
  return "other";
}
