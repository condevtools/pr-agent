import {
  clearDuplicateRecord,
  ensureError,
  isDuplicateRequest,
  loadAskConversationTurns,
  localizeText,
  rememberAskConversationTurn,
  resolveUiLocale,
  type UiLocale,
} from "#core";
import { answerPullRequestQuestion, type PullRequestReviewInput } from "#review";
import { reviewMessage } from "../shared/review-messages.js";

interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitLabWorkflowPayload {
  project: {
    id: number;
  };
  object_attributes: {
    iid: number;
  };
}

export interface GitLabWorkflowCommentTarget {
  baseUrl: string;
  projectId: number;
  mrId: number;
}

export interface GitLabWorkflowCollectedContext extends GitLabWorkflowCommentTarget {
  input: PullRequestReviewInput;
}

export interface GitLabAskWorkflowParams {
  payload: GitLabWorkflowPayload;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  question: string;
  trigger: string;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  managedCommentKey?: string;
  enableConversationContext?: boolean;
  throwOnError?: boolean;
}

export interface GitLabDescribeWorkflowParams {
  payload: GitLabWorkflowPayload;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: string;
  apply?: boolean;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

export interface GitLabChangelogWorkflowParams {
  payload: GitLabWorkflowPayload;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: string;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}

export interface GitLabCommandWorkflowDeps {
  defaultDedupeTtlMs: number;
  requireGitLabToken(headers: Record<string, string | undefined>): string;
  buildCommentTarget(payload: GitLabWorkflowPayload): GitLabWorkflowCommentTarget;
  postCommandComment(params: {
    gitlabToken: string;
    target: GitLabWorkflowCommentTarget;
    body: string;
    managedCommentKey?: string;
    logger?: LoggerLike;
  }): Promise<void>;
  loadFeedbackSignals(projectId: number): string[];
  collectMergeRequestContext(params: {
    payload: GitLabWorkflowPayload;
    gitlabToken: string;
    customRules?: string[];
    includeCiChecks?: boolean;
    feedbackSignals?: string[];
  }): Promise<GitLabWorkflowCollectedContext>;
  buildDescribeQuestion(locale: UiLocale): string;
  buildChangelogQuestion(focus: string | undefined, locale: UiLocale): string;
  updateMergeRequestDescription(params: {
    gitlabToken: string;
    collected: GitLabWorkflowCollectedContext;
    description: string;
  }): Promise<void>;
  applyChangelogUpdate(params: {
    gitlabToken: string;
    collected: GitLabWorkflowCollectedContext;
    pullNumber: number;
    draft: string;
  }): Promise<{ message: string }>;
}

export function createGitLabCommandWorkflows(deps: GitLabCommandWorkflowDeps): {
  runAsk(params: GitLabAskWorkflowParams): Promise<void>;
  runDescribe(params: GitLabDescribeWorkflowParams): Promise<void>;
  runChangelog(params: GitLabChangelogWorkflowParams): Promise<void>;
} {
  return {
    runAsk: async (params) => {
      const {
        payload,
        headers,
        logger,
        question,
        trigger,
        dedupeSuffix,
        customRules = [],
        includeCiChecks = true,
        commentTitle = "AI Ask",
        displayQuestion,
        managedCommentKey,
        enableConversationContext = false,
        throwOnError = false,
      } = params;
      const locale = resolveUiLocale();
      const requestKey = [
        `gitlab:${payload.project.id}#${payload.object_attributes.iid}:ask:${trigger}:${question.trim().replace(/\s+/g, " ").slice(0, 120)}`,
        dedupeSuffix,
      ]
        .filter(Boolean)
        .join(":");

      const gitlabToken = deps.requireGitLabToken(headers);
      const target = deps.buildCommentTarget(payload);
      if (isDuplicateRequest(requestKey, deps.defaultDedupeTtlMs)) {
        await deps.postCommandComment({
          gitlabToken,
          target,
          body: localizeText(
            {
              zh: `\`${commentTitle}\` 最近 5 分钟内已执行过同类请求，本次已跳过。`,
              en: `\`${commentTitle}\` already handled a similar request in the last 5 minutes, skipped this request.`,
            },
            locale,
          ),
          managedCommentKey,
          logger,
        });
        return;
      }

      try {
        const feedbackSignals = deps.loadFeedbackSignals(payload.project.id);
        const collected = await deps.collectMergeRequestContext({
          payload,
          gitlabToken,
          customRules,
          includeCiChecks,
          feedbackSignals,
        });
        const sessionKey = `gitlab:${payload.project.id}#${payload.object_attributes.iid}`;
        const conversation = enableConversationContext
          ? loadAskConversationTurns(sessionKey)
          : [];
        const answer = await answerPullRequestQuestion(collected.input, question, {
          conversation,
        });
        if (enableConversationContext) {
          rememberAskConversationTurn({
            sessionKey,
            question: (displayQuestion ?? question).trim(),
            answer,
          });
        }
        await deps.postCommandComment({
          gitlabToken,
          target: collected,
          body: [
            `## ${commentTitle}`,
            "",
            `**Q:** ${(displayQuestion ?? question).trim()}`,
            "",
            `**A:** ${answer}`,
          ].join("\n"),
          managedCommentKey,
          logger,
        });
      } catch (error) {
        clearDuplicateRecord(requestKey);
        logger.error(
          {
            projectId: payload.project.id,
            mrId: payload.object_attributes.iid,
            trigger,
            error: error instanceof Error ? error.message : String(error),
          },
          "GitLab ask failed",
        );
        try {
          await deps.postCommandComment({
            gitlabToken,
            target,
            body: [
              localizeText(
                {
                  zh: `## ${commentTitle} 执行失败`,
                  en: `## ${commentTitle} Failed`,
                },
                locale,
              ),
              "",
              localizeText(
                {
                  zh: `错误：\`${error instanceof Error ? error.message : String(error)}\``,
                  en: `Error: \`${error instanceof Error ? error.message : String(error)}\``,
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
            logger,
          });
        } catch (commentError) {
          logger.error(
            {
              projectId: payload.project.id,
              mrId: payload.object_attributes.iid,
              trigger,
              error:
                commentError instanceof Error
                  ? commentError.message
                  : String(commentError),
            },
            "Failed to publish GitLab ask failure comment",
          );
        }
        if (throwOnError) {
          throw ensureError(error);
        }
      }
    },
    runDescribe: async (params) => {
      const {
        payload,
        headers,
        logger,
        trigger,
        apply = false,
        dedupeSuffix,
        throwOnError = false,
      } = params;
      const managedCommentKey = "cmd-describe";
      const locale = resolveUiLocale();
      const requestKey = [
        `gitlab:${payload.project.id}#${payload.object_attributes.iid}:describe:${trigger}:${apply ? "apply" : "draft"}`,
        dedupeSuffix,
      ]
        .filter(Boolean)
        .join(":");

      const gitlabToken = deps.requireGitLabToken(headers);
      const target = deps.buildCommentTarget(payload);
      if (isDuplicateRequest(requestKey, deps.defaultDedupeTtlMs)) {
        await deps.postCommandComment({
          gitlabToken,
          target,
          body: localizeText(
            {
              zh: "`AI MR 描述` 最近 5 分钟内已执行过同类请求，本次已跳过。",
              en: "`AI MR Description` already handled a similar request in the last 5 minutes, skipped this request.",
            },
            locale,
          ),
          managedCommentKey,
          logger,
        });
        return;
      }

      try {
        const collected = await deps.collectMergeRequestContext({
          payload,
          gitlabToken,
        });
        const description = await answerPullRequestQuestion(
          collected.input,
          deps.buildDescribeQuestion(locale),
        );

        if (apply) {
          await deps.updateMergeRequestDescription({
            gitlabToken,
            collected,
            description,
          });
          await deps.postCommandComment({
            gitlabToken,
            target: collected,
            body: [
              localizeText(
                {
                  zh: "## AI MR 描述已更新",
                  en: "## AI MR Description Updated",
                },
                locale,
              ),
              "",
              localizeText(
                {
                  zh: "已根据当前 diff 自动生成并写入 MR 描述。",
                  en: "The MR description was generated from the current diff and applied.",
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
            logger,
          });
          return;
        }

        await deps.postCommandComment({
          gitlabToken,
          target: collected,
          body: [
            localizeText(
              {
                zh: "## AI 生成 MR 描述草稿",
                en: "## AI MR Description Draft",
              },
              locale,
            ),
            "",
            "```markdown",
            description,
            "```",
            "",
            localizeText(
              {
                zh: "如需自动写入 MR 描述，请使用：`/describe --apply`",
                en: "To apply this draft to the MR description, use: `/describe --apply`",
              },
              locale,
            ),
          ].join("\n"),
          managedCommentKey,
          logger,
        });
      } catch (error) {
        clearDuplicateRecord(requestKey);
        logger.error(
          {
            projectId: payload.project.id,
            mrId: payload.object_attributes.iid,
            trigger,
            apply,
            error: error instanceof Error ? error.message : String(error),
          },
          "GitLab describe failed",
        );
        try {
          await deps.postCommandComment({
            gitlabToken,
            target,
            body: [
              localizeText(
                {
                  zh: "## AI MR 描述执行失败",
                  en: "## AI MR Description Failed",
                },
                locale,
              ),
              "",
              localizeText(
                {
                  zh: `错误：\`${error instanceof Error ? error.message : String(error)}\``,
                  en: `Error: \`${error instanceof Error ? error.message : String(error)}\``,
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
            logger,
          });
        } catch (commentError) {
          logger.error(
            {
              projectId: payload.project.id,
              mrId: payload.object_attributes.iid,
              trigger,
              apply,
              error:
                commentError instanceof Error
                  ? commentError.message
                  : String(commentError),
            },
            "Failed to publish GitLab describe failure comment",
          );
        }
        if (throwOnError) {
          throw ensureError(error);
        }
      }
    },
    runChangelog: async (params) => {
      const {
        payload,
        headers,
        logger,
        trigger,
        focus,
        apply = false,
        dedupeSuffix,
        customRules = [],
        includeCiChecks = true,
        throwOnError = false,
      } = params;
      const managedCommentKey = "cmd-changelog";
      const locale = resolveUiLocale();
      const requestKey = [
        `gitlab:${payload.project.id}#${payload.object_attributes.iid}:changelog:${trigger}:${apply ? "apply" : "draft"}`,
        dedupeSuffix,
      ]
        .filter(Boolean)
        .join(":");

      const gitlabToken = deps.requireGitLabToken(headers);
      const target = deps.buildCommentTarget(payload);
      if (isDuplicateRequest(requestKey, deps.defaultDedupeTtlMs)) {
        await deps.postCommandComment({
          gitlabToken,
          target,
          body: reviewMessage("changelogSkippedRecently", locale),
          managedCommentKey,
          logger,
        });
        return;
      }

      try {
        const feedbackSignals = deps.loadFeedbackSignals(payload.project.id);
        const collected = await deps.collectMergeRequestContext({
          payload,
          gitlabToken,
          customRules,
          includeCiChecks,
          feedbackSignals,
        });
        const draft = (
          await answerPullRequestQuestion(
            collected.input,
            deps.buildChangelogQuestion(focus, locale),
          )
        ).trim();

        if (!apply) {
          await deps.postCommandComment({
            gitlabToken,
            target: collected,
            body: [
              "## AI Changelog Draft",
              "",
              draft,
              "",
              reviewMessage("changelogApplyHint", locale),
            ].join("\n"),
            managedCommentKey,
            logger,
          });
          return;
        }

        const applyResult = await deps.applyChangelogUpdate({
          gitlabToken,
          collected,
          pullNumber: collected.mrId,
          draft,
        });
        await deps.postCommandComment({
          gitlabToken,
          target: collected,
          body: [
            reviewMessage("changelogUpdatedTitle", locale),
            "",
            applyResult.message,
            "",
            "```markdown",
            draft,
            "```",
          ].join("\n"),
          managedCommentKey,
          logger,
        });
      } catch (error) {
        clearDuplicateRecord(requestKey);
        logger.error(
          {
            projectId: payload.project.id,
            mrId: payload.object_attributes.iid,
            trigger,
            apply,
            error: error instanceof Error ? error.message : String(error),
          },
          "GitLab changelog failed",
        );
        try {
          await deps.postCommandComment({
            gitlabToken,
            target,
            body: [
              reviewMessage("changelogFailedTitle", locale),
              "",
              localizeText(
                {
                  zh: `错误：\`${error instanceof Error ? error.message : String(error)}\``,
                  en: `Error: \`${error instanceof Error ? error.message : String(error)}\``,
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
            logger,
          });
        } catch (commentError) {
          logger.error(
            {
              projectId: payload.project.id,
              mrId: payload.object_attributes.iid,
              trigger,
              apply,
              error:
                commentError instanceof Error
                  ? commentError.message
                  : String(commentError),
            },
            "Failed to publish GitLab changelog failure comment",
          );
        }
        if (throwOnError) {
          throw ensureError(error);
        }
      }
    },
  };
}
