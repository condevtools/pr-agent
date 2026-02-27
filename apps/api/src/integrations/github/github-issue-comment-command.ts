import {
  isRateLimited,
  isRateLimitedAsync,
  localizeText,
  normalizeRateLimitPart,
  readNumberEnv,
  readOptionalStringEnv,
  resolveUiLocale,
  type UiLocale,
} from "@mr-agent/core";
import {
  buildManagedCommandCommentKey,
  recordGitHubFeedbackSignalAsync,
  runGitHubAsk,
  runGitHubChangelog,
  runGitHubDescribe,
  runGitHubReview,
  type GitHubReviewContext,
} from "./github-review.js";
import { resolveGitHubReviewBehaviorPolicy } from "./github-policy.js";
import { runGitHubImplementCommand } from "./github-implement.js";
import {
  findSimilarIssues,
  parseAddDocCommand,
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseConfigCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parseHelpCommand,
  parseImproveCommand,
  parseImplementCommand,
  parseMentionCommand,
  parseReflectCommand,
  parseReviewCommand,
  parseSimilarIssueCommand,
  parseCustomPromptCommand,
  parseHelpDocsCommand,
  parseAnalyzeCommand,
  parseComplianceCommand,
  parseImproveComponentCommand,
  parseGenerateLabelsCommand,
  parseSimilarCodeCommand,
  parseAutoApproveCommand,
  parseScanRepoDiscussionsCommand,
} from "@mr-agent/review";
import {
  buildAddDocRule,
  buildChecksQuestion,
  buildGenerateTestsQuestion,
  buildImproveRule,
  buildReflectQuestion,
  buildAnalyzeQuestion,
  buildComplianceQuestion,
  buildImproveComponentRule,
  buildSimilarCodeQuestion,
  buildAutoApproveQuestion,
  buildScanRepoDiscussionsQuestion,
  buildHelpDocsQuestion,
} from "@mr-agent/shared/command-builders.js";
import {
  dispatchCommandRegistrations,
  type CommandDispatchResult,
  type CommandRegistration,
} from "@mr-agent/shared/command-dispatch.js";
import {
  buildCommandApplyDisabledByPolicyMessage,
  buildCommandDisabledByPolicyMessage,
  buildFeedbackSignalRecordedMessage,
  buildReflectDependsOnAskMessage,
} from "@mr-agent/shared/command-messages.js";
import { buildHelpMessage } from "@mr-agent/shared/command-help.js";
import {
  buildConfigFoundMessage,
  buildConfigNotFoundMessage,
} from "@mr-agent/shared/command-config.js";
import {
  loadRepositoryPolicyConfig,
  hasRepositoryPolicyConfigFile,
  tryLoadRepositoryContent,
  tryLoadRepositoryTextFile,
} from "./github-policy-config.js";
import {
  buildSimilarIssueComment,
  buildSimilarIssueQueryMissingMessage,
  resolveSimilarIssueQuery,
} from "@mr-agent/shared/similar-issue.js";
import { inferReviewLabels } from "@mr-agent/shared/auto-labels.js";

// ---------------------------------------------------------------------------
// TODO(refactor): Decompose this 1700+ line file into focused modules
//
// Suggested extraction plan:
//   1. github-command-dispatch.ts – command registration, rate-limiting, routing (~400 lines)
//   2. github-command-review.ts   – /review, /improve, /reflect handlers (~350 lines)
//   3. github-command-query.ts    – /ask, /describe, /similar-issue, /help handlers (~300 lines)
//   4. github-command-ops.ts      – /checks, /changelog, /config, /labels handlers (~250 lines)
//   5. github-command-advanced.ts – /analyze, /compliance, /scan-discussions (~250 lines)
//
// Prerequisites:
//   - Add integration tests covering at least the top-5 most-used commands
//   - Verify command dispatch routing is covered by unit tests
//   - Ensure shared state (rate-limit keys, policy cache) is passed explicitly
// ---------------------------------------------------------------------------

const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;

const DISPLAY_QUESTION_MAX_LENGTH = 80;
const SCAN_DISCUSSIONS_MAX_PRS = 10;
const SCAN_DISCUSSIONS_FETCH_PER_PAGE = 20;
const SCAN_DISCUSSIONS_MAX_COMMENTS_PER_PR = 10;
const SCAN_DISCUSSIONS_COMMENT_PREVIEW_LENGTH = 200;

export async function handleGitHubIssueCommentCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  commentUser?:
    | {
        type?: string;
        login?: string;
      }
    | null;
  isPullRequest?: boolean;
  /** Issue title from webhook payload — provides AI context for Issue comments. */
  issueTitle?: string;
  /** Issue body from webhook payload — provides AI context for Issue comments. */
  issueBody?: string;
  rateLimitPlatform: "github-app" | "github-webhook";
  throwOnError?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  if (isGitHubBotCommentUser(params.commentUser)) {
    return { ok: true, message: "ignored issue_comment from bot" };
  }

  const body = params.body.trim();
  const locale = resolveUiLocale();
  const commentUserLogin = params.commentUser?.login;
  const throwOnError = Boolean(params.throwOnError);
  const isPullRequest = params.isPullRequest ?? true;
  const appSlug = readOptionalStringEnv("GITHUB_APP_SLUG");
  const configuredBotLogin = readOptionalStringEnv("GITHUB_BOT_LOGIN");
  const botLogin = configuredBotLogin ?? (appSlug ? `${appSlug}[bot]` : "");

  // --- Collaborator permission check for high-impact commands ---
  const HIGH_IMPACT_COMMANDS = [
    "/implement",
    "/auto_approve",
    "/auto-approve",
    "/improve",
    "/fix",
  ];
  const isHighImpact = HIGH_IMPACT_COMMANDS.some((cmd) =>
    body.toLowerCase().startsWith(cmd),
  );

  if (isHighImpact && commentUserLogin) {
    const octokit = params.context.octokit;
    if (octokit.repos.getCollaboratorPermissionLevel) {
      try {
        const { data } =
          await octokit.repos.getCollaboratorPermissionLevel({
            owner: params.owner,
            repo: params.repo,
            username: commentUserLogin,
          });
        if (data.permission !== "admin" && data.permission !== "write") {
          await octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: localizeText(
              {
                zh: `@${commentUserLogin} 此命令需要仓库的 write 以上权限。`,
                en: `@${commentUserLogin} This command requires write access to the repository.`,
              },
              locale,
            ),
          });
          return {
            ok: true,
            message: `command rejected: user ${commentUserLogin} has ${data.permission} access, write required`,
          };
        }
      } catch {
        // If permission check fails (e.g. API not available), fall through
        // and let rate-limiting be the safety net.
      }
    }
  }
  let reviewBehaviorPromise:
    | Promise<Awaited<ReturnType<typeof resolveGitHubReviewBehaviorPolicy>>>
    | undefined;

  const getReviewBehavior = async () => {
    if (!reviewBehaviorPromise) {
      reviewBehaviorPromise = resolveGitHubReviewBehaviorPolicy({
        context: params.context,
      });
    }
    return reviewBehaviorPromise;
  };

  const hitRateLimit = async (command: string): Promise<boolean> => {
    if (
      !(await shouldRejectGitHubCommandByRateLimit({
        context: params.context,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.issueNumber,
        userLogin: commentUserLogin,
        command,
        platform: params.rateLimitPlatform,
      }))
    ) {
      return false;
    }
    return true;
  };

  const registerCommand = <TParsed>(
    name: string,
    parse: () => TParsed | undefined,
    execute: (parsed: TParsed) => Promise<CommandDispatchResult>,
  ): CommandRegistration<unknown> => ({
    name,
    parse: parse as () => unknown | undefined,
    execute: execute as (parsed: unknown) => Promise<CommandDispatchResult>,
  });

  // For PR-only commands, wrap the parse function to also check isPullRequest
  const registerPrCommand = <TParsed>(
    name: string,
    parse: () => TParsed | undefined,
    execute: (parsed: TParsed) => Promise<CommandDispatchResult>,
  ): CommandRegistration<unknown> => ({
    name,
    parse: () => {
      if (!isPullRequest) {
        return undefined;
      }
      return parse() as unknown | undefined;
    },
    execute: execute as (parsed: unknown) => Promise<CommandDispatchResult>,
  });

  // Shared ask execution logic — used by both /ask command and @mention handler
  const executeAskLikeCommand = async (
    question: string,
    trigger: "comment-command" | "mention-command",
  ): Promise<CommandDispatchResult> => {
    if (await hitRateLimit("ask")) {
      return { ok: true, message: `${trigger === "mention-command" ? "mention-" : ""}ask command rate limited` };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.askCommandEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: buildCommandDisabledByPolicyMessage({
          command: "ask",
          policyPath: ".mr-agent.yml -> review.askCommandEnabled=false",
          locale,
        }),
      });
      return { ok: true, message: `${trigger === "mention-command" ? "mention-" : ""}ask command ignored by policy` };
    }
    await runGitHubAsk({
      context: params.context,
      pullNumber: params.issueNumber,
      question,
      managedCommentKey: buildManagedCommandCommentKey("ask", question),
      trigger,
      customRules: reviewBehavior.customRules,
      includeCiChecks: isPullRequest ? reviewBehavior.includeCiChecks : false,
      enableConversationContext: true,
      isPullRequest,
      issueTitle: params.issueTitle,
      issueBody: params.issueBody,
      throwOnError,
    });
    return { ok: true, message: `${trigger === "mention-command" ? "mention-" : ""}ask command triggered` };
  };

  const commandRegistry: CommandRegistration<unknown>[] = [
    registerCommand(
      "help",
      () => {
        const parsed = parseHelpCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("help")) {
          return { ok: true, message: "help command rate limited" };
        }
        await params.context.octokit.issues.createComment({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          body: buildHelpMessage({ target: "PR", locale, includeImplement: true }),
        });
        return { ok: true, message: "help command triggered" };
      },
    ),
    registerCommand(
      "config",
      () => {
        const parsed = parseConfigCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("config")) {
          return { ok: true, message: "config command rate limited" };
        }
        const [config, hasFile] = await Promise.all([
          loadRepositoryPolicyConfig({
            context: params.context,
            owner: params.owner,
            repo: params.repo,
          }),
          hasRepositoryPolicyConfigFile({
            context: params.context,
            owner: params.owner,
            repo: params.repo,
          }),
        ]);
        await params.context.octokit.issues.createComment({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          body: hasFile
            ? buildConfigFoundMessage({ config, locale })
            : buildConfigNotFoundMessage(locale),
        });
        return { ok: true, message: "config command triggered" };
      },
    ),
    registerCommand(
      "feedback",
      () => {
        const parsed = parseFeedbackCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (feedbackCommand) => {
        if (await hitRateLimit("feedback")) {
          return { ok: true, message: "feedback command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.feedbackCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "feedback",
              policyPath: ".mr-agent.yml -> review.feedbackCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "feedback command ignored by policy" };
        }

        const positive =
          feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
        const signalCore = positive
          ? "developer prefers high-confidence, actionable suggestions"
          : "developer prefers fewer low-value/noisy suggestions";
        const noteText = feedbackCommand.note ? `; note: ${feedbackCommand.note}` : "";
        await recordGitHubFeedbackSignalAsync({
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.issueNumber,
          signal: `PR #${params.issueNumber} ${feedbackCommand.action}: ${signalCore}${noteText}`,
        });
        await params.context.octokit.issues.createComment({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          body: buildFeedbackSignalRecordedMessage({
            action: feedbackCommand.action,
            locale,
          }),
        });
        return { ok: true, message: "feedback command recorded" };
      },
    ),
    registerPrCommand(
      "describe",
      () => {
        const parsed = parseDescribeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (describe) => {
        if (await hitRateLimit("describe")) {
          return { ok: true, message: "describe command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.describeEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "describe",
              policyPath: ".mr-agent.yml -> review.describeEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "describe command ignored by policy" };
        }
        if (describe.apply && !reviewBehavior.describeAllowApply) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandApplyDisabledByPolicyMessage({
              command: "describe",
              policyPath: ".mr-agent.yml -> review.describeAllowApply=false",
              locale,
            }),
          });
          return { ok: true, message: "describe apply ignored by policy" };
        }

        await runGitHubDescribe({
          context: params.context,
          pullNumber: params.issueNumber,
          apply: describe.apply && reviewBehavior.describeAllowApply,
          trigger: "describe-command",
          throwOnError,
        });
        return { ok: true, message: "describe command triggered" };
      },
    ),
    registerCommand(
      "ask",
      () => {
        const parsed = parseAskCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (ask) => executeAskLikeCommand(ask.question, "comment-command"),
    ),
    registerPrCommand(
      "checks",
      () => {
        const parsed = parseChecksCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (checksCommand) => {
        if (await hitRateLimit("checks")) {
          return { ok: true, message: "checks command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.checksCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "checks",
              policyPath: ".mr-agent.yml -> review.checksCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "checks command ignored by policy" };
        }

        const checksQuestion = buildChecksQuestion("PR", checksCommand.question, locale);
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: checksQuestion,
          managedCommentKey: buildManagedCommandCommentKey("checks", checksQuestion),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: true,
          throwOnError,
        });
        return { ok: true, message: "checks command triggered" };
      },
    ),
    registerPrCommand(
      "generate-tests",
      () => {
        const parsed = parseGenerateTestsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (generateTests) => {
        if (await hitRateLimit("generate-tests")) {
          return { ok: true, message: "generate_tests command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.generateTestsCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "generate_tests",
              policyPath: ".mr-agent.yml -> review.generateTestsCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "generate_tests command ignored by policy" };
        }
        const generateTestsQuestion = buildGenerateTestsQuestion(
          "PR",
          generateTests.focus,
          locale,
        );
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: generateTestsQuestion,
          managedCommentKey: buildManagedCommandCommentKey(
            "generate-tests",
            generateTestsQuestion,
          ),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          commentTitle: "AI Test Generator",
          displayQuestion: generateTests.focus
            ? `/generate_tests ${generateTests.focus}`
            : "/generate_tests",
          throwOnError,
        });
        return { ok: true, message: "generate_tests command triggered" };
      },
    ),
    registerPrCommand(
      "changelog",
      () => {
        const parsed = parseChangelogCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (changelogCommand) => {
        if (await hitRateLimit("changelog")) {
          return { ok: true, message: "changelog command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.changelogCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "changelog",
              policyPath: ".mr-agent.yml -> review.changelogCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "changelog command ignored by policy" };
        }
        if (changelogCommand.apply && !reviewBehavior.changelogAllowApply) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandApplyDisabledByPolicyMessage({
              command: "changelog",
              policyPath: ".mr-agent.yml -> review.changelogAllowApply=false",
              locale,
            }),
          });
          return { ok: true, message: "changelog apply ignored by policy" };
        }
        await runGitHubChangelog({
          context: params.context,
          pullNumber: params.issueNumber,
          trigger: "comment-command",
          focus: changelogCommand.focus,
          apply: changelogCommand.apply && reviewBehavior.changelogAllowApply,
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          throwOnError,
        });
        return { ok: true, message: "changelog command triggered" };
      },
    ),
    registerPrCommand(
      "improve",
      () => {
        const parsed = parseImproveCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (improveCommand) => {
        if (await hitRateLimit("improve")) {
          return { ok: true, message: "improve command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.improveCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "improve",
              policyPath: ".mr-agent.yml -> review.improveCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "improve command ignored by policy" };
        }
        await runGitHubReview({
          context: params.context,
          pullNumber: params.issueNumber,
          mode: "comment",
          trigger: "comment-command",
          customRules: [
            ...reviewBehavior.customRules,
            buildImproveRule(improveCommand.focus),
          ],
          includeCiChecks: reviewBehavior.includeCiChecks,
          enableSecretScan: reviewBehavior.secretScanEnabled,
          secretScanCustomPatterns: reviewBehavior.secretScanCustomPatterns,
          enableAutoLabel: false,
          throwOnError,
        });
        return { ok: true, message: "improve command triggered" };
      },
    ),
    registerPrCommand(
      "add-doc",
      () => {
        const parsed = parseAddDocCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (addDocCommand) => {
        if (await hitRateLimit("add-doc")) {
          return { ok: true, message: "add_doc command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.addDocCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "add_doc",
              policyPath: ".mr-agent.yml -> review.addDocCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "add_doc command ignored by policy" };
        }
        await runGitHubReview({
          context: params.context,
          pullNumber: params.issueNumber,
          mode: "comment",
          trigger: "comment-command",
          customRules: [
            ...reviewBehavior.customRules,
            buildAddDocRule(addDocCommand.focus),
          ],
          includeCiChecks: reviewBehavior.includeCiChecks,
          enableSecretScan: false,
          enableAutoLabel: false,
          throwOnError,
        });
        return { ok: true, message: "add_doc command triggered" };
      },
    ),
    registerPrCommand(
      "reflect",
      () => {
        const parsed = parseReflectCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (reflectCommand) => {
        if (await hitRateLimit("reflect")) {
          return { ok: true, message: "reflect command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.askCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildReflectDependsOnAskMessage({
              askPolicyPath: ".mr-agent.yml -> review.askCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "reflect command ignored by policy" };
        }

        const reflectQuestion = buildGitHubReflectQuestion(reflectCommand.request, locale);
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: reflectQuestion,
          managedCommentKey: buildManagedCommandCommentKey("reflect", reflectQuestion),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          commentTitle: "AI Reflect",
          displayQuestion: reflectCommand.request
            ? `/reflect ${reflectCommand.request}`
            : "/reflect",
          throwOnError,
        });
        return { ok: true, message: "reflect command triggered" };
      },
    ),
    registerCommand(
      "similar-issue",
      () => {
        const parsed = parseSimilarIssueCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (similarIssueCommand) => {
        if (await hitRateLimit("similar-issue")) {
          return { ok: true, message: "similar_issue command rate limited" };
        }

        await runGitHubSimilarIssueCommand({
          context: params.context,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.issueNumber,
          query: similarIssueCommand.query,
          locale,
        });
        return { ok: true, message: "similar_issue command triggered" };
      },
    ),
    registerPrCommand(
      "implement",
      () => {
        const parsed = parseImplementCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("implement")) {
          return { ok: true, message: "implement command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.implementCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "implement",
              policyPath: ".mr-agent.yml -> review.implementCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "implement command ignored by policy" };
        }
        await runGitHubImplementCommand({
          context: params.context,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.issueNumber,
          locale,
          botLogin,
          throwOnError,
        });
        return { ok: true, message: "implement command triggered" };
      },
    ),
    // --- Wave 1: AI Q&A commands ---
    registerPrCommand(
      "custom-prompt",
      () => {
        const parsed = parseCustomPromptCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        if (await hitRateLimit("custom-prompt")) {
          return { ok: true, message: "custom_prompt command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.customPromptCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "custom_prompt",
              policyPath: ".mr-agent.yml -> review.customPromptCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "custom_prompt command ignored by policy" };
        }
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: cmd.prompt,
          managedCommentKey: buildManagedCommandCommentKey("custom-prompt", cmd.prompt),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          commentTitle: "AI Custom Prompt",
          displayQuestion: `/custom_prompt ${cmd.prompt.length > DISPLAY_QUESTION_MAX_LENGTH ? cmd.prompt.slice(0, DISPLAY_QUESTION_MAX_LENGTH) + "…" : cmd.prompt}`,
          throwOnError,
        });
        return { ok: true, message: "custom_prompt command triggered" };
      },
    ),
    registerCommand(
      "help-docs",
      () => {
        const parsed = parseHelpDocsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        if (await hitRateLimit("help-docs")) {
          return { ok: true, message: "help_docs command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.helpDocsCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "help_docs",
              policyPath: ".mr-agent.yml -> review.helpDocsCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "help_docs command ignored by policy" };
        }
        const docsContent = await loadGitHubDocsContent({
          context: params.context,
          owner: params.owner,
          repo: params.repo,
        });
        const helpDocsQuestion = buildHelpDocsQuestion(
          "PR",
          cmd.question,
          docsContent,
          locale,
        );
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: helpDocsQuestion,
          managedCommentKey: buildManagedCommandCommentKey("help-docs", cmd.question),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: false,
          commentTitle: "AI Help Docs",
          displayQuestion: `/help_docs ${cmd.question}`,
          isPullRequest,
          issueTitle: params.issueTitle,
          issueBody: params.issueBody,
          throwOnError,
        });
        return { ok: true, message: "help_docs command triggered" };
      },
    ),
    registerPrCommand(
      "analyze",
      () => {
        const parsed = parseAnalyzeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("analyze")) {
          return { ok: true, message: "analyze command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.analyzeCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "analyze",
              policyPath: ".mr-agent.yml -> review.analyzeCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "analyze command ignored by policy" };
        }
        const analyzeQuestion = buildAnalyzeQuestion("PR", locale);
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: analyzeQuestion,
          managedCommentKey: buildManagedCommandCommentKey("analyze", analyzeQuestion),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          commentTitle: "AI Analyze",
          displayQuestion: "/analyze",
          throwOnError,
        });
        return { ok: true, message: "analyze command triggered" };
      },
    ),
    registerPrCommand(
      "compliance",
      () => {
        const parsed = parseComplianceCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        if (await hitRateLimit("compliance")) {
          return { ok: true, message: "compliance command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.complianceCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "compliance",
              policyPath: ".mr-agent.yml -> review.complianceCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "compliance command ignored by policy" };
        }
        const complianceQuestion = buildComplianceQuestion("PR", cmd.focus, locale);
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: complianceQuestion,
          managedCommentKey: buildManagedCommandCommentKey("compliance", complianceQuestion),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          commentTitle: "AI Compliance",
          displayQuestion: cmd.focus ? `/compliance ${cmd.focus}` : "/compliance",
          throwOnError,
        });
        return { ok: true, message: "compliance command triggered" };
      },
    ),
    // --- Wave 2: AI Review + Tool commands ---
    registerPrCommand(
      "improve-component",
      () => {
        const parsed = parseImproveComponentCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        if (await hitRateLimit("improve-component")) {
          return { ok: true, message: "improve_component command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.improveCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "improve_component",
              policyPath: ".mr-agent.yml -> review.improveCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "improve_component command ignored by policy" };
        }
        await runGitHubReview({
          context: params.context,
          pullNumber: params.issueNumber,
          mode: "comment",
          trigger: "comment-command",
          customRules: [
            ...reviewBehavior.customRules,
            buildImproveComponentRule(cmd.component),
          ],
          includeCiChecks: reviewBehavior.includeCiChecks,
          enableSecretScan: reviewBehavior.secretScanEnabled,
          secretScanCustomPatterns: reviewBehavior.secretScanCustomPatterns,
          enableAutoLabel: false,
          throwOnError,
        });
        return { ok: true, message: "improve_component command triggered" };
      },
    ),
    registerPrCommand(
      "generate-labels",
      () => {
        const parsed = parseGenerateLabelsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("generate-labels")) {
          return { ok: true, message: "generate_labels command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.autoLabelEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "generate_labels",
              policyPath: ".mr-agent.yml -> review.autoLabelEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "generate_labels command ignored by policy" };
        }
        await runGitHubGenerateLabelsCommand({
          context: params.context,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.issueNumber,
          locale,
          throwOnError,
        });
        return { ok: true, message: "generate_labels command triggered" };
      },
    ),
    // --- Wave 3: Independent backend commands ---
    registerPrCommand(
      "similar-code",
      () => {
        const parsed = parseSimilarCodeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        if (await hitRateLimit("similar-code")) {
          return { ok: true, message: "similar_code command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.similarCodeCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "similar_code",
              policyPath: ".mr-agent.yml -> review.similarCodeCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "similar_code command ignored by policy" };
        }
        const similarCodeQuestion = buildSimilarCodeQuestion("PR", cmd.query, locale);
        await runGitHubAsk({
          context: params.context,
          pullNumber: params.issueNumber,
          question: similarCodeQuestion,
          managedCommentKey: buildManagedCommandCommentKey("similar-code", similarCodeQuestion),
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: false,
          commentTitle: "AI Similar Code",
          displayQuestion: cmd.query ? `/similar_code ${cmd.query}` : "/similar_code",
          throwOnError,
        });
        return { ok: true, message: "similar_code command triggered" };
      },
    ),
    registerPrCommand(
      "auto-approve",
      () => {
        const parsed = parseAutoApproveCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("auto-approve")) {
          return { ok: true, message: "auto_approve command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.autoApproveCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "auto_approve",
              policyPath: ".mr-agent.yml -> review.autoApproveCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "auto_approve command ignored by policy" };
        }
        await runGitHubAutoApproveCommand({
          context: params.context,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.issueNumber,
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          locale,
          throwOnError,
        });
        return { ok: true, message: "auto_approve command triggered" };
      },
    ),
    registerPrCommand(
      "scan-repo-discussions",
      () => {
        const parsed = parseScanRepoDiscussionsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        if (await hitRateLimit("scan-repo-discussions")) {
          return { ok: true, message: "scan_repo_discussions command rate limited" };
        }
        const reviewBehavior = await getReviewBehavior();
        if (!reviewBehavior.scanRepoDiscussionsCommandEnabled) {
          await params.context.octokit.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: buildCommandDisabledByPolicyMessage({
              command: "scan_repo_discussions",
              policyPath: ".mr-agent.yml -> review.scanRepoDiscussionsCommandEnabled=false",
              locale,
            }),
          });
          return { ok: true, message: "scan_repo_discussions command ignored by policy" };
        }
        await runGitHubScanRepoDiscussionsCommand({
          context: params.context,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.issueNumber,
          customRules: reviewBehavior.customRules,
          locale,
          throwOnError,
        });
        return { ok: true, message: "scan_repo_discussions command triggered" };
      },
    ),
    registerPrCommand(
      "ai-review",
      () => {
        const parsed = parseReviewCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (command) => {
        if (await hitRateLimit("ai-review")) {
          return { ok: true, message: "issue_comment review rate limited" };
        }

        const reviewBehavior = await getReviewBehavior();

        await runGitHubReview({
          context: params.context,
          pullNumber: params.issueNumber,
          mode: command.mode,
          trigger: "comment-command",
          customRules: reviewBehavior.customRules,
          includeCiChecks: reviewBehavior.includeCiChecks,
          enableSecretScan: reviewBehavior.secretScanEnabled,
          secretScanCustomPatterns: reviewBehavior.secretScanCustomPatterns,
          enableAutoLabel: reviewBehavior.autoLabelEnabled,
          throwOnError,
        });

        return { ok: true, message: "issue_comment review triggered" };
      },
    ),
    // @mention handler — treat "@bot-name <question>" as "/ask <question>"
    registerCommand(
      "mention",
      () => {
        const parsed = parseMentionCommand(body, botLogin);
        return parsed.matched ? parsed : undefined;
      },
      async (mention) => executeAskLikeCommand(mention.question, "mention-command"),
    ),
  ];

  return dispatchCommandRegistrations(commandRegistry, {
    ok: true,
    message: "ignored issue_comment content",
  });
}

