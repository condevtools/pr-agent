import { isRateLimited, localizeText, normalizeRateLimitPart, readNumberEnv, readOptionalStringEnv, readStringEnv, resolveUiLocale, type UiLocale } from "#core";
import { resolvePublicationRuntime } from "../../../agent-runtime/runtime.js";
import { findSimilarIssues } from "../../../issues/similarity/scorer.js";
import { buildSimilarIssueComment, buildSimilarIssueQueryMissingMessage, resolveSimilarIssueQuery } from "../../../issues/similarity/presentation.js";
import { gitLabApiRequest } from "../../../integrations/gitlab/api/http-client.js";
import { collectGitLabMergeRequestContext, requireGitLabToken, resolveGitLabBaseUrl } from "../../../integrations/gitlab/repository/context.js";
import type { GitLabCollectedContext, GitLabCommentTarget } from "../../../integrations/gitlab/repository/contracts.js";
import { buildMergeRequestPayloadFromNote, isGitLabBotUserName } from "../../../integrations/gitlab/webhooks/events.js";
import { gitlabNoteWebhookPayloadSchema, parseGitLabPayload, type GitLabMrWebhookBody, type GitLabNoteWebhookBody, type GitLabWebhookBody } from "../../../integrations/gitlab/webhooks/contracts.js";
import { type LoggerLike } from "../../../integrations/gitlab/webhooks/contracts.js";
import { resolveGitLabReviewPolicy } from "../../../review/policy/gitlab.js";
import { runGitLabReview } from "../../../review/platforms/gitlab/workflow.js";
import { recordGitLabFeedbackSignal, loadGitLabFeedbackSignals } from "../../../review/platforms/gitlab/state.js";
import { postGitLabCommandComment, publishGitLabGeneralComment } from "../../../review/platforms/gitlab/publication.js";
import { buildManagedCommandCommentKey } from "../../../review/rendering/managed-comments.js";
import { buildAddDocRule, buildAnalyzeQuestion, buildAutoApproveQuestion, buildChangelogQuestion, buildChecksQuestion, buildComplianceQuestion, buildGenerateTestsQuestion, buildHelpDocsQuestion, buildImproveComponentRule, buildImproveRule, buildReflectQuestion, buildScanRepoDiscussionsQuestion, buildSimilarCodeQuestion } from "../../builders/questions.js";
import { buildDescribeQuestion } from "../../builders/describe-question.js";
import { buildConfigFoundMessage, buildConfigNotFoundMessage } from "../../config.js";
import { dispatchCommandRegistrations, type CommandDispatchResult, type CommandRegistration } from "../../dispatch.js";
import { parseAddDocCommand, parseAnalyzeCommand, parseAskCommand, parseAutoApproveCommand, parseChangelogCommand, parseChecksCommand, parseComplianceCommand, parseConfigCommand, parseCustomPromptCommand, parseDescribeCommand, parseFeedbackCommand, parseGenerateLabelsCommand, parseGenerateTestsCommand, parseHelpCommand, parseHelpDocsCommand, parseImproveCommand, parseImproveComponentCommand, parseReflectCommand, parseReviewCommand, parseScanRepoDiscussionsCommand, parseSimilarCodeCommand, parseSimilarIssueCommand } from "../../parsers/index.js";
import { buildHelpMessage } from "../../presentation/help.js";
import { mergeChangelogContent as mergeSharedChangelogContent } from "../../presentation/changelog.js";
import { buildCommandApplyDisabledByPolicyMessage, buildCommandDisabledByPolicyMessage, buildFeedbackSignalRecordedMessage, buildReflectDependsOnAskMessage } from "../../presentation/messages.js";
import { DurableUnadaptedWriterBlockedError } from "../../errors.js";
import { createGitLabCommandWorkflows } from "./workflows.js";
import type { ReviewTrigger } from "#review";
import { DEFAULT_DEDUPE_TTL_MS } from "../../../review/policy/triggers.js";
import { applyGitLabChangelogUpdate, updateGitLabMergeRequestDescription } from "./changelog.js";
import { buildGitLabChangelogQuestion, buildGitLabDescribeQuestion, buildGitLabReflectQuestion } from "./questions.js";
import { shouldRejectGitLabCommandByRateLimit } from "./rate-limit.js";
import { runGitLabSimilarIssueCommand } from "./similar-issues.js";

