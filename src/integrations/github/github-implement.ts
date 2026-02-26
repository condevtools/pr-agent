import { localizeText, type UiLocale } from "#core";
import { getPublicErrorMessage } from "../shared/public-error.js";
import type {
  GitHubReviewCommentSummary,
  GitHubReviewContext,
} from "./github-review-types.js";
import { decodeGitHubFileContent } from "./github-content.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runGitHubImplementCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  locale: UiLocale;
  throwOnError?: boolean;
}): Promise<void> {
  const { context, owner, repo, pullNumber, locale } = params;
  const octokit = context.octokit;

  if (!octokit.pulls.listReviewComments) {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: "当前 GitHub 客户端不支持 `/implement`（缺少 pulls.listReviewComments）。",
          en: "Current GitHub client does not support `/implement` (missing pulls.listReviewComments).",
        },
        locale,
      ),
    });
    return;
  }

  if (!octokit.repos.createOrUpdateFileContents) {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: "当前运行模式不支持 `/implement`（缺少文件写入权限）。",
          en: "Current runtime mode does not support `/implement` (missing file write permission).",
        },
        locale,
      ),
    });
    return;
  }

  try {
    const pr = (await octokit.pulls.get({ owner, repo, pull_number: pullNumber })).data;
    const headBranch = pr.head.ref;

    const comments = await collectAllReviewComments(octokit, owner, repo, pullNumber);
    const pendingSuggestions = extractPendingSuggestions(comments);

    if (pendingSuggestions.length === 0) {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "未找到可应用的 `suggestion` 代码建议。仅支持 bot 发布的包含 ````suggestion` 块的评审评论。",
            en: "No applicable `suggestion` blocks found. Only review comments from this bot containing ````suggestion` blocks are supported.",
          },
          locale,
        ),
      });
      return;
    }

    const grouped = groupSuggestionsByPath(pendingSuggestions);
    let applied = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [path, suggestions] of grouped) {
      try {
        const applyResult = await applySuggestionsToFile({
          octokit,
          owner,
          repo,
          path,
          branch: headBranch,
          suggestions,
        });
        applied += applyResult.applied;
        skipped += applyResult.skipped;
      } catch (error) {
        skipped += suggestions.length;
        errors.push(
          `\`${path}\`: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const summary = buildImplementSummary({ applied, skipped, errors, locale });
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: summary,
    });
  } catch (error) {
    const msg = getPublicErrorMessage(error);
    context.log.error(
      {
        owner,
        repo,
        pullNumber,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to execute /implement command",
    );
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: `\`/implement\` 执行失败：${msg}`,
          en: `\`/implement\` failed: ${msg}`,
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
// Suggestion extraction
// ---------------------------------------------------------------------------

interface ParsedSuggestion {
  commentId: number;
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

const SUGGESTION_BLOCK_RE = /```suggestion\n([\s\S]*?)```/g;

function extractPendingSuggestions(
  comments: GitHubReviewCommentSummary[],
): ParsedSuggestion[] {
  const results: ParsedSuggestion[] = [];

  for (const comment of comments) {
    const body = comment.body ?? "";
    const path = comment.path;
    const endLine = comment.line;
    if (!path || typeof endLine !== "number") {
      continue;
    }

    const startLine =
      typeof comment.start_line === "number" ? comment.start_line : endLine;

    const matches = body.matchAll(SUGGESTION_BLOCK_RE);
    for (const match of matches) {
      const replacement = match[1] ?? "";
      results.push({
        commentId: comment.id,
        path,
        startLine,
        endLine,
        replacement,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Group suggestions by file path (order: bottom-to-top for safe replacement)
// ---------------------------------------------------------------------------

function groupSuggestionsByPath(
  suggestions: ParsedSuggestion[],
): Map<string, ParsedSuggestion[]> {
  const map = new Map<string, ParsedSuggestion[]>();
  for (const s of suggestions) {
    const list = map.get(s.path) ?? [];
    list.push(s);
    map.set(s.path, list);
  }
  // Sort within each file: bottom-to-top to avoid line drift
  for (const list of map.values()) {
    list.sort((a, b) => b.endLine - a.endLine);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Apply suggestions to a single file
// ---------------------------------------------------------------------------

async function applySuggestionsToFile(params: {
  octokit: {
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{
        data:
          | { type?: string; content?: string; encoding?: string; sha?: string }
          | unknown[];
      }>;
      createOrUpdateFileContents?(params: {
        [key: string]: unknown;
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        sha?: string;
        branch?: string;
      }): Promise<unknown>;
    };
  };
  owner: string;
  repo: string;
  path: string;
  branch: string;
  suggestions: ParsedSuggestion[];
}): Promise<{ applied: number; skipped: number }> {
  const { octokit, owner, repo, path, branch, suggestions } = params;

  const response = await octokit.repos.getContent({ owner, repo, path, ref: branch });
  const data = response.data;
  if (Array.isArray(data) || !data.content) {
    throw new Error("file not found or is a directory");
  }

  const fileSha = (data as { sha?: string }).sha;
  const content = decodeGitHubFileContent(
    data.content,
    (data as { encoding?: string }).encoding,
  );
  let lines = content.split("\n");
  let applied = 0;
  let skipped = 0;

  // suggestions are already sorted bottom-to-top
  for (const suggestion of suggestions) {
    const { startLine, endLine, replacement } = suggestion;
    if (startLine < 1 || endLine < startLine || endLine > lines.length) {
      skipped++;
      continue;
    }

    const replacementLines = replacement.endsWith("\n")
      ? replacement.slice(0, -1).split("\n")
      : replacement.split("\n");

    lines = [
      ...lines.slice(0, startLine - 1),
      ...replacementLines,
      ...lines.slice(endLine),
    ];
    applied++;
  }

  if (applied === 0) {
    return { applied: 0, skipped };
  }

  const newContent = lines.join("\n");
  await octokit.repos.createOrUpdateFileContents!({
    owner,
    repo,
    path,
    message: `refactor: apply ${applied} AI suggestion(s) to ${path}`,
    content: Buffer.from(newContent, "utf8").toString("base64"),
    sha: fileSha,
    branch,
  });

  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Collect all review comments with pagination
// ---------------------------------------------------------------------------

async function collectAllReviewComments(
  octokit: {
    pulls: {
      listReviewComments?(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: GitHubReviewCommentSummary[] }>;
    };
  },
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<GitHubReviewCommentSummary[]> {
  const all: GitHubReviewCommentSummary[] = [];
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const response = await octokit.pulls.listReviewComments!({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    all.push(...response.data);
    if (response.data.length < 100) {
      break;
    }
    page++;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Summary message
// ---------------------------------------------------------------------------

function buildImplementSummary(params: {
  applied: number;
  skipped: number;
  errors: string[];
  locale: UiLocale;
}): string {
  const { applied, skipped, errors, locale } = params;

  if (locale === "zh") {
    const parts = [`### /implement 执行结果`, "", `- 已应用：${applied} 个建议`];
    if (skipped > 0) {
      parts.push(`- 跳过：${skipped} 个（行号越界或文件读取失败）`);
    }
    if (errors.length > 0) {
      parts.push("", "**错误：**", ...errors.map((e) => `- ${e}`));
    }
    return parts.join("\n");
  }

  const parts = [`### /implement Results`, "", `- Applied: ${applied} suggestion(s)`];
  if (skipped > 0) {
    parts.push(`- Skipped: ${skipped} (line out of range or file read error)`);
  }
  if (errors.length > 0) {
    parts.push("", "**Errors:**", ...errors.map((e) => `- ${e}`));
  }
  return parts.join("\n");
}
