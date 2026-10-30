import { BadWebhookRequestError, readOptionalStringEnv } from "#core";
import { bindingAllowsCapability, resolveRuntimeCapabilities } from "../../agent-runtime/runtime/capabilities.js";
import { resolvePublicationRuntime } from "../../agent-runtime/runtime/publication.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import type { RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { authorizeGitHubDurableCommand, authorizeGitLabDurableCommand } from "../../commands/authorization.js";
import type { GitHubReviewContext } from "../../review/platforms/github/contracts.js";
import { guardGitHubOctokit } from "../../integrations/github/api/http-client.js";
import { gitLabApiRequest } from "../../integrations/gitlab/api/http-client.js";
import { resolveGitLabBaseUrl } from "../../integrations/gitlab/repository/context.js";
import { isGitLabBotUserName } from "../../integrations/gitlab/webhooks/events.js";
import type { GitLabNoteWebhookBody } from "../../integrations/gitlab/webhooks/contracts.js";
import { loadRepositoryPolicyConfig } from "../../issues/policy/github/config.js";
import { resolveGitLabReviewPolicy } from "../../review/policy/gitlab.js";
import { parseProviderFeedbackCommand } from "./contracts.js";
import { PgEvolutionFeedbackStore } from "./store.js";

export interface ProviderFeedbackHandleResult { ok: true; message: string }

export async function handleGitHubProviderFeedback(params: {
  context: GitHubReviewContext;
  origin: string;
  owner: string;
  repo: string;
  repositoryId?: number;
  pullNumber: number;
  body: string;
  commentId?: number;
  actor?: { id?: number; type?: string; login?: string } | null;
}): Promise<ProviderFeedbackHandleResult | undefined> {
  const command = parseProviderFeedbackCommand(params.body);
  if (!command) return undefined;
  if (!resolveRuntimeCapabilities().evolution) return { ok: true, message: "feedback command ignored: evolution disabled" };
  if (isBot(params.actor)) return { ok: true, message: "feedback command ignored: bot actor" };
  if (!Number.isSafeInteger(params.commentId) || (params.commentId ?? 0) <= 0) {
    return { ok: true, message: "feedback command ignored: stable provider event id required" };
  }
  const runtime = await resolvePublicationRuntime({ platform: "github", origin: params.origin,
    repository: `${params.owner}/${params.repo}` });
  if (!bindingAllowsCapability(runtime.binding, "evolution")) {
    return { ok: true, message: "feedback command ignored: evolution disabled for integration" };
  }
  const repositoryId = positiveInteger(params.repositoryId);
  if (!repositoryId || repositoryId !== runtime.binding.providerRepositoryId) {
    throw new BadWebhookRequestError("GitHub feedback repository identity does not match its binding");
  }
  const context = { ...params.context, octokit: guardGitHubOctokit(params.context.octokit) };
  const policy = await loadRepositoryPolicyConfig({ context, owner: params.owner, repo: params.repo });
  if (!policy.review.feedbackCommandEnabled) {
    return { ok: true, message: "feedback command ignored: disabled by repository policy" };
  }
  if (!context.octokit.repos.getCollaboratorPermissionLevel) {
    throw new Error("GitHub collaborator permission API is unavailable");
  }
  await authorizeGitHubDurableCommand({ owner: params.owner, repo: params.repo,
    login: params.actor?.login, userId: params.actor?.id,
    getPermission: async () => (await context.octokit.repos.getCollaboratorPermissionLevel!({
      owner: params.owner, repo: params.repo, username: params.actor?.login ?? "",
    })).data.permission });
  const eventId = `github-comment:${params.commentId}`;
  const principal = providerPrincipal(runtime.binding.tenantId, runtime.binding.id,
    `github-user:${params.actor!.id}`);
  await (await feedbackStore()).recordProviderObservation(principal,
    `provider-feedback:${eventId}`, {
      sourceRunId: command.sourceRunId, sentiment: command.sentiment, comment: command.comment,
      target: { platform: "github", origin: runtime.binding.origin, repository: runtime.binding.repository,
        providerRepositoryId: runtime.binding.providerRepositoryId, number: params.pullNumber },
      provenance: { method: "authorized_provider_comment", provider: "github", eventId,
        actorProviderId: String(params.actor!.id), providerSentiment: command.sentiment },
    });
  return { ok: true, message: "provider feedback recorded" };
}

