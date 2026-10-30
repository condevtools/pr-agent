import { readNumberEnv, readOptionalStringEnv } from "#core";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import { gitLabApiRequest } from "../../../integrations/gitlab/api/http-client.js";
import { resolveGitLabBaseUrl } from "../../../integrations/gitlab/repository/context.js";
import { buildMergeRequestPayloadFromNote, isGitLabBotUserName } from "../../../integrations/gitlab/webhooks/events.js";
import {
  gitlabNoteWebhookPayloadSchema,
  parseGitLabPayload,
  type GitLabNoteWebhookBody,
  type GitLabWebhookBody,
  type LoggerLike,
} from "../../../integrations/gitlab/webhooks/contracts.js";
import { resolveGitLabReviewPolicy } from "../../../review/policy/gitlab.js";
import { runGitLabReview } from "../../../review/platforms/gitlab/workflow.js";
import type { GitLabPublicationRuntime } from "../../../integrations/gitlab/publication/adapter.js";
import { authorizeGitLabDurableCommand, classifyDurableCommand } from "../../authorization.js";
import { parseReviewCommand } from "../../parsers/index.js";

const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;

function normalizeRateLimitPart(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9._:@/-]+/g, "-").slice(0, 160) || fallback;
}

export async function handleGitLabNoteWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const payload = parseGitLabPayload(gitlabNoteWebhookPayloadSchema, params.payload, "note") as GitLabNoteWebhookBody;
  if (String(payload.object_attributes.noteable_type ?? "").toLowerCase() !== "mergerequest") {
    return { ok: true, message: "ignored note event (not merge request note)" };
  }
  if (String(payload.object_attributes.action ?? "create").toLowerCase() !== "create") {
    return { ok: true, message: "ignored non-create note action" };
  }
  const body = typeof payload.object_attributes.note === "string" ? payload.object_attributes.note.trim() : "";
  if (!body) return { ok: true, message: "empty note body" };
  if (isGitLabBotUserName(payload.user?.username)) return { ok: true, message: "ignored note from bot user" };
  const command = classifyDurableCommand("gitlab", body);
  if (!command) return { ok: true, message: "ignored note content" };

  const mergePayload = buildMergeRequestPayloadFromNote(payload);
  const baseUrl = resolveGitLabBaseUrl(readOptionalStringEnv("GITLAB_BASE_URL"), payload.project.web_url);
  const runtime = await resolvePublicationRuntime({
    platform: "gitlab",
    origin: baseUrl,
    repository: payload.project.path_with_namespace ?? String(payload.project.id),
  });
  const token = await runtime.resolveCredential();
  await authorizeGitLabDurableCommand({
    projectId: payload.project.id,
    userId: payload.user?.id,
    getAccessLevel: async () => {
      const response = await gitLabApiRequest({
        url: `${baseUrl}/api/v4/projects/${encodeURIComponent(String(payload.project.id))}/members/all/${encodeURIComponent(String(payload.user?.id ?? ""))}`,
        token,
        retry: false,
      });
      if (response.status === 404) return 0;
      if (!response.ok) throw new Error(`GitLab member permission lookup failed (${response.status})`);
      const member = await response.json() as { access_level?: unknown };
      return typeof member.access_level === "number" ? member.access_level : undefined;
    },
  });
  if (await isGitLabReviewRateLimited({
    tenantId: runtime.binding.tenantId,
    integrationId: runtime.binding.id,
    origin: baseUrl,
    projectId: payload.project.id,
    mergeRequestId: mergePayload.object_attributes.iid,
    userId: payload.user?.id,
  })) return { ok: true, message: "review command rate limited" };

  const { policy } = await resolveGitLabReviewPolicy({
    baseUrl,
    projectId: payload.project.id,
    gitlabToken: token,
    ref: mergePayload.object_attributes.target_branch,
  });
  const parsed = parseReviewCommand(body);
  const result = await runGitLabReview({
    payload: mergePayload,
    headers: params.headers,
    logger: params.logger,
    publicationRuntime: runtime as GitLabPublicationRuntime,
    runActor: { actorType: "user", actorId: `gitlab-user:${payload.user!.id}` },
    mode: parsed.mode,
    trigger: "comment-command",
    customRules: policy.customRules,
    includeCiChecks: policy.includeCiChecks,
    enableSecretScan: policy.secretScanEnabled,
    secretScanCustomPatterns: policy.secretScanCustomPatterns,
    enableAutoLabel: policy.autoLabelEnabled,
    throwOnError: true,
  });
  return { ok: true, message: result.runId ? "review command queued" : result.message };
}

function isGitLabReviewRateLimited(input: {
  tenantId: string;
  integrationId: string;
  origin: string;
  projectId: number;
  mergeRequestId: number;
  userId?: number;
}): Promise<boolean> {
  const max = Math.max(1, readNumberEnv("COMMAND_RATE_LIMIT_MAX", DEFAULT_COMMAND_RATE_LIMIT_MAX));
  const windowMs = Math.max(1_000, readNumberEnv("COMMAND_RATE_LIMIT_WINDOW_MS", DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS));
  const key = `gitlab:${normalizeRateLimitPart(input.origin, "origin")}:project:${input.projectId}`
    + `:mr:${input.mergeRequestId}:user:${input.userId ?? "unknown"}:cmd:review`;
  return getAgentRuntimeServices().then(({ businessState }) => businessState.isRateLimited({
    tenantId: input.tenantId,
    integrationId: input.integrationId,
    key,
    limit: max,
    windowMs,
  }));
}
