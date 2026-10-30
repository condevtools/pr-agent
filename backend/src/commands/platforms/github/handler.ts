import { readNumberEnv, readOptionalStringEnv } from "#core";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";
import { runGitHubReview } from "../../../review/platforms/github/workflow.js";
import { resolveGitHubReviewBehaviorPolicy } from "../../../issues/policy/github/workflow.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime/publication.js";
import { guardGitHubOctokit } from "../../../integrations/github/api/http-client.js";
import type { GitHubPublicationRuntime } from "../../../integrations/github/publication/contracts.js";
import { authorizeGitHubDurableCommand, classifyDurableCommand } from "../../authorization.js";
import { parseAddDocCommand, parseImproveCommand, parseImproveComponentCommand, parseReviewCommand } from "../../parsers/index.js";
import { buildAddDocRule, buildImproveComponentRule, buildImproveRule } from "../../builders/questions.js";

const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;

function normalizeRateLimitPart(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9._:@/-]+/g, "-").slice(0, 160) || fallback;
}

export async function handleGitHubIssueCommentCommand(params: {
  context: GitHubReviewContext; owner: string; repo: string; issueNumber: number; body: string;
  commentUser?: { id?: number; type?: string; login?: string } | null;
  isPullRequest?: boolean; issueTitle?: string; issueBody?: string;
  rateLimitPlatform: "github-app" | "github-webhook"; throwOnError?: boolean;
  sourceKey?: string; sourceHash?: string;
}): Promise<{ ok: boolean; message: string }> {
  if (isGitHubBotCommentUser(params.commentUser)) return { ok: true, message: "ignored issue_comment from bot" };
  if (params.isPullRequest === false) return { ok: true, message: "ignored issue_comment outside pull request" };
  const body = params.body.trim();
  const command = classifyDurableCommand("github", body);
  if (!command) return { ok: true, message: "ignored issue_comment content" };

  const context = guardGitHubCommandContext(params.context);
  const runtime = await resolvePublicationRuntime({
    platform: "github",
    origin: readOptionalStringEnv("GITHUB_API_URL") ?? "https://api.github.com",
    repository: `${params.owner}/${params.repo}`,
  });
  if (!context.octokit.repos.getCollaboratorPermissionLevel) throw new Error("GitHub collaborator permission API is unavailable");
  await authorizeGitHubDurableCommand({
    owner: params.owner, repo: params.repo, login: params.commentUser?.login, userId: params.commentUser?.id,
    getPermission: async () => (await context.octokit.repos.getCollaboratorPermissionLevel!({
      owner: params.owner, repo: params.repo, username: params.commentUser?.login ?? "",
    })).data.permission,
  });
  if (await isGitHubCommandRateLimited({
    tenantId: runtime.binding.tenantId, integrationId: runtime.binding.id,
    platform: params.rateLimitPlatform, owner: params.owner, repo: params.repo,
    pullNumber: params.issueNumber, userLogin: params.commentUser?.login, command,
  })) return { ok: true, message: `${command} command rate limited` };

  const behavior = await resolveGitHubReviewBehaviorPolicy({ context });
  const parsedReview = parseReviewCommand(body);
  const customRules = [...behavior.customRules];
  let enableSecretScan = behavior.secretScanEnabled;
  let enableAutoLabel = behavior.autoLabelEnabled;
  if (command === "improve") {
    if (!behavior.improveCommandEnabled) return { ok: true, message: "improve command disabled by policy" };
    customRules.push(buildImproveRule(parseImproveCommand(body).focus));
    enableAutoLabel = false;
  } else if (command === "add_doc") {
    if (!behavior.addDocCommandEnabled) return { ok: true, message: "add_doc command disabled by policy" };
    customRules.push(buildAddDocRule(parseAddDocCommand(body).focus));
    enableSecretScan = false;
    enableAutoLabel = false;
  } else if (command === "improve_component") {
    if (!behavior.improveCommandEnabled) return { ok: true, message: "improve_component command disabled by policy" };
    const parsed = parseImproveComponentCommand(body);
    customRules.push(buildImproveComponentRule(parsed.component));
    enableAutoLabel = false;
  }

  await runGitHubReview({
    context, pullNumber: params.issueNumber, mode: parsedReview.matched ? parsedReview.mode : "comment",
    trigger: "comment-command", customRules, includeCiChecks: behavior.includeCiChecks,
    enableSecretScan, secretScanCustomPatterns: behavior.secretScanCustomPatterns, enableAutoLabel,
    throwOnError: true, sourceKey: params.sourceKey, sourceHash: params.sourceHash,
    publicationRuntime: runtime as GitHubPublicationRuntime,
    runActor: { actorType: "user", actorId: `github-user:${params.commentUser!.id}` },
  });
  return { ok: true, message: `${command} command queued` };
}

export function guardGitHubCommandContext(context: GitHubReviewContext): GitHubReviewContext {
  return { ...context, octokit: guardGitHubOctokit(context.octokit) };
}

export function isGitHubBotCommentUser(user: { type?: string; login?: string } | null | undefined): boolean {
  return (user?.type ?? "").toLowerCase() === "bot" || (user?.login ?? "").trim().toLowerCase().endsWith("[bot]");
}

export function isGitHubCommandRateLimited(params: {
  tenantId: string; integrationId: string;
  platform: "github-app" | "github-webhook"; owner: string; repo: string; pullNumber: number;
  userLogin?: string; command: string;
}): Promise<boolean> {
  const maxPerWindow = Math.max(1, readNumberEnv("COMMAND_RATE_LIMIT_MAX", DEFAULT_COMMAND_RATE_LIMIT_MAX));
  const windowMs = Math.max(1_000, readNumberEnv("COMMAND_RATE_LIMIT_WINDOW_MS", DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS));
  const user = normalizeRateLimitPart(params.userLogin, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key = `${params.platform}:${normalizeRateLimitPart(params.owner, "unknown-owner")}/`
    + `${normalizeRateLimitPart(params.repo, "unknown-repo")}:pr:${params.pullNumber}:user:${user}:cmd:${command}`;
  return getAgentRuntimeServices().then(({ businessState }) => businessState.isRateLimited({
    tenantId: params.tenantId,
    integrationId: params.integrationId,
    key,
    limit: maxPerWindow,
    windowMs,
  }));
}
