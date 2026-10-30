import { RouteAccess } from "../common/route-access.js";
import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";

import {
  listStoredWebhookEvents,
  normalizeWebhookDeliveryId,
  resolveWebhookEventListLimit,
  type ReplayPlatform,
  type StoredWebhookEventSummary,
} from "./replay/store.js";
import { RunApiContextService } from "../common/run-api-context.service.js";
import { requireRunPermission } from "../../agent-runtime/runs/control-contracts.js";

@Controller()
export class WebhookEventsController {
  constructor(private readonly context: RunApiContextService) {}

  @Get("webhook/events")
  @RouteAccess("replay:read")
  webhookEvents(
    @Req() request: Request,
    @Query("platform") platformRaw?: string,
    @Query("deliveryId") deliveryIdRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<StoredWebhookEventSummary[]> {
    const principal = this.context.authenticate(request);
    requireRunPermission(principal, "replay:read");
    const platform = normalizeReplayPlatform(platformRaw);
    const deliveryId = normalizeWebhookDeliveryId(deliveryIdRaw);
    const limit = resolveWebhookEventListLimit(limitRaw);
    return listStoredWebhookEvents({ principal, platform, deliveryId, limit });
  }
}

function normalizeReplayPlatform(value: string | undefined): ReplayPlatform | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "github" || normalized === "gitlab") {
    return normalized;
  }
  return undefined;
}
