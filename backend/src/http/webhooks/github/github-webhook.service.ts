import { Injectable, Logger } from "@nestjs/common";

import { BadWebhookRequestError, parseBooleanEnv, readOptionalStringEnv } from "#core";
import { type LoggerLike } from "../../../review/platforms/github/contracts.js";
import { handlePlainGitHubWebhook, verifyWebhookSignature } from "#integrations/github";
import { runVerifiedGitHubIntake } from "./verified-github-intake.js";
import {
  formatLogMessage,
  normalizeHeaderRecord,
  readRawBody,
} from "../../common/webhook-utils.js";

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
    sourceHash?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const normalizedHeaders = normalizeHeaderRecord(params.headers);
    const rawBody =
      readRawBody(params.rawBody) ??
      buildFallbackRawBodyForSignatureSkip(params.payload);

    if (!rawBody) {
      throw new BadWebhookRequestError(
        "missing raw body for signature check",
      );
    }

    if (params.trustReplay) {
      return await handlePlainGitHubWebhook({
        payload: params.payload, rawBody, headers: normalizedHeaders, logger: this.serviceLogger,
        skipSignatureVerification: true, sourceHash: params.sourceHash,
      });
    }
    verifyWebhookSignature(rawBody, normalizedHeaders);
    const eventName = normalizedHeaders["x-github-event"] ?? "unknown";
    return runVerifiedGitHubIntake({
      eventName,
      deliveryId: normalizedHeaders["x-github-delivery"],
      headers: normalizedHeaders,
      payload: params.payload,
      rawBody,
      execute: ({ sourceHash }) => handlePlainGitHubWebhook({
        payload: params.payload, rawBody, headers: normalizedHeaders, logger: this.serviceLogger,
        skipSignatureVerification: true, sourceHash,
      }),
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
