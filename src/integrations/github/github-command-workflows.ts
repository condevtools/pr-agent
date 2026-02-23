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
import { getPublicErrorMessage } from "../shared/public-error.js";
import { reviewMessage } from "../shared/review-messages.js";

interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

interface GitHubWorkflowContext {
  repo(): { owner: string; repo: string };
  octokit: {
    pulls: {
      update(params: {
        owner: string;
        repo: string;
        pull_number: number;
        body: string;
      }): Promise<unknown>;
    };
  };
  log: LoggerLike;
}

interface GitHubWorkflowCollectedContext {
  input: PullRequestReviewInput;
  headBranch: string;
}

export interface GitHubDescribeWorkflowParams {
  context: GitHubWorkflowContext;
  pullNumber: number;
  apply?: boolean;
  trigger: string;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

export interface GitHubAskWorkflowParams {
  context: GitHubWorkflowContext;
  pullNumber: number;
  question: string;
  trigger: string;
  managedCommentKey?: string;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  enableConversationContext?: boolean;
  throwOnError?: boolean;
}

export interface GitHubChangelogWorkflowParams {
  context: GitHubWorkflowContext;
  pullNumber: number;
  trigger: string;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}

export interface GitHubCommandWorkflowDeps {
  defaultDedupeTtlMs: number;
  collectPullRequestContext(params: {
    context: GitHubWorkflowContext;
    owner: string;
    repo: string;
    pullNumber: number;
    customRules?: string[];
    includeCiChecks?: boolean;
    feedbackSignals?: string[];
  }): Promise<GitHubWorkflowCollectedContext>;
  postCommandComment(params: {
    context: GitHubWorkflowContext;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    managedCommentKey?: string;
  }): Promise<void>;
  loadFeedbackSignals(owner: string, repo: string, pullNumber: number): string[];
  buildDescribeQuestion(locale: UiLocale): string;
  buildChangelogQuestion(focus: string | undefined, locale: UiLocale): string;
  applyChangelogUpdate(params: {
    context: GitHubWorkflowContext;
    owner: string;
    repo: string;
    branch: string;
    pullNumber: number;
    draft: string;
  }): Promise<{ message: string }>;
  getErrorMessage(error: unknown): string;
}

export function createGitHubCommandWorkflows(deps: GitHubCommandWorkflowDeps): {
  runAsk(params: GitHubAskWorkflowParams): Promise<void>;
  runDescribe(params: GitHubDescribeWorkflowParams): Promise<void>;
  runChangelog(params: GitHubChangelogWorkflowParams): Promise<void>;
} {
  return {
    runDescribe: async (params) => {
      const {
        context,
        pullNumber,
        apply = false,
        trigger,
        dedupeSuffix,
        throwOnError = false,
      } = params;
      const { owner, repo } = context.repo();
      const locale = resolveUiLocale();
      const managedCommentKey = "cmd-describe";
      const requestKey = [
        `github:${owner}/${repo}#${pullNumber}:describe:${trigger}:${apply ? "apply" : "draft"}`,
        dedupeSuffix,
      ]
        .filter(Boolean)
        .join(":");

      if (isDuplicateRequest(requestKey, deps.defaultDedupeTtlMs)) {
        if (trigger === "comment-command" || trigger === "describe-command") {
          await deps.postCommandComment({
            context,
            owner,
            repo,
            issueNumber: pullNumber,
            body: localizeText(
              {
                zh: "`AI Describe` 最近 5 分钟内已经执行过，本次请求已跳过。",
                en: "`AI Describe` already ran in the last 5 minutes, skipped this request.",
              },
              locale,
            ),
            managedCommentKey,
          });
        }
        return;
      }

      try {
        const collected = await deps.collectPullRequestContext({
          context,
          owner,
          repo,
          pullNumber,
        });
        const description = await answerPullRequestQuestion(
          collected.input,
          deps.buildDescribeQuestion(locale),
        );

        if (apply) {
          await context.octokit.pulls.update({
            owner,
            repo,
            pull_number: pullNumber,
            body: description,
          });
          await deps.postCommandComment({
            context,
            owner,
            repo,
            issueNumber: pullNumber,
            body: [
              localizeText(
                {
                  zh: "## AI PR 描述已更新",
                  en: "## AI PR Description Updated",
                },
                locale,
              ),
              "",
              localizeText(
                {
                  zh: "已根据当前 diff 自动生成并写入 PR 描述。",
                  en: "The PR description was generated from the current diff and applied.",
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
          });
          return;
        }

        await deps.postCommandComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: [
            localizeText(
              {
                zh: "## AI 生成 PR 描述草稿",
                en: "## AI PR Description Draft",
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
                zh: "如需自动写入 PR 描述，请使用：`/describe --apply`",
                en: "To apply this draft to the PR description, use: `/describe --apply`",
              },
              locale,
            ),
          ].join("\n"),
          managedCommentKey,
        });
      } catch (error) {
        clearDuplicateRecord(requestKey);
        const reason = deps.getErrorMessage(error);
        context.log.error(
          { owner, repo, pullNumber, trigger, apply, error: reason },
          "GitHub describe failed",
        );

        try {
          await deps.postCommandComment({
            context,
            owner,
            repo,
            issueNumber: pullNumber,
            body: [
              localizeText(
                {
                  zh: "## AI Describe 执行失败",
                  en: "## AI Describe Failed",
                },
                locale,
              ),
              "",
              localizeText(
                {
                  zh: `错误：\`${getPublicErrorMessage(error)}\``,
                  en: `Error: \`${getPublicErrorMessage(error)}\``,
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
          });
        } catch (commentError) {
          context.log.error(
            {
              owner,
              repo,
              pullNumber,
              trigger,
              apply,
              error: deps.getErrorMessage(commentError),
            },
            "Failed to publish GitHub describe failure comment",
          );
        }

        if (throwOnError) {
          throw ensureError(error);
        }
      }
    },
    runAsk: async (params) => {
      const {
        context,
        pullNumber,
        question,
        trigger,
        managedCommentKey,
        dedupeSuffix,
        customRules = [],
        includeCiChecks = true,
        commentTitle = "AI Ask",
        displayQuestion,
        enableConversationContext = false,
        throwOnError = false,
      } = params;
      const { owner, repo } = context.repo();
      const locale = resolveUiLocale();
      const normalizedQuestion = question.trim().replace(/\s+/g, " ").slice(0, 120);
      const requestKey = [
        `github:${owner}/${repo}#${pullNumber}:ask:${trigger}:${normalizedQuestion}`,
        dedupeSuffix,
      ]
        .filter(Boolean)
        .join(":");

      if (isDuplicateRequest(requestKey, deps.defaultDedupeTtlMs)) {
        await deps.postCommandComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: localizeText(
            {
              zh: `\`${commentTitle}\` 最近 5 分钟内已回答过相同问题，本次请求已跳过。`,
              en: `\`${commentTitle}\` already answered the same question in the last 5 minutes, skipped this request.`,
            },
            locale,
          ),
          managedCommentKey,
        });
        return;
      }

      try {
        const feedbackSignals = deps.loadFeedbackSignals(owner, repo, pullNumber);
        const collected = await deps.collectPullRequestContext({
          context,
          owner,
          repo,
          pullNumber,
          customRules,
          includeCiChecks,
          feedbackSignals,
        });
        const sessionKey = `github:${owner}/${repo}#${pullNumber}`;
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
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: [
            `## ${commentTitle}`,
            "",
            `**Q:** ${(displayQuestion ?? question).trim()}`,
            "",
            `**A:** ${answer}`,
          ].join("\n"),
          managedCommentKey,
        });
      } catch (error) {
        clearDuplicateRecord(requestKey);
        context.log.error(
          {
            owner,
            repo,
            pullNumber,
            trigger,
            error: deps.getErrorMessage(error),
          },
          "GitHub ask failed",
        );

        try {
          await deps.postCommandComment({
            context,
            owner,
            repo,
            issueNumber: pullNumber,
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
                  zh: `错误：\`${getPublicErrorMessage(error)}\``,
                  en: `Error: \`${getPublicErrorMessage(error)}\``,
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
          });
        } catch (commentError) {
          context.log.error(
            {
              owner,
              repo,
              pullNumber,
              trigger,
              error: deps.getErrorMessage(commentError),
            },
            "Failed to publish GitHub ask failure comment",
          );
        }

        if (throwOnError) {
          throw ensureError(error);
        }
      }
    },
    runChangelog: async (params) => {
      const {
        context,
        pullNumber,
        trigger,
        focus,
        apply = false,
        dedupeSuffix,
        customRules = [],
        includeCiChecks = true,
        throwOnError = false,
      } = params;
      const { owner, repo } = context.repo();
      const locale = resolveUiLocale();
      const managedCommentKey = "cmd-changelog";
      const requestKey = [
        `github:${owner}/${repo}#${pullNumber}:changelog:${trigger}:${apply ? "apply" : "draft"}`,
        dedupeSuffix,
      ]
        .filter(Boolean)
        .join(":");

      if (isDuplicateRequest(requestKey, deps.defaultDedupeTtlMs)) {
        await deps.postCommandComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: reviewMessage("changelogSkippedRecently", locale),
          managedCommentKey,
        });
        return;
      }

      try {
        const feedbackSignals = deps.loadFeedbackSignals(owner, repo, pullNumber);
        const collected = await deps.collectPullRequestContext({
          context,
          owner,
          repo,
          pullNumber,
          customRules,
          includeCiChecks,
          feedbackSignals,
        });
        const question = deps.buildChangelogQuestion(focus, locale);
        const draft = (await answerPullRequestQuestion(collected.input, question)).trim();

        if (!apply) {
          await deps.postCommandComment({
            context,
            owner,
            repo,
            issueNumber: pullNumber,
            body: [
              "## AI Changelog Draft",
              "",
              draft,
              "",
              reviewMessage("changelogApplyHint", locale),
            ].join("\n"),
            managedCommentKey,
          });
          return;
        }

        const applyResult = await deps.applyChangelogUpdate({
          context,
          owner,
          repo,
          branch: collected.headBranch,
          pullNumber,
          draft,
        });
        await deps.postCommandComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
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
        });
      } catch (error) {
        clearDuplicateRecord(requestKey);
        context.log.error(
          {
            owner,
            repo,
            pullNumber,
            trigger,
            apply,
            error: deps.getErrorMessage(error),
          },
          "GitHub changelog failed",
        );

        try {
          await deps.postCommandComment({
            context,
            owner,
            repo,
            issueNumber: pullNumber,
            body: [
              reviewMessage("changelogFailedTitle", locale),
              "",
              localizeText(
                {
                  zh: `错误：\`${getPublicErrorMessage(error)}\``,
                  en: `Error: \`${getPublicErrorMessage(error)}\``,
                },
                locale,
              ),
            ].join("\n"),
            managedCommentKey,
          });
        } catch (commentError) {
          context.log.error(
            {
              owner,
              repo,
              pullNumber,
              trigger,
              apply,
              error: deps.getErrorMessage(commentError),
            },
            "Failed to publish GitHub changelog failure comment",
          );
        }

        if (throwOnError) {
          throw ensureError(error);
        }
      }
    },
  };
}