export async function handleGitLabProviderFeedback(params: {
  payload: GitLabNoteWebhookBody;
}): Promise<ProviderFeedbackHandleResult | undefined> {
  const body = typeof params.payload.object_attributes.note === "string"
    ? params.payload.object_attributes.note.trim() : "";
  const command = parseProviderFeedbackCommand(body);
  if (!command) return undefined;
  if (String(params.payload.object_attributes.noteable_type ?? "").toLowerCase() !== "mergerequest"
      || String(params.payload.object_attributes.action ?? "create").toLowerCase() !== "create") {
    return { ok: true, message: "feedback command ignored: not a created merge request note" };
  }
  if (!resolveRuntimeCapabilities().evolution) return { ok: true, message: "feedback command ignored: evolution disabled" };
  if (isGitLabBotUserName(params.payload.user?.username)) {
    return { ok: true, message: "feedback command ignored: bot actor" };
  }
  const noteId = positiveInteger(params.payload.object_attributes.id);
  const targetNumber = positiveInteger(params.payload.merge_request?.iid)
    ?? positiveInteger(params.payload.object_attributes.noteable_iid);
  if (!noteId || !targetNumber) {
    return { ok: true, message: "feedback command ignored: stable provider event and target required" };
  }
  const origin = resolveGitLabBaseUrl(readOptionalStringEnv("GITLAB_BASE_URL"), params.payload.project.web_url);
  const runtime = await resolvePublicationRuntime({ platform: "gitlab", origin,
    repository: params.payload.project.path_with_namespace ?? String(params.payload.project.id) });
  if (!bindingAllowsCapability(runtime.binding, "evolution")) {
    return { ok: true, message: "feedback command ignored: evolution disabled for integration" };
  }
  const projectId = positiveInteger(params.payload.project.id);
  if (!projectId || projectId !== runtime.binding.providerRepositoryId) {
    throw new BadWebhookRequestError("GitLab feedback project identity does not match its binding");
  }
  const token = await runtime.resolveCredential();
  const { policy } = await resolveGitLabReviewPolicy({ baseUrl: origin, projectId,
    gitlabToken: token, ref: params.payload.merge_request?.target_branch ?? "HEAD" });
  if (!policy.feedbackCommandEnabled) {
    return { ok: true, message: "feedback command ignored: disabled by repository policy" };
  }
  await authorizeGitLabDurableCommand({ projectId, userId: params.payload.user?.id,
    getAccessLevel: async () => {
      const response = await gitLabApiRequest({
        url: `${origin}/api/v4/projects/${encodeURIComponent(String(projectId))}`
          + `/members/all/${encodeURIComponent(String(params.payload.user?.id ?? ""))}`,
        token, retry: false,
      });
      if (response.status === 404) return 0;
      if (!response.ok) throw new Error(`GitLab member permission lookup failed (${response.status})`);
      const member = await response.json() as { access_level?: unknown };
      return typeof member.access_level === "number" ? member.access_level : undefined;
    } });
  const eventId = `gitlab-note:${noteId}`;
  const principal = providerPrincipal(runtime.binding.tenantId, runtime.binding.id,
    `gitlab-user:${params.payload.user!.id}`);
  await (await feedbackStore()).recordProviderObservation(principal,
    `provider-feedback:${eventId}`, {
      sourceRunId: command.sourceRunId, sentiment: command.sentiment, comment: command.comment,
      target: { platform: "gitlab", origin: runtime.binding.origin, repository: runtime.binding.repository,
        providerRepositoryId: runtime.binding.providerRepositoryId, number: targetNumber },
      provenance: { method: "authorized_provider_comment", provider: "gitlab", eventId,
        actorProviderId: String(params.payload.user!.id), providerSentiment: command.sentiment },
    });
  return { ok: true, message: "provider feedback recorded" };
}

async function feedbackStore(): Promise<PgEvolutionFeedbackStore> {
  return new PgEvolutionFeedbackStore((await getAgentRuntimeServices()).db);
}

function providerPrincipal(tenantId: string, integrationId: string, subjectId: string): RunPrincipal {
  return { tenantId, integrationId, subjectId, actorType: "user", permissions: [] };
}

function isBot(actor: { type?: string; login?: string } | null | undefined): boolean {
  return (actor?.type ?? "").toLowerCase() === "bot"
    || (actor?.login ?? "").trim().toLowerCase().endsWith("[bot]");
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