function buildGitHubReflectQuestion(
  request: string,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildReflectQuestion("PR", request, locale);
}

async function runGitHubSimilarIssueCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  query: string;
  locale: UiLocale;
}): Promise<void> {
  if (!params.context.octokit.issues.listForRepo) {
    await params.context.octokit.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: localizeText(
        {
          zh: "当前 GitHub 客户端不支持 `/similar_issue`（缺少 issues.listForRepo）。",
          en: "Current GitHub client does not support `/similar_issue` (missing issues.listForRepo).",
        },
        params.locale,
      ),
    });
    return;
  }

  const query = await resolveGitHubSimilarIssueQuery(params);
  if (!query) {
    await params.context.octokit.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: buildSimilarIssueQueryMissingMessage(params.locale),
    });
    return;
  }

  const issues = await params.context.octokit.issues.listForRepo({
    owner: params.owner,
    repo: params.repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
    page: 1,
  });
  const candidates = issues.data
    .filter((issue) => !issue.pull_request)
    .filter((issue) => Number(issue.number) !== params.pullNumber)
    .map((issue) => ({
      id: issue.number,
      title: issue.title ?? "",
      body: issue.body ?? "",
      url: issue.html_url ?? "",
      state: issue.state,
    }))
    .filter((issue) => Boolean(issue.url && issue.title));

  const matches = findSimilarIssues({
    query,
    candidates,
    limit: 5,
  });

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: buildSimilarIssueComment(query, matches, params.locale),
  });
}

