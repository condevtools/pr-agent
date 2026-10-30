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
import type { GitLabWebhookBody } from "../../../integrations/gitlab/webhooks/contracts.js";
import {
  GitlabWebhookService,
  shouldRequireGitLabWebhookSecret,
} from "./gitlab-webhook.service.js";
import {
  buildHealthStatus,
  isDeepHealthQuery,
  type HealthStatus,
} from "../../system/health.js";
import { incrementMetricCounter } from "../../system/metrics-runtime.js";
import {
  getStoredWebhookEventById,
  recordWebhookEvent,
  replayNotFound,
  resolveStoredWebhookReplayPayload,
  resolveWebhookReplayScope,
  VerifiedWebhookHandlingError,
} from "../replay/store.js";
import { readHeaderValue, readRawBody, safeJsonStringify } from "../../common/webhook-utils.js";
import type { RawBodyRequest } from "../../common/types/raw-body-request.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";
import { requireRunPermission } from "../../../agent-runtime/runs/control-contracts.js";

@Controller("gitlab")
export class GitlabWebhookController {
  constructor(private readonly gitlabWebhookService: GitlabWebhookService,
    private readonly context: RunApiContextService) {}

  @Get("health")
  @RouteAccess("public")
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
  @RouteAccess("signed-webhook")
  async trigger(
    @Req() request: RawBodyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    const eventName = (readHeaderValue(headers, "x-gitlab-event") ?? "unknown").toLowerCase();
    const metricEvent = normalizeGitLabMetricEventName(eventName);
    incrementMetricCounter("pr_agent_webhook_requests_total", {
      platform: "gitlab",
      event: metricEvent,
    });

    try {
      const result = await this.gitlabWebhookService.handleTrigger({
        payload: request.body as GitLabWebhookBody | undefined,
        headers,
        rawBody: request.rawBody,
      });
      incrementMetricCounter("pr_agent_webhook_results_total", {
        platform: "gitlab",
        result: "ok",
      });
      const scope = await resolveWebhookReplayScope("gitlab", request.body);
      if (scope) await recordWebhookEvent({ scope, eventName, headers, payload: request.body,
        rawBody: readRawBody(request.rawBody) ?? safeJsonStringify(request.body, ""),
        outcome: "succeeded", outcomeCode: "handled" });
      return result;
    } catch (error) {
      incrementMetricCounter("pr_agent_webhook_results_total", {
        platform: "gitlab",
        result: "error",
      });
      if (error instanceof VerifiedWebhookHandlingError) {
        const scope = await resolveWebhookReplayScope("gitlab", request.body);
        if (scope) await recordWebhookEvent({ scope, eventName, headers, payload: request.body,
          rawBody: readRawBody(request.rawBody) ?? safeJsonStringify(request.body, ""), outcome: "failed",
          outcomeCode: error.cause instanceof Error ? error.cause.name : "handler_error" });
        throw error.cause;
      }
      throw error;
    }
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
      platform: "gitlab",
    });
    if (!event) {
      throw replayNotFound(eventId);
    }

    const payload = resolveStoredWebhookReplayPayload(event);
    if (!payload || typeof payload !== "object") {
      throw replayNotFound(eventId);
    }

    const replayHeaders: Record<string, string> = {
      ...event.headers,
      "x-gitlab-event": event.eventName,
    };
    try {
      const result = await this.gitlabWebhookService.handleTrigger({
        payload: payload as GitLabWebhookBody,
        headers: replayHeaders,
        trustReplay: true,
      });
      incrementMetricCounter("pr_agent_webhook_replay_total", {
        platform: "gitlab",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("pr_agent_webhook_replay_total", {
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
