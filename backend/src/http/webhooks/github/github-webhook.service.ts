import { Injectable } from "@nestjs/common";

import { BadWebhookRequestError, logCore, parseBooleanEnv, readOptionalStringEnv } from "#core";
import { getSharedGitHubProbot } from "../../../agent-runtime/runtime/credentials.js";
import { type LoggerLike } from "../../../review/platforms/github/contracts.js";
import type { MinimalGitHubOctokit } from "../../../integrations/github/api/types.js";
import { handleGitHubWebhookEvent, handlePlainGitHubWebhook, verifyWebhookSignature } from "#integrations/github";
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
    const signatureKind = verifyWebhookSignature(rawBody, normalizedHeaders);
    const eventName = normalizedHeaders["x-github-event"] ?? "unknown";
    return runVerifiedGitHubIntake({
      eventName,
      deliveryId: normalizedHeaders["x-github-delivery"],
      headers: normalizedHeaders,
      payload: params.payload,
      rawBody,
      execute: ({ sourceHash }) => signatureKind === "app"
        ? handleGitHubWebhookEvent({ eventName, payload: params.payload,
          octokit: createLazyGitHubInstallationOctokit(params.payload),
          logger: this.serviceLogger, runtimeMode: "github-app",
          deliveryId: normalizedHeaders["x-github-delivery"], sourceHash })
        : handlePlainGitHubWebhook({ payload: params.payload, rawBody, headers: normalizedHeaders,
          logger: this.serviceLogger, skipSignatureVerification: true,
          allowLifecycleMutation: false, sourceHash }),
    });
  }
}

function installationIdentity(payload: unknown): number {
  const installation = payload && typeof payload === "object"
    ? (payload as { installation?: unknown }).installation : undefined;
  const id = installation && typeof installation === "object"
    ? (installation as { id?: unknown }).id : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new BadWebhookRequestError("invalid GitHub App installation identity");
  }
  return id;
}

/** Defers installation authentication until a managed binding actually needs provider data. */
export function createLazyGitHubInstallationOctokit(
  payload: unknown,
  loadClient: (installationId: number) => Promise<object> = async (installationId) =>
    await getSharedGitHubProbot().auth(installationId) as object,
): MinimalGitHubOctokit {
  let client: Promise<object> | undefined;
  const resolve = () => client ??= loadClient(installationIdentity(payload));
  const method = (group: PropertyKey | undefined, name: PropertyKey) => async (...args: unknown[]) => {
    const root = await resolve() as Record<PropertyKey, unknown>;
    const parent = group === undefined ? root : root[group] as Record<PropertyKey, unknown>;
    const target = parent[name];
    if (typeof target !== "function") throw new Error("GitHub installation client method is unavailable");
    return Reflect.apply(target, parent, args);
  };
  const group = (name: PropertyKey): object => new Proxy({}, {
    get: (_target, property) => method(name, property),
  });
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === "paginate" || property === "getListFilesTruncated"
          || property === "getLastListFilesTruncated") return method(undefined, property);
      return group(property);
    },
  }) as MinimalGitHubOctokit;
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
