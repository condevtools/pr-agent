import { Injectable } from "@nestjs/common";

import { BadWebhookRequestError, logCore, parseBooleanEnv, readOptionalStringEnv } from "#core";
import { type LoggerLike } from "../../../review/platforms/github/contracts.js";
import { handlePlainGitHubWebhook, verifyWebhookSignature } from "#integrations/github";
import { runVerifiedGitHubIntake } from "./verified-github-intake.js";
import {
  normalizeHeaderRecord,
  readRawBody,
} from "../../common/webhook-utils.js";

@Injectable()
export class GithubWebhookService {
  private readonly serviceLogger: LoggerLike = {
    info: (metadata, _message) => {
      logCore("debug", "github_webhook.event", { metadata });
    },
    error: (metadata, _message) => {
      logCore("error", "github_webhook.failed", { metadata });
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
        skipSignatureVerification: true, allowLifecycleMutation: false, sourceHash: params.sourceHash,
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
        skipSignatureVerification: true, allowLifecycleMutation: true, sourceHash,
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