const GITLAB_DISPLAY_QUESTION_MAX_LENGTH = 80;

interface GitLabAskRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  question: string;
  trigger: ReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  managedCommentKey?: string;
  enableConversationContext?: boolean;
  throwOnError?: boolean;
}

interface GitLabDescribeRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: ReviewTrigger;
  apply?: boolean;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

interface GitLabChangelogRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: ReviewTrigger;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}


const gitLabCommandWorkflows = createGitLabCommandWorkflows({
  defaultDedupeTtlMs: DEFAULT_DEDUPE_TTL_MS,
  requireGitLabToken,
  buildCommentTarget: (payload) =>
    buildGitLabCommentTargetFromPayload({
      payload: payload as GitLabMrWebhookBody,
      baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
    }),
  postCommandComment: postGitLabCommandComment,
  loadFeedbackSignals: loadGitLabFeedbackSignals,
  collectMergeRequestContext: async (params) =>
    collectGitLabMergeRequestContext({
      payload: params.payload as GitLabMrWebhookBody,
      gitlabToken: params.gitlabToken,
      baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
      customRules: params.customRules,
      includeCiChecks: params.includeCiChecks,
      feedbackSignals: params.feedbackSignals,
    }),
  buildDescribeQuestion: (locale) => buildGitLabDescribeQuestion(locale),
  buildChangelogQuestion: (focus, locale) =>
    buildGitLabChangelogQuestion(focus, locale),
  updateMergeRequestDescription: async (params) =>
    updateGitLabMergeRequestDescription({
      gitlabToken: params.gitlabToken,
      collected: params.collected as GitLabCollectedContext,
      description: params.description,
    }),
  applyChangelogUpdate: async (params) =>
    applyGitLabChangelogUpdate({
      gitlabToken: params.gitlabToken,
      collected: params.collected as GitLabCollectedContext,
      pullNumber: params.pullNumber,
      draft: params.draft,
    }),
});


function buildGitLabCommentTargetFromPayload(params: {
  payload: GitLabMrWebhookBody;
  baseUrl?: string;
}): GitLabCommentTarget {
  return {
    baseUrl: resolveGitLabBaseUrl(params.baseUrl, params.payload.project.web_url),
    projectId: params.payload.project.id,
    mrId: params.payload.object_attributes.iid,
  };
}

