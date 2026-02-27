import { Injectable, Logger } from "@nestjs/common";

import { BadWebhookRequestError, parseBooleanEnv, readOptionalStringEnv } from "@mr-agent/core";
import {
  type LoggerLike,
  handlePlainGitHubWebhook,
} from "#integrations/github";
import {
  formatLogMessage,
  normalizeHeaderRecord,
  readHeaderValue,
  readRawBody,
} from "../webhook/webhook.utils.js";

const GITHUB_ACTIONABLE_EVENTS = new Set([
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
]);

@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger(GithubWebhookService.name);

  private readonly serviceLogger: LoggerLike = {
    info: (metadata, message) => {
      this.logger.log(formatLogMessage(message, metadata));
    },
    error: (metadata, message) => {
      this.logger.error(formatLogMessage(message, metadata));
    },
  };

  async handleTrigger(params: {
    payload: unknown;
    rawBody?: Buffer | string;
    headers: Record<string, string | string[] | undefined>;
    trustReplay?: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    const normalizedHeaders = normalizeHeaderRecord(params.headers);

    // Early guard: skip processing for non-actionable event types
    const eventType = readHeaderValue(params.headers, "x-github-event")?.toLowerCase();
    if (eventType && !GITHUB_ACTIONABLE_EVENTS.has(eventType)) {
      return { ok: true, message: `ignored event type: ${eventType}` };
    }

    const rawBody =
      readRawBody(params.rawBody) ??
      buildFallbackRawBodyForSignatureSkip(params.payload) ??
      buildFallbackRawBodyForReplay(params.payload, params.trustReplay);

    if (!rawBody) {
      throw new BadWebhookRequestError(
        "missing raw body for signature check",
      );
    }

    return handlePlainGitHubWebhook({
      payload: params.payload,
      rawBody,
      headers: normalizedHeaders,
      logger: this.serviceLogger,
      skipSignatureVerification: params.trustReplay === true,
    });
  }
}

function buildFallbackRawBodyForSignatureSkip(
  body: unknown,
): string | undefined {
  const skipSignature = parseBooleanEnv(readOptionalStringEnv("GITHUB_WEBHOOK_SKIP_SIGNATURE"));
  if (!skipSignature || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

/**
 * When replaying a stored webhook event the original rawBody may not have been
 * persisted. Since signature verification is skipped during replay anyway, we
 * can safely reconstruct a rawBody from the parsed payload — it is only needed
 * for the body-size guard in the integration layer.
 */
function buildFallbackRawBodyForReplay(
  body: unknown,
  trustReplay?: boolean,
): string | undefined {
  if (!trustReplay || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}
