import { Controller, Get, Headers, Query } from "@nestjs/common";

import {
  assertWebhookReplayAuthorized,
  listStoredWebhookEvents,
  resolveWebhookEventListLimit,
  type ReplayPlatform,
  type StoredWebhookEventSummary,
} from "./replay/store.js";

@Controller()
export class WebhookEventsController {
  @Get("webhook/events")
  webhookEvents(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query("platform") platformRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<StoredWebhookEventSummary[]> {
    assertWebhookReplayAuthorized(headers);
    const platform = normalizeReplayPlatform(platformRaw);
    const limit = resolveWebhookEventListLimit(limitRaw);
    return listStoredWebhookEvents({ platform, limit });
  }
}

function normalizeReplayPlatform(value: string | undefined): ReplayPlatform | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "github" || normalized === "gitlab") {
    return normalized;
  }
  return undefined;
}
