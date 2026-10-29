function isGitLabCommandRateLimited(params: {
  projectId: number;
  mrId: number;
  userName?: string;
  command: string;
}): boolean {
  const maxPerWindow = Math.max(
    1,
    readNumberEnv("COMMAND_RATE_LIMIT_MAX", DEFAULT_COMMAND_RATE_LIMIT_MAX),
  );
  const windowMs = Math.max(
    1_000,
    readNumberEnv(
      "COMMAND_RATE_LIMIT_WINDOW_MS",
      DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS,
    ),
  );
  const user = normalizeRateLimitPart(params.userName, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key =
    "gitlab:" +
    `${params.projectId}:mr:${params.mrId}:` +
    `user:${user}:cmd:${command}`;
  return isRateLimited(key, maxPerWindow, windowMs);
}

export async function shouldRejectGitLabCommandByRateLimit(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  projectId: number;
  mrId: number;
  userName?: string;
  command: string;
  logger?: LoggerLike;
}): Promise<boolean> {
  if (
    !isGitLabCommandRateLimited({
      projectId: params.projectId,
      mrId: params.mrId,
      userName: params.userName,
      command: params.command,
    })
  ) {
    return false;
  }

  await postGitLabCommandComment({
    gitlabToken: params.gitlabToken,
    target: params.target,
    body: gitLabCommandRateLimitMessage(resolveUiLocale()),
    managedCommentKey: buildManagedCommandCommentKey(
      "rate-limit",
      params.command,
    ),
    logger: params.logger,
  });
  return true;
}

function gitLabCommandRateLimitMessage(locale: UiLocale): string {
  return localizeText(
    {
      zh: "`命令触发过于频繁，请稍后再试（默认每用户每 MR 每小时 10 次）。`",
      en: "`Command triggered too frequently. Please retry later (default: 10 times/hour per user per MR).`",
    },
    locale,
  );
}


import { isRateLimited, localizeText, normalizeRateLimitPart, readNumberEnv, resolveUiLocale, type UiLocale } from "#core";
import type { GitLabCommentTarget } from "../../../integrations/gitlab/repository/contracts.js";
import type { LoggerLike } from "../../../integrations/gitlab/webhooks/contracts.js";
import { postGitLabCommandComment } from "../../../review/platforms/gitlab/publication.js";
import { buildManagedCommandCommentKey } from "../../../review/rendering/managed-comments.js";

const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
