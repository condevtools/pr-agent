import { readOptionalStringEnv } from "#core";
import type { ReviewMode } from "#review";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime.js";
import { handleGitLabNoteWebhook } from "../../../commands/platforms/gitlab/handler.js";
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

    const headerMode = parseMode(params.headers["x-ai-mode"]);
    const resolvedMode =
      actionKind === "merged" ? "report" : (headerMode ?? policy.mode);
    const shouldRunByPolicy = shouldRunGitLabAutoReview(policy, actionKind);
    if (!shouldRunByPolicy && !headerMode) {
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

function parseMode(modeRaw: string | undefined): ReviewMode | undefined {
  if (!modeRaw?.trim()) return undefined;
  const mode = modeRaw.trim().toLowerCase();
  if (mode === "comment") return "comment";
  if (mode === "report") return "report";
  return undefined;
}
