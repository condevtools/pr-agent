import { localizeText, type UiLocale } from "@mr-agent/core";

export interface SimilarIssueMatch {
  id: number | string;
  title: string;
  url: string;
  state?: string | null;
  score: number;
  matchedTerms: string[];
}

export function resolveSimilarIssueQuery(params: {
  query: string;
  title?: string | null;
  description?: string | null;
}): string {
  const fromCommand = params.query.trim();
  if (fromCommand) {
    return fromCommand;
  }

  return [params.title ?? "", params.description ?? ""].join(" ").trim();
}

export function buildSimilarIssueQueryMissingMessage(locale: UiLocale): string {
  return localizeText(
    {
      zh: "无法提取用于相似 Issue 检索的查询文本，请在命令后追加关键词，例如：`/similar_issue timeout race condition`。",
      en: "Unable to derive a search query for similar issues. Add keywords, for example: `/similar_issue timeout race condition`.",
    },
    locale,
  );
}

export function buildSimilarIssueComment(
  query: string,
  matches: SimilarIssueMatch[],
  locale: UiLocale,
): string {
  if (matches.length === 0) {
    return localizeText(
      {
        zh:
          "## AI Similar Issue Finder\n\n未发现高相关 Issue。\n\n可尝试提供更具体关键词，例如：`/similar_issue auth token refresh race`。",
        en:
          "## AI Similar Issue Finder\n\nNo highly related issues found.\n\nTry more specific keywords, for example: `/similar_issue auth token refresh race`.",
      },
      locale,
    );
  }

  return [
    "## AI Similar Issue Finder",
    "",
    `${localizeText({ zh: "查询", en: "Query" }, locale)}: \`${query}\``,
    "",
    ...matches.map((item, index) => {
      const terms = item.matchedTerms.length > 0 ? item.matchedTerms.join(", ") : "-";
      const state = (item.state ?? "unknown").toString();
      return `${index + 1}. [#${item.id}](${item.url}) ${item.title} (state=${state}, score=${item.score}, terms=${terms})`;
    }),
  ].join("\n");
}