async function resolveGitHubSimilarIssueQuery(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  query: string;
}): Promise<string> {
  const fromCommand = resolveSimilarIssueQuery({
    query: params.query,
  });
  if (fromCommand) {
    return fromCommand;
  }

  try {
    const pr = (
      await params.context.octokit.pulls.get({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
      })
    ).data;
    const fromPr = resolveSimilarIssueQuery({
      query: "",
      title: pr.title,
      description: pr.body,
    });
    return fromPr;
  } catch {
    return "";
  }
}

export function isGitHubBotCommentUser(
  user:
    | {
        type?: string;
        login?: string;
      }
    | null
    | undefined,
): boolean {
  const type = (user?.type ?? "").toLowerCase();
  if (type === "bot") {
    return true;
  }

  return (user?.login ?? "").trim().toLowerCase().endsWith("[bot]");
}

export function isGitHubCommandRateLimited(params: {
  platform: "github-app" | "github-webhook";
  owner: string;
  repo: string;
  pullNumber: number;
  userLogin?: string;
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
  const user = normalizeRateLimitPart(params.userLogin, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key =
    `${params.platform}:` +
    `${normalizeRateLimitPart(params.owner, "unknown-owner")}/` +
    `${normalizeRateLimitPart(params.repo, "unknown-repo")}:` +
    `pr:${params.pullNumber}:user:${user}:cmd:${command}`;
  return isRateLimited(key, maxPerWindow, windowMs);
}

async function isGitHubCommandRateLimitedAsync(params: {
  platform: "github-app" | "github-webhook";
  owner: string;
  repo: string;
  pullNumber: number;
  userLogin?: string;
  command: string;
}): Promise<boolean> {
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
  const user = normalizeRateLimitPart(params.userLogin, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key =
    `${params.platform}:` +
    `${normalizeRateLimitPart(params.owner, "unknown-owner")}/` +
    `${normalizeRateLimitPart(params.repo, "unknown-repo")}:` +
    `pr:${params.pullNumber}:user:${user}:cmd:${command}`;
  return isRateLimitedAsync(key, maxPerWindow, windowMs);
}

async function shouldRejectGitHubCommandByRateLimit(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  userLogin?: string;
  command: string;
  platform: "github-app" | "github-webhook";
}): Promise<boolean> {
  if (
    !(await isGitHubCommandRateLimitedAsync({
      platform: params.platform,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      userLogin: params.userLogin,
      command: params.command,
    }))
  ) {
    return false;
  }

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: githubCommandRateLimitMessage(resolveUiLocale()),
  });
  return true;
}

