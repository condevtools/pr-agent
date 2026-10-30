import { createHash } from "node:crypto";

import { incrementMetricCounter } from "../../system/metrics-runtime.js";
import {
  canonicalizeWebhookPayload,
  recordWebhookEvent,
  resolveWebhookReplayScope,
} from "../replay/store.js";

const GITHUB_METRIC_EVENT_NAMES = new Set([
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review_thread",
]);

export async function runVerifiedGitHubIntake(params: {
  eventName: string;
  deliveryId?: string;
  headers?: Record<string, string | string[] | undefined>;
  payload: unknown;
  rawBody?: string;
  execute: (intake: { sourceHash: string; normalizedPayloadText: string }) => Promise<{ ok: boolean; message: string }>;
}): Promise<{ ok: boolean; message: string }> {
  const eventName = params.eventName.trim().toLowerCase() || "unknown";
  const normalizedPayloadText = canonicalizeWebhookPayload(params.payload);
  const sourceHash = createHash("sha256").update(normalizedPayloadText).digest("hex");
  const headers = {
    ...params.headers,
    "x-github-event": eventName,
    ...(params.deliveryId ? { "x-github-delivery": params.deliveryId } : {}),
  };

  incrementMetricCounter("pr_agent_webhook_requests_total", {
    platform: "github",
    event: normalizeGitHubMetricEventName(eventName),
  });

  let result: { ok: boolean; message: string };
  try {
    result = await params.execute({ sourceHash, normalizedPayloadText });
  } catch (error) {
    incrementMetricCounter("pr_agent_webhook_results_total", { platform: "github", result: "error" });
    const scope = await resolveWebhookReplayScope("github", params.payload);
    if (scope) {
      await recordWebhookEvent({ scope, eventName, headers, payload: params.payload, rawBody: params.rawBody,
        normalizedPayloadText, outcome: "failed",
        outcomeCode: error instanceof Error ? error.name : "handler_error" });
    }
    throw error;
  }
  incrementMetricCounter("pr_agent_webhook_results_total", { platform: "github", result: "ok" });
  const scope = await resolveWebhookReplayScope("github", params.payload);
  if (scope) {
    await recordWebhookEvent({ scope, eventName, headers, payload: params.payload, rawBody: params.rawBody,
      normalizedPayloadText, outcome: "succeeded", outcomeCode: "handled" });
  }
  return result;
}

function normalizeGitHubMetricEventName(eventName: string): string {
  return GITHUB_METRIC_EVENT_NAMES.has(eventName) ? eventName : "other";
}