export async function handleGitLabNoteWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const payload = parseGitLabPayload(
    gitlabNoteWebhookPayloadSchema,
    params.payload,
    "note",
  ) as GitLabNoteWebhookBody;
  const noteableType = String(
    payload.object_attributes.noteable_type ?? "",
  ).toLowerCase();
  if (noteableType !== "mergerequest") {
    return { ok: true, message: "ignored note event (not merge request note)" };
  }

  const noteAction = String(payload.object_attributes.action ?? "create").toLowerCase();
  if (noteAction !== "create") {
    return { ok: true, message: `ignored note action=${noteAction}` };
  }

  const body =
    typeof payload.object_attributes.note === "string"
      ? payload.object_attributes.note.trim()
      : "";
  const locale = resolveUiLocale();
  if (!body) {
    return { ok: true, message: "empty note body" };
  }
  if (isGitLabBotUserName(payload.user?.username)) {
    return { ok: true, message: "ignored note from bot user" };
  }

  const mergePayload = buildMergeRequestPayloadFromNote(payload);
  const target = buildGitLabCommentTargetFromPayload({
    payload: mergePayload,
    baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
  });
  const durableRuntime = await resolvePublicationRuntime({
    platform: "gitlab",
    origin: target.baseUrl,
    repository: payload.project.path_with_namespace ?? String(payload.project.id),
  });
  if (durableRuntime && !parseReviewCommand(body).matched) {
    throw new DurableUnadaptedWriterBlockedError("gitlab", body.split(/\s+/u, 1)[0] ?? "unknown");
  }
  const gitlabToken = durableRuntime?.resolveCredential
    ? await durableRuntime.resolveCredential()
    : requireGitLabToken(params.headers);
  const commentUserName = payload.user?.username;
  const baseUrl = resolveGitLabBaseUrl(
    readOptionalStringEnv("GITLAB_BASE_URL"),
    payload.project.web_url,
  );
  const { policy, hasConfigFile } = await resolveGitLabReviewPolicy({
    baseUrl,
    projectId: payload.project.id,
    gitlabToken,
    ref: mergePayload.object_attributes.target_branch,
  });

  const hitRateLimit = async (
    command:
      | "help"
      | "config"
      | "feedback"
      | "describe"
      | "ask"
      | "checks"
      | "generate-tests"
      | "changelog"
      | "improve"
      | "add-doc"
      | "reflect"
      | "similar-issue"
      | "ai-review"
      | "custom-prompt"
      | "help-docs"
      | "analyze"
      | "compliance"
      | "improve-component"
      | "generate-labels"
      | "similar-code"
      | "auto-approve"
      | "scan-repo-discussions",
    message: string,
  ): Promise<{ ok: boolean; message: string } | undefined> => {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command,
        logger: params.logger,
      })
    ) {
      return { ok: true, message };
    }
    return undefined;
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

  const commandRegistry: CommandRegistration<unknown>[] = [
    registerCommand(
      "help",
      () => {
        const parsed = parseHelpCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        const limited = await hitRateLimit("help", "help command rate limited");
        if (limited) {
          return limited;
        }
        await publishGitLabGeneralComment(
          gitlabToken,
          target,
          buildHelpMessage({ target: "MR", locale }),
        );
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
        const limited = await hitRateLimit("config", "config command rate limited");
        if (limited) {
          return limited;
        }
        const configBody = hasConfigFile
          ? buildConfigFoundMessage({ config: { review: policy }, locale })
          : buildConfigNotFoundMessage(locale);
        await publishGitLabGeneralComment(gitlabToken, target, configBody);
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
        const limited = await hitRateLimit("feedback", "feedback command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.feedbackCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "feedback",
              policyPath: ".pr-agent.yml -> review.feedbackCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "feedback command ignored by policy" };
        }

        const positive =
          feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
        const signalCore = positive
          ? "developer prefers high-confidence, actionable suggestions"
          : "developer prefers fewer low-value/noisy suggestions";
        const noteText = feedbackCommand.note ? `; note: ${feedbackCommand.note}` : "";
        recordGitLabFeedbackSignal({
          projectId: payload.project.id,
          signal: `MR !${mergePayload.object_attributes.iid} ${feedbackCommand.action}: ${signalCore}${noteText}`,
        });

        const context = await collectGitLabMergeRequestContext({
          payload: mergePayload,
          gitlabToken,
          baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
        });
        await publishGitLabGeneralComment(
          gitlabToken,
          context,
          buildFeedbackSignalRecordedMessage({
            action: feedbackCommand.action,
            locale,
          }),
        );
        return { ok: true, message: "feedback command recorded" };
      },
    ),
    registerCommand(
      "describe",
      () => {
        const parsed = parseDescribeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (describe) => {
        const limited = await hitRateLimit("describe", "describe command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.describeEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "describe",
              policyPath: ".pr-agent.yml -> review.describeEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "describe command ignored by policy" };
        }
        if (describe.apply && !policy.describeAllowApply) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandApplyDisabledByPolicyMessage({
              command: "describe",
              policyPath: ".pr-agent.yml -> review.describeAllowApply=false",
              locale,
            }),
          );
          return { ok: true, message: "describe apply ignored by policy" };
        }

        await runGitLabDescribe({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          trigger: "describe-command",
          apply: describe.apply && policy.describeAllowApply,
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
      async (ask) => {
        const limited = await hitRateLimit("ask", "ask command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.askCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "ask",
              policyPath: ".pr-agent.yml -> review.askCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "ask command ignored by policy" };
        }

        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: ask.question,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          enableConversationContext: true,
          managedCommentKey: buildManagedCommandCommentKey("ask", ask.question),
        });
        return { ok: true, message: "ask command triggered" };
      },
    ),
    registerCommand(
      "checks",
      () => {
        const parsed = parseChecksCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (checksCommand) => {
        const limited = await hitRateLimit("checks", "checks command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.checksCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "checks",
              policyPath: ".pr-agent.yml -> review.checksCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "checks command ignored by policy" };
        }

        const checksQuestion = buildChecksQuestion("MR", checksCommand.question, locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: checksQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: true,
          commentTitle: "AI Checks",
          managedCommentKey: buildManagedCommandCommentKey(
            "checks",
            checksQuestion,
          ),
        });
        return { ok: true, message: "checks command triggered" };
      },
    ),
    registerCommand(
      "generate-tests",
      () => {
        const parsed = parseGenerateTestsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (generateTests) => {
        const limited = await hitRateLimit(
          "generate-tests",
          "generate_tests command rate limited",
        );
        if (limited) {
          return limited;
        }
        if (!policy.generateTestsCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "generate_tests",
              policyPath: ".pr-agent.yml -> review.generateTestsCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "generate_tests command ignored by policy" };
        }

        const generateTestsQuestion = buildGenerateTestsQuestion(
          "MR",
          generateTests.focus,
          locale,
        );
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: generateTestsQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Test Generator",
          displayQuestion: generateTests.focus
            ? `/generate_tests ${generateTests.focus}`
            : "/generate_tests",
          managedCommentKey: buildManagedCommandCommentKey(
            "generate-tests",
            generateTestsQuestion,
          ),
        });
        return { ok: true, message: "generate_tests command triggered" };
      },
    ),
    registerCommand(
      "changelog",
      () => {
        const parsed = parseChangelogCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (changelogCommand) => {
        const limited = await hitRateLimit("changelog", "changelog command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.changelogCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "changelog",
              policyPath: ".pr-agent.yml -> review.changelogCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "changelog command ignored by policy" };
        }
        if (changelogCommand.apply && !policy.changelogAllowApply) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandApplyDisabledByPolicyMessage({
              command: "changelog",
              policyPath: ".pr-agent.yml -> review.changelogAllowApply=false",
              locale,
            }),
          );
          return { ok: true, message: "changelog apply ignored by policy" };
        }

        await runGitLabChangelog({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          trigger: "comment-command",
          focus: changelogCommand.focus,
          apply: changelogCommand.apply && policy.changelogAllowApply,
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
        });
        return { ok: true, message: "changelog command triggered" };
      },
    ),
    registerCommand(
      "improve",
      () => {
        const parsed = parseImproveCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (improveCommand) => {
        const limited = await hitRateLimit("improve", "improve command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.improveCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "improve",
              policyPath: ".pr-agent.yml -> review.improveCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "improve command ignored by policy" };
        }

        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: "comment",
          trigger: "comment-command",
          customRules: [...policy.customRules, buildImproveRule(improveCommand.focus)],
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: policy.secretScanEnabled,
          secretScanCustomPatterns: policy.secretScanCustomPatterns,
          enableAutoLabel: false,
        });
        return { ok: true, message: "improve command triggered" };
      },
    ),
    registerCommand(
      "add-doc",
      () => {
        const parsed = parseAddDocCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (addDocCommand) => {
        const limited = await hitRateLimit("add-doc", "add_doc command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.addDocCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "add_doc",
              policyPath: ".pr-agent.yml -> review.addDocCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "add_doc command ignored by policy" };
        }

        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: "comment",
          trigger: "comment-command",
          customRules: [...policy.customRules, buildAddDocRule(addDocCommand.focus)],
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: false,
          enableAutoLabel: false,
        });
        return { ok: true, message: "add_doc command triggered" };
      },
    ),
    registerCommand(
      "reflect",
      () => {
        const parsed = parseReflectCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (reflectCommand) => {
        const limited = await hitRateLimit("reflect", "reflect command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.askCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildReflectDependsOnAskMessage({
              askPolicyPath: ".pr-agent.yml -> review.askCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "reflect command ignored by policy" };
        }

        const reflectQuestion = buildGitLabReflectQuestion(reflectCommand.request, locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: reflectQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Reflect",
          displayQuestion: reflectCommand.request
            ? `/reflect ${reflectCommand.request}`
            : "/reflect",
          managedCommentKey: buildManagedCommandCommentKey("reflect", reflectQuestion),
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
        const limited = await hitRateLimit(
          "similar-issue",
          "similar_issue command rate limited",
        );
        if (limited) {
          return limited;
        }

        await runGitLabSimilarIssueCommand({
          payload: mergePayload,
          gitlabToken,
          query: similarIssueCommand.query,
          locale,
        });
        return { ok: true, message: "similar_issue command triggered" };
      },
    ),
    // --- Wave 1: AI Q&A commands ---
    registerCommand(
      "custom-prompt",
      () => {
        const parsed = parseCustomPromptCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        const limited = await hitRateLimit("custom-prompt", "custom_prompt command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.customPromptCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "custom_prompt",
              policyPath: ".pr-agent.yml -> review.customPromptCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "custom_prompt command ignored by policy" };
        }
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: cmd.prompt,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Custom Prompt",
          displayQuestion: `/custom_prompt ${cmd.prompt.length > GITLAB_DISPLAY_QUESTION_MAX_LENGTH ? cmd.prompt.slice(0, GITLAB_DISPLAY_QUESTION_MAX_LENGTH) + "…" : cmd.prompt}`,
          managedCommentKey: buildManagedCommandCommentKey("custom-prompt", cmd.prompt),
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
        const limited = await hitRateLimit("help-docs", "help_docs command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.helpDocsCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "help_docs",
              policyPath: ".pr-agent.yml -> review.helpDocsCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "help_docs command ignored by policy" };
        }
        const helpDocsQuestion = buildHelpDocsQuestion(
          "MR",
          cmd.question,
          "(Documentation loading not available for GitLab — answering from MR context only)",
          locale,
        );
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: helpDocsQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: false,
          commentTitle: "AI Help Docs",
          displayQuestion: `/help_docs ${cmd.question}`,
          managedCommentKey: buildManagedCommandCommentKey("help-docs", cmd.question),
        });
        return { ok: true, message: "help_docs command triggered" };
      },
    ),
    registerCommand(
      "analyze",
      () => {
        const parsed = parseAnalyzeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        const limited = await hitRateLimit("analyze", "analyze command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.analyzeCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "analyze",
              policyPath: ".pr-agent.yml -> review.analyzeCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "analyze command ignored by policy" };
        }
        const analyzeQuestion = buildAnalyzeQuestion("MR", locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: analyzeQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Analyze",
          displayQuestion: "/analyze",
          managedCommentKey: buildManagedCommandCommentKey("analyze", analyzeQuestion),
        });
        return { ok: true, message: "analyze command triggered" };
      },
    ),
    registerCommand(
      "compliance",
      () => {
        const parsed = parseComplianceCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        const limited = await hitRateLimit("compliance", "compliance command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.complianceCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "compliance",
              policyPath: ".pr-agent.yml -> review.complianceCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "compliance command ignored by policy" };
        }
        const complianceQuestion = buildComplianceQuestion("MR", cmd.focus, locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: complianceQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Compliance",
          displayQuestion: cmd.focus ? `/compliance ${cmd.focus}` : "/compliance",
          managedCommentKey: buildManagedCommandCommentKey("compliance", complianceQuestion),
        });
        return { ok: true, message: "compliance command triggered" };
      },
    ),
    // --- Wave 2: AI Review + Tool commands ---
    registerCommand(
      "improve-component",
      () => {
        const parsed = parseImproveComponentCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        const limited = await hitRateLimit("improve-component", "improve_component command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.improveCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "improve_component",
              policyPath: ".pr-agent.yml -> review.improveCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "improve_component command ignored by policy" };
        }
        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: "comment",
          trigger: "comment-command",
          customRules: [...policy.customRules, buildImproveComponentRule(cmd.component)],
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: policy.secretScanEnabled,
          secretScanCustomPatterns: policy.secretScanCustomPatterns,
          enableAutoLabel: false,
        });
        return { ok: true, message: "improve_component command triggered" };
      },
    ),
    registerCommand(
      "generate-labels",
      () => {
        const parsed = parseGenerateLabelsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        await publishGitLabGeneralComment(
          gitlabToken,
          target,
          localizeText(
            {
              zh: "## AI Label Generator\n\nGitLab 上的 `/generate_labels` 暂不支持。请使用 `/ai-review` 触发自动标签。",
              en: "## AI Label Generator\n\n`/generate_labels` is not yet supported on GitLab. Use `/ai-review` to trigger auto-labeling.",
            },
            locale,
          ),
        );
        return { ok: true, message: "generate_labels command triggered (gitlab unsupported)" };
      },
    ),
    // --- Wave 3: Independent backend commands ---
    registerCommand(
      "similar-code",
      () => {
        const parsed = parseSimilarCodeCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (cmd) => {
        const limited = await hitRateLimit("similar-code", "similar_code command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.similarCodeCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "similar_code",
              policyPath: ".pr-agent.yml -> review.similarCodeCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "similar_code command ignored by policy" };
        }
        const similarCodeQuestion = buildSimilarCodeQuestion("MR", cmd.query, locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: similarCodeQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: false,
          commentTitle: "AI Similar Code",
          displayQuestion: cmd.query ? `/similar_code ${cmd.query}` : "/similar_code",
          managedCommentKey: buildManagedCommandCommentKey("similar-code", similarCodeQuestion),
        });
        return { ok: true, message: "similar_code command triggered" };
      },
    ),
    registerCommand(
      "auto-approve",
      () => {
        const parsed = parseAutoApproveCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        const limited = await hitRateLimit("auto-approve", "auto_approve command rate limited");
        if (limited) {
          return limited;
        }
        if (!policy.autoApproveCommandEnabled) {
          await publishGitLabGeneralComment(
            gitlabToken,
            target,
            buildCommandDisabledByPolicyMessage({
              command: "auto_approve",
              policyPath: ".pr-agent.yml -> review.autoApproveCommandEnabled=false",
              locale,
            }),
          );
          return { ok: true, message: "auto_approve command ignored by policy" };
        }
        // GitLab auto-approve: run risk assessment via AI
        const riskQuestion = buildAutoApproveQuestion("MR", locale);
        await runGitLabAsk({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          question: riskQuestion,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          commentTitle: "AI Auto-Approve",
          displayQuestion: "/auto_approve",
          managedCommentKey: buildManagedCommandCommentKey("auto-approve", riskQuestion),
        });
        return { ok: true, message: "auto_approve command triggered" };
      },
    ),
    registerCommand(
      "scan-repo-discussions",
      () => {
        const parsed = parseScanRepoDiscussionsCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async () => {
        await publishGitLabGeneralComment(
          gitlabToken,
          target,
          localizeText(
            {
              zh: "## AI Scan Repo Discussions\n\nGitLab 上的 `/scan_repo_discussions` 暂不支持。",
              en: "## AI Scan Repo Discussions\n\n`/scan_repo_discussions` is not yet supported on GitLab.",
            },
            locale,
          ),
        );
        return { ok: true, message: "scan_repo_discussions command triggered (gitlab unsupported)" };
      },
    ),
    registerCommand(
      "ai-review",
      () => {
        const parsed = parseReviewCommand(body);
        return parsed.matched ? parsed : undefined;
      },
      async (command) => {
        const limited = await hitRateLimit("ai-review", "note review rate limited");
        if (limited) {
          return limited;
        }

        await runGitLabReview({
          payload: mergePayload,
          headers: params.headers,
          logger: params.logger,
          mode: command.mode,
          trigger: "comment-command",
          customRules: policy.customRules,
          includeCiChecks: policy.includeCiChecks,
          enableSecretScan: policy.secretScanEnabled,
          secretScanCustomPatterns: policy.secretScanCustomPatterns,
          enableAutoLabel: policy.autoLabelEnabled,
        });
        return { ok: true, message: "note review triggered" };
      },
    ),
  ];

  return dispatchCommandRegistrations(commandRegistry, {
    ok: true,
    message: "ignored note content",
  });
}

async function runGitLabAsk(params: GitLabAskRunParams): Promise<void> {
  return gitLabCommandWorkflows.runAsk(params);
}

async function runGitLabDescribe(params: GitLabDescribeRunParams): Promise<void> {
  return gitLabCommandWorkflows.runDescribe(params);
}

async function runGitLabChangelog(params: GitLabChangelogRunParams): Promise<void> {
  return gitLabCommandWorkflows.runChangelog(params);
}
