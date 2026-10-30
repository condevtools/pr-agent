import { readOptionalStringEnv } from "#core";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import { PublicationBindingNotFoundError } from "../../../agent-runtime/authority/publication-authority.js";
import { handleGitLabNoteWebhook } from "../../../commands/platforms/gitlab/handler.js";
import { CommandAuthorizationError } from "../../../commands/authorization.js";
import { resolveGitLabReviewPolicy, type GitLabReviewPolicy } from "../../../review/policy/gitlab.js";
import { runGitLabReview } from "../../../review/platforms/gitlab/workflow.js";
import type { GitLabPublicationRuntime } from "../publication/adapter.js";
import { requireGitLabToken, resolveGitLabBaseUrl } from "../repository/context.js";
import { gitlabMrWebhookPayloadSchema, parseGitLabPayload, type GitLabMrWebhookBody, type GitLabWebhookBody } from "./contracts.js";
import { type LoggerLike } from "./contracts.js";
import { verifyGitLabWebhookBodySize, verifyGitLabWebhookToken } from "./security.js";

export async function runGitLabWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  rawBody?: string | Buffer;
  skipSecurityVerification?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  try {
    return await runTrustedGitLabWebhook(params);
  } catch (error) {
    if (error instanceof PublicationBindingNotFoundError) {
      params.logger.info({ reason: "publication_binding_not_found" }, "ignored unmanaged GitLab repository");
      return { ok: true, message: "ignored unmanaged repository" };
    }
    if (error instanceof CommandAuthorizationError) {
      params.logger.info({ reason: "command_actor_not_authorized" }, "ignored unauthorized GitLab command");
      return { ok: true, message: "ignored unauthorized command" };
    }
    throw error;
  }
}

async function runTrustedGitLabWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  rawBody?: string | Buffer;
  skipSecurityVerification?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  if (!params.skipSecurityVerification) {
    if (params.rawBody) {
      verifyGitLabWebhookBodySize(params.rawBody);
    }
    const warnLogger =
      "warn" in params.logger &&
      typeof (params.logger as Record<string, unknown>).warn === "function"
        ? (params.logger as unknown as { warn: (message: string) => void })
        : undefined;
    verifyGitLabWebhookToken(params.headers, warnLogger);
  }

  const kind = (params.payload.object_kind ?? "merge_request").toLowerCase();
  if (kind === "merge_request") {
    const payload = parseGitLabPayload(
      gitlabMrWebhookPayloadSchema,
      params.payload,
      "merge_request",
    ) as GitLabMrWebhookBody;
    const actionRaw = payload.object_attributes?.action;
    const action =
      typeof actionRaw === "string" ? actionRaw.toLowerCase() : undefined;
    if (action === "close" || action === "closed") {
      return { ok: true, message: "ignored closed merge request event" };
    }

    const baseUrl = resolveGitLabBaseUrl(
      readOptionalStringEnv("GITLAB_BASE_URL"),
      payload.project.web_url,
    );
    const publicationRuntime = await resolvePublicationRuntime({
      platform: "gitlab",
      origin: baseUrl,
      repository: payload.project.path_with_namespace ?? String(payload.project.id),
    });
    const gitlabToken = publicationRuntime?.resolveCredential
      ? await publicationRuntime.resolveCredential()
      : requireGitLabToken(params.headers);
    const actionKind = mapGitLabActionToReviewEvent(action);
    const { policy } = await resolveGitLabReviewPolicy({
      baseUrl,
      projectId: payload.project.id,
      gitlabToken,
      ref: payload.object_attributes.target_branch,
    });

    const resolvedMode = actionKind === "merged" ? "report" : policy.mode;
    const shouldRunByPolicy = shouldRunGitLabAutoReview(policy, actionKind);
    if (!shouldRunByPolicy) {
      return { ok: true, message: "merge_request action ignored by review policy" };
    }

    const trigger =
      actionKind === "opened"
        ? "pr-opened"
        : actionKind === "edited"
          ? "pr-edited"
          : actionKind === "synchronize"
            ? "pr-synchronize"
            : actionKind === "merged"
              ? "merged"
              : "gitlab-webhook";
    return runGitLabReview({
      payload,
      headers: params.headers,
      logger: params.logger,
      mode: resolvedMode,
      trigger,
      dedupeSuffix: payload.object_attributes.last_commit?.id,
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
      enableSecretScan: policy.secretScanEnabled,
      secretScanCustomPatterns: policy.secretScanCustomPatterns,
      enableAutoLabel: policy.autoLabelEnabled,
      publicationRuntime: publicationRuntime as GitLabPublicationRuntime | undefined,
    });
  }

  if (kind === "note") {
    return handleGitLabNoteWebhook(params);
  }

  return { ok: true, message: `ignored object_kind=${kind}` };
}
function mapGitLabActionToReviewEvent(
  actionRaw: string | undefined,
): "opened" | "edited" | "synchronize" | "merged" | "ignored" {
  const action = (actionRaw ?? "").toLowerCase();
  if (action === "open" || action === "reopen") {
    return "opened";
  }
  if (action === "update") {
    return "synchronize";
  }
  if (action === "merge") {
    return "merged";
  }
  if (action === "close" || action === "closed") {
    return "ignored";
  }
  return "edited";
}

function shouldRunGitLabAutoReview(
  policy: GitLabReviewPolicy,
  action: "opened" | "edited" | "synchronize" | "merged" | "ignored",
): boolean {
  if (!policy.enabled || action === "ignored") {
    return false;
  }
  if (action === "opened") {
    return policy.onOpened;
  }
  if (action === "edited") {
    return policy.onEdited;
  }
  if (action === "synchronize") {
    return policy.onSynchronize;
  }
  return true;
}
