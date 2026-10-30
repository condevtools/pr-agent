import { Injectable } from "@nestjs/common";
import { z } from "zod";

import { BadWebhookRequestError, logCore } from "#core";
import { runGitLabWebhook } from "../../../integrations/gitlab/webhooks/adapter.js";
import { verifyGitLabWebhookBodySize, verifyGitLabWebhookToken, shouldRequireGitLabWebhookSecret } from "#integrations/gitlab";
import { type GitLabWebhookBody } from "../../../integrations/gitlab/webhooks/contracts.js";
import {
  normalizeHeaderRecord,
  readRawBody,
} from "../../common/webhook-utils.js";
import { VerifiedWebhookHandlingError } from "../replay/store.js";

const gitlabWebhookPayloadSchema = z.object({
  object_kind: z.string().optional(),
  event_type: z.string().optional(),
  user: z
    .object({
      id: z.number().int().positive().optional(),
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
  private readonly serviceLogger = {
    info: (metadata: unknown, _message: string) => {
      logCore("debug", "gitlab_webhook.event", { metadata });
    },
    error: (metadata: unknown, _message: string) => {
      logCore("error", "gitlab_webhook.failed", { metadata });
    },
    warn: (_message: string) => {
      logCore("warn", "gitlab_webhook.warning");
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

    try {
      return await runGitLabWebhook({
        payload, headers: normalizedHeaders, logger: this.serviceLogger, rawBody: resolvedRawBody,
        skipSecurityVerification: true,
      });
    } catch (error) {
      throw params.trustReplay ? error : new VerifiedWebhookHandlingError(error);
    }
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
