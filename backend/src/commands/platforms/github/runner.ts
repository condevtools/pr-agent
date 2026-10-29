import { localizeText, readStringEnv, resolveUiLocale, type UiLocale } from "#core";
import { createGitHubCommandWorkflows } from "./workflows.js";
import { buildChangelogQuestion } from "../../builders/questions.js";
import { buildDescribeQuestion } from "../../builders/describe-question.js";
import { DEFAULT_DEDUPE_TTL_MS } from "../../../review/policy/triggers.js";
import { collectGitHubPullRequestContext } from "../../../integrations/github/repository/context.js";
import { decodeGitHubFileContent } from "../../../integrations/github/repository/content.js";
import type {
  GitHubAskRunParams,
  GitHubChangelogRunParams,
  GitHubDescribeRunParams,
} from "./contracts.js";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";
import type { MinimalGitHubOctokit } from "../../../integrations/github/api/types.js";
import { postGitHubCommandComment } from "../../../integrations/github/publication/comments.js";
import { getErrorMessage } from "../../../integrations/github/error.js";
import { loadGitHubFeedbackSignals } from "../../../review/platforms/github/state.js";
import { mergeChangelogContent } from "../../presentation/changelog.js";

const gitHubCommandWorkflows = createGitHubCommandWorkflows({
  defaultDedupeTtlMs: DEFAULT_DEDUPE_TTL_MS,
  collectPullRequestContext: async (params) =>
    collectGitHubPullRequestContext({
      octokit: params.context.octokit as MinimalGitHubOctokit,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      customRules: params.customRules,
      includeCiChecks: params.includeCiChecks,
      feedbackSignals: params.feedbackSignals,
    }),
  postCommandComment: postGitHubCommandComment,
  loadFeedbackSignals: loadGitHubFeedbackSignals,
  buildDescribeQuestion: buildGitHubDescribeQuestion,
  buildChangelogQuestion: buildGitHubChangelogQuestion,
  applyChangelogUpdate: applyGitHubChangelogUpdate,
  getErrorMessage,
});

export async function runGitHubDescribe(
  params: GitHubDescribeRunParams,
): Promise<void> {
  return gitHubCommandWorkflows.runDescribe(params);
}

export async function runGitHubAsk(
  params: GitHubAskRunParams,
): Promise<void> {
  return gitHubCommandWorkflows.runAsk(params);
}

export async function runGitHubChangelog(
  params: GitHubChangelogRunParams,
): Promise<void> {
  return gitHubCommandWorkflows.runChangelog(params);
}

export function buildGitHubChangelogQuestion(
  focus: string | undefined,
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildChangelogQuestion("PR", focus, locale);
}

export function buildGitHubDescribeQuestion(
  locale: UiLocale = resolveUiLocale(),
): string {
  return buildDescribeQuestion("PR", locale);
}

async function applyGitHubChangelogUpdate(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  branch: string;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const locale = resolveUiLocale();
  const path = readStringEnv("GITHUB_CHANGELOG_PATH", "CHANGELOG.md");
  const title = `PR #${params.pullNumber}`;
  const octokit = params.context.octokit;
  if (!octokit.repos.createOrUpdateFileContents) {
    return {
      message: localizeText(
        {
          zh: "当前运行模式不支持自动写回仓库文件，已生成 changelog 草稿供手动应用。",
          en: "Current runtime mode does not support writing back repository files automatically. A changelog draft has been generated for manual apply.",
        },
        locale,
      ),
    };
  }

  let existing = "";
  let existingSha: string | undefined;
  try {
    const response = await octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path,
      ref: params.branch,
    });
    const data = response.data;
    if (!Array.isArray(data) && data.content) {
      existing = decodeGitHubFileContent(data.content, data.encoding);
      existingSha = data.sha;
    }
  } catch {
    // create path on first write
  }

  const merged = mergeChangelogContent(existing, params.draft, title);
  await octokit.repos.createOrUpdateFileContents({
    owner: params.owner,
    repo: params.repo,
    path,
    message: `chore(changelog): update from ${title}`,
    content: Buffer.from(merged, "utf8").toString("base64"),
    sha: existingSha,
    branch: params.branch,
  });

  return {
    message: localizeText(
      {
        zh: `已写入 \`${path}\`（branch: \`${params.branch}\`）。`,
        en: `Written to \`${path}\` (branch: \`${params.branch}\`).`,
      },
      locale,
    ),
  };
}