function githubCommandRateLimitMessage(locale: UiLocale): string {
  return localizeText(
    {
      zh: "`命令触发过于频繁，请稍后再试（默认每用户每 PR 每小时 10 次）。`",
      en: "`Command triggered too frequently. Please retry later (default: 10 times/hour per user per PR).`",
    },
    locale,
  );
}

// ---------------------------------------------------------------------------
// /generate_labels command helper
// ---------------------------------------------------------------------------

async function runGitHubGenerateLabelsCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  locale: UiLocale;
  throwOnError?: boolean;
}): Promise<void> {
  const { context, owner, repo, pullNumber, locale } = params;
  try {
    const pr = (
      await context.octokit.pulls.get({ owner, repo, pull_number: pullNumber })
    ).data;
    const files = await context.octokit.paginate(context.octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    // Build minimal DiffFileContext-compatible objects for label inference
    const fileContexts = files.map((f) => {
      const filename = (f as { filename?: string }).filename ?? "";
      return {
        newPath: filename,
        patch: "",
        oldLinesWithNumber: new Map<number, string>(),
        newLinesWithNumber: new Map<number, string>(),
        oldPath: filename,
        status: "modified",
        additions: 0,
        deletions: 0,
        extendedDiff: "",
      };
    });

    const labels = inferReviewLabels({
      title: pr.title ?? "",
      files: fileContexts,
      hasSecretFinding: false,
      reviewResult: {
        riskLevel: "low",
        summary: "",
        positives: [],
        actionItems: [],
        reviews: [],
      },
      maxLabels: 10,
      docsFromTitle: true,
      docsFromFiles: "all-documentation",
      includeTestLabelFromFiles: true,
      includeCiLabelFromFiles: true,
    });

    if (labels.length === 0) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "## AI Label Generator\n\n未检测到可自动标记的标签。",
            en: "## AI Label Generator\n\nNo labels could be inferred from this PR.",
          },
          locale,
        ),
      });
      return;
    }

    if (context.octokit.issues.addLabels) {
      await context.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pullNumber,
        labels,
      });
    }
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: `## AI Label Generator\n\n已添加标签：${labels.map((l) => `\`${l}\``).join(", ")}`,
          en: `## AI Label Generator\n\nLabels added: ${labels.map((l) => `\`${l}\``).join(", ")}`,
        },
        locale,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log.error({ owner, repo, pullNumber, error: message }, "generate_labels failed");
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: `## AI Label Generator\n\n标签生成失败：${message}`,
          en: `## AI Label Generator\n\nLabel generation failed: ${message}`,
        },
        locale,
      ),
    });
    if (params.throwOnError) {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// /auto_approve command helper
// ---------------------------------------------------------------------------

async function runGitHubAutoApproveCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  customRules: string[];
  includeCiChecks: boolean;
  locale: UiLocale;
  throwOnError?: boolean;
}): Promise<void> {
  const { context, owner, repo, pullNumber, locale } = params;

  if (!context.octokit.pulls.createReview) {
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: "当前 GitHub 客户端不支持 `/auto_approve`（缺少 pulls.createReview）。",
          en: "Current GitHub client does not support `/auto_approve` (missing pulls.createReview).",
        },
        locale,
      ),
    });
    return;
  }

  try {
    const riskQuestion = buildAutoApproveQuestion("PR", locale);
    await runGitHubAsk({
      context,
      pullNumber,
      question: riskQuestion,
      trigger: "comment-command",
      customRules: params.customRules,
      includeCiChecks: params.includeCiChecks,
      commentTitle: "AI Auto-Approve",
      displayQuestion: "/auto_approve",
      throwOnError: true,
    });

    // Retrieve the answer from the most recent bot comment to parse risk level
    let riskLevel = "high";
    let reason = "";
    if (context.octokit.issues.listComments) {
      // Paginate backwards from the latest comments to find the bot's response
      let botComment: { body?: string | null } | undefined;
      const MAX_PAGES = 10;
      // First, get page 1 to discover total count via pagination
      const firstPage = await context.octokit.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
        page: 1,
      });
      const totalOnFirstPage = firstPage.data.length;

      if (totalOnFirstPage < 100) {
        // All comments fit in one page — search from the end
        botComment = [...firstPage.data]
          .reverse()
          .find((c) => c.body?.includes("AI Auto-Approve"));
      } else {
        // Multiple pages exist — scan backwards from the latest pages
        for (let page = MAX_PAGES; page >= 1 && !botComment; page--) {
          const pageData = page === 1
            ? firstPage
            : await context.octokit.issues.listComments({
                owner,
                repo,
                issue_number: pullNumber,
                per_page: 100,
                page,
              });
          if (pageData.data.length === 0) continue;
          botComment = [...pageData.data]
            .reverse()
            .find((c) => c.body?.includes("AI Auto-Approve"));
        }
      }
      if (botComment?.body) {
        // Try JSON.parse first, fall back to regex
        const jsonBlockMatch = botComment.body.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
          ?? botComment.body.match(/(\{[\s\S]*?"risk"[\s\S]*?\})/);
        if (jsonBlockMatch?.[1]) {
          try {
            const parsed = JSON.parse(jsonBlockMatch[1]) as { risk?: string; reason?: string };
            riskLevel = (parsed.risk ?? "high").toLowerCase();
            reason = parsed.reason ?? "";
          } catch {
            // JSON parse failed — keep defaults
          }
        }
      }
    }

    if (riskLevel === "none" || riskLevel === "low") {
      await context.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: "APPROVE",
        body: localizeText(
          {
            zh: `AI 自动批准 — 风险等级: **${riskLevel}**\n\n${reason}`,
            en: `AI Auto-Approved — Risk level: **${riskLevel}**\n\n${reason}`,
          },
          locale,
        ),
      });
    } else {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: `## AI Auto-Approve\n\n风险等级为 **${riskLevel}**，不满足自动批准条件。\n\n${reason}`,
            en: `## AI Auto-Approve\n\nRisk level is **${riskLevel}** — does not meet auto-approve criteria.\n\n${reason}`,
          },
          locale,
        ),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log.error({ owner, repo, pullNumber, error: message }, "auto_approve failed");
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: `## AI Auto-Approve\n\n自动批准失败：${message}`,
          en: `## AI Auto-Approve\n\nAuto-approve failed: ${message}`,
        },
        locale,
      ),
    });
    if (params.throwOnError) {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// /scan_repo_discussions command helper
// ---------------------------------------------------------------------------

async function runGitHubScanRepoDiscussionsCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  customRules: string[];
  locale: UiLocale;
  throwOnError?: boolean;
}): Promise<void> {
  const { context, owner, repo, pullNumber, locale } = params;

  if (!context.octokit.pulls.listReviewComments) {
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: "当前 GitHub 客户端不支持 `/scan_repo_discussions`（缺少 pulls.listReviewComments）。",
          en: "Current GitHub client does not support `/scan_repo_discussions` (missing pulls.listReviewComments).",
        },
        locale,
      ),
    });
    return;
  }

  try {
    // Collect review comments from recently merged PRs
    if (!context.octokit.issues.listForRepo) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "当前 GitHub 客户端不支持 `/scan_repo_discussions`（缺少 issues.listForRepo）。",
            en: "Current GitHub client does not support `/scan_repo_discussions` (missing issues.listForRepo).",
          },
          locale,
        ),
      });
      return;
    }

    const recentPrs = await context.octokit.issues.listForRepo({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: SCAN_DISCUSSIONS_FETCH_PER_PAGE,
      page: 1,
    });
    const mergedPrs = recentPrs.data.filter((issue) => issue.pull_request);

    const discussionParts: string[] = [];
    const maxPrs = Math.min(mergedPrs.length, SCAN_DISCUSSIONS_MAX_PRS);
    for (let i = 0; i < maxPrs; i++) {
      const pr = mergedPrs[i];
      if (!pr) {
        continue;
      }
      try {
        const comments = await context.octokit.pulls.listReviewComments({
          owner,
          repo,
          pull_number: pr.number,
          per_page: SCAN_DISCUSSIONS_MAX_COMMENTS_PER_PR * 3,
          page: 1,
        });
        if (comments.data.length > 0) {
          discussionParts.push(
            `### PR #${pr.number}: ${pr.title ?? ""}`,
            ...comments.data.slice(0, SCAN_DISCUSSIONS_MAX_COMMENTS_PER_PR).map(
              (c) => `- ${c.body?.slice(0, SCAN_DISCUSSIONS_COMMENT_PREVIEW_LENGTH) ?? "(empty)"}`,
            ),
            "",
          );
        }
      } catch {
        // Skip PRs where comments can't be loaded
      }
    }

    if (discussionParts.length === 0) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "## AI Scan Repo Discussions\n\n未找到近期已合并 PR 的评审评论。",
            en: "## AI Scan Repo Discussions\n\nNo review comments found in recently merged PRs.",
          },
          locale,
        ),
      });
      return;
    }

    const discussionsSummary = discussionParts.join("\n");
    const scanQuestion = buildScanRepoDiscussionsQuestion(
      "PR",
      discussionsSummary,
      locale,
    );
    await runGitHubAsk({
      context,
      pullNumber,
      question: scanQuestion,
      trigger: "comment-command",
      customRules: params.customRules,
      includeCiChecks: false,
      commentTitle: "AI Scan Repo Discussions",
      displayQuestion: "/scan_repo_discussions",
      throwOnError: params.throwOnError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log.error({ owner, repo, pullNumber, error: message }, "scan_repo_discussions failed");
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: `## AI Scan Repo Discussions\n\n扫描失败：${message}`,
          en: `## AI Scan Repo Discussions\n\nScan failed: ${message}`,
        },
        locale,
      ),
    });
    if (params.throwOnError) {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// /help_docs command helper — load /docs directory content
// ---------------------------------------------------------------------------

const HELP_DOCS_MAX_FILES = 5;
const HELP_DOCS_MAX_FILE_LENGTH = 3000;

async function loadGitHubDocsContent(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
}): Promise<string> {
  const { context, owner, repo } = params;
  try {
    const response = await tryLoadRepositoryContent({
      context,
      owner,
      repo,
      path: "docs",
    });
    if (!response || !Array.isArray(response)) {
      return "(No /docs directory found in this repository)";
    }

    const fileEntries = response
      .filter((f) => f.type === "file" && f.path)
      .slice(0, HELP_DOCS_MAX_FILES);
    if (fileEntries.length === 0) {
      return "(No files found in /docs directory)";
    }

    const parts: string[] = [];
    for (const entry of fileEntries) {
      const text = await tryLoadRepositoryTextFile({
        context,
        owner,
        repo,
        path: entry.path!,
      });
      if (text) {
        parts.push(`### ${entry.path}\n${text.slice(0, HELP_DOCS_MAX_FILE_LENGTH)}`);
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : "(Could not read files from /docs directory)";
  } catch {
    return "(Failed to load /docs directory)";
  }
}
