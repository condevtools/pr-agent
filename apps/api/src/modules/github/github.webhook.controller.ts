import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";

import { BadWebhookRequestError, readOptionalStringEnv } from "@mr-agent/core";
import { GithubWebhookService } from "./github.webhook.service.js";
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
import { readHeaderValue, readRawBody } from "../webhook/webhook.utils.js";
import type { RawBodyRequest } from "../../common/types/raw-body-request.js";

@Controller("github")
export class GithubWebhookController {
  constructor(private readonly githubWebhookService: GithubWebhookService) {}

  @Get("health")
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
  async trigger(
    @Req() request: RawBodyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    const eventName = (readHeaderValue(headers, "x-github-event") ?? "unknown").toLowerCase();
    const metricEvent = normalizeGitHubMetricEventName(eventName);
    incrementMetricCounter("mr_agent_webhook_requests_total", {
      platform: "github",
      event: metricEvent,
    });

    try {
      const result = await this.githubWebhookService.handleTrigger({
        payload: request.body,
        rawBody: request.rawBody,
        headers,
      });
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "github",
        result: "ok",
      });
      scheduleWebhookEventRecord({
        platform: "github",
        eventName,
        headers,
        payload: request.body,
        rawBody: readRawBody(request.rawBody),
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "github",
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
      platform: "github",
    });
    if (!event) {
      throw new BadWebhookRequestError(`webhook replay event not found: ${eventId}`);
    }

    const payload = resolveStoredWebhookReplayPayload(event);
    if (typeof payload === "undefined") {
      throw new BadWebhookRequestError(`replay payload is empty for event: ${eventId}`);
    }

    try {
      const result = await this.githubWebhookService.handleTrigger({
        payload,
        rawBody: event.rawBody,
        headers: {
          ...event.headers,
          "x-github-event": event.eventName,
        },
        trustReplay: true,
      });
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "github",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "github",
        result: "error",
      });
      throw error;
    }
  }
}

const GITHUB_METRIC_EVENT_NAMES = new Set([
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review_thread",
]);

function normalizeGitHubMetricEventName(eventName: string): string {
  if (GITHUB_METRIC_EVENT_NAMES.has(eventName)) {
    return eventName;
  }
  return "other";
}
