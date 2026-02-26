import {
  isRateLimited,
  localizeText,
  normalizeRateLimitPart,
  readNumberEnv,
  readOptionalStringEnv,
  resolveUiLocale,
  type UiLocale,
} from "#core";
import {
  buildManagedCommandCommentKey,
  recordGitHubFeedbackSignal,
  runGitHubAsk,
  runGitHubChangelog,
  runGitHubDescribe,
  runGitHubReview,
  type GitHubReviewContext,
} from "./github-review.js";
import { resolveGitHubReviewBehaviorPolicy } from "./github-policy.js";
import {
  findSimilarIssues,
  parseAddDocCommand,
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parseImproveCommand,
  parseMentionCommand,
  parseReflectCommand,
  parseReviewCommand,
  parseSimilarIssueCommand,
} from "#review";
import {
  buildAddDocRule,
  buildChecksQuestion,
  buildGenerateTestsQuestion,
  buildImproveRule,
  buildReflectQuestion,
} from "../shared/command-builders.js";
import {
  dispatchCommandRegistrations,
  type CommandDispatchResult,
  type CommandRegistration,
} from "../shared/command-dispatch.js";
import {
  buildCommandApplyDisabledByPolicyMessage,
  buildCommandDisabledByPolicyMessage,
  buildFeedbackSignalRecordedMessage,
  buildReflectDependsOnAskMessage,
} from "../shared/command-messages.js";
import {
  buildSimilarIssueComment,
  buildSimilarIssueQueryMissingMessage,
  resolveSimilarIssueQuery,
} from "../shared/similar-issue.js";
const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;

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
  const botLogin = appSlug ? `${appSlug}[bot]` : "";
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
        recordGitHubFeedbackSignal({
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
    !isGitHubCommandRateLimited({
      platform: params.platform,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      userLogin: params.userLogin,
      command: params.command,
    })
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
