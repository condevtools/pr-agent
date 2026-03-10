import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import {
  BadWebhookRequestError,
  readOptionalStringEnv,
} from "#core";
import {
  runGitLabWebhook,
  verifyGitLabWebhookBodySize,
  verifyGitLabWebhookToken,
  shouldRequireGitLabWebhookSecret,
  type GitLabWebhookBody,
} from "#integrations/gitlab";
import {
  formatLogMessage,
  normalizeHeaderRecord,
  readRawBody,
} from "../webhook/webhook.utils.js";

const gitlabWebhookPayloadSchema = z.object({
  object_kind: z.string().optional(),
  event_type: z.string().optional(),
  user: z
    .object({
      username: z.string().optional(),
    })
    .optional(),
  project: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    web_url: z.string().min(1),
    path_with_namespace: z.string().optional(),
  }),
  object_attributes: z.record(z.unknown()),
  merge_request: z.record(z.unknown()).optional(),
});

@Injectable()
export class GitlabWebhookService {
  private readonly logger = new Logger(GitlabWebhookService.name);

  private readonly serviceLogger = {
    info: (metadata: unknown, message: string) => {
      this.logger.log(formatLogMessage(message, metadata));
    },
    error: (metadata: unknown, message: string) => {
      this.logger.error(formatLogMessage(message, metadata));
    },
    warn: (message: string) => {
      this.logger.warn(formatLogMessage(message, {}));
    },
  };

  async handleTrigger(params: {
    payload: GitLabWebhookBody | undefined;
    headers: Record<string, string | string[] | undefined>;
    rawBody?: Buffer | string;
    trustReplay?: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    const resolvedRawBody = readRawBody(params.rawBody);

    // Verify body size using the raw body when available (accurate byte
    // count); fall back to estimating from the parsed payload otherwise.
    if (resolvedRawBody) {
      verifyGitLabWebhookBodySize(resolvedRawBody);
    } else {
      verifyGitLabWebhookPayloadSizeFallback(params.payload);
    }

    const payload = parseGitLabPayload(params.payload);

    const normalizedHeaders = normalizeHeaderRecord(params.headers);
    if (!params.trustReplay) {
      verifyGitLabWebhookToken(normalizedHeaders, this.serviceLogger);
    }

    // Backward compatibility: if webhook secret is not enabled,
    // keep accepting x-gitlab-token as API token.
    if (
      !normalizedHeaders["x-gitlab-api-token"] &&
      !readOptionalStringEnv("GITLAB_WEBHOOK_SECRET") &&
      normalizedHeaders["x-gitlab-token"]
    ) {
      normalizedHeaders["x-gitlab-api-token"] = normalizedHeaders["x-gitlab-token"];
    }

    return runGitLabWebhook({
      payload,
      headers: normalizedHeaders,
      logger: this.serviceLogger,
      rawBody: resolvedRawBody,
      // Security was already verified above; skip the duplicate check
      // inside runGitLabWebhook to avoid double-reading env vars and
      // double-logging warnings.
      skipSecurityVerification: true,
    });
  }
}

/**
 * Fallback body-size estimation when the raw body buffer is not
 * available (e.g. during replay). Re-serializes the parsed payload
 * to approximate the wire size.
 */
function verifyGitLabWebhookPayloadSizeFallback(payload: unknown): void {
  if (payload === null || payload === undefined) {
    return;
  }

  let payloadBytes: number;
  if (typeof payload === "string") {
    payloadBytes = Buffer.byteLength(payload, "utf8");
  } else {
    try {
      const serialized = JSON.stringify(payload);
      if (typeof serialized !== "string") {
        return;
      }
      payloadBytes = Buffer.byteLength(serialized, "utf8");
    } catch {
      return;
    }
  }

  // Delegate the actual threshold check to the canonical implementation.
  // Pass the byte count directly to avoid allocating a large buffer/string.
  verifyGitLabWebhookBodySize(payloadBytes);
}

function parseGitLabPayload(payload: unknown): GitLabWebhookBody {
  const parsed = gitlabWebhookPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data as GitLabWebhookBody;
  }

  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join(".") || "payload";
  throw new BadWebhookRequestError(
    `invalid gitlab payload: ${issuePath} ${firstIssue?.message ?? "schema validation failed"}`,
  );
}

export { shouldRequireGitLabWebhookSecret } from "#integrations/gitlab";
