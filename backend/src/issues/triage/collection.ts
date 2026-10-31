import type { MinimalGitHubOctokit } from "../../integrations/github/api/types.js";
import { findSimilarIssues, type SimilarIssueMatch } from "../similarity/scorer.js";
import { resolveSimilarIssueQuery } from "../similarity/presentation.js";

const ISSUE_PAGE_SIZE = 100;
const LABEL_PAGE_SIZE = 100;
const LABEL_PAGE_CAP = 3;

export interface IssueTriageCollection {
  similar: SimilarIssueMatch[];
  repositoryLabels: string[];
  labelsComplete: boolean;
  coverage: {
    issuesCandidateCount: number;
    issuesTruncated: boolean;
    labelsPages: number;
    labelsTruncated: boolean;
  };
}

export async function collectIssueTriageContext(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
}): Promise<IssueTriageCollection> {
  const issues = params.octokit.issues.listForRepo
    ? await params.octokit.issues.listForRepo({ owner: params.owner, repo: params.repo,
      state: "all", sort: "updated", direction: "desc", per_page: ISSUE_PAGE_SIZE, page: 1 })
    : { data: [] };
  const candidates = issues.data
    .filter((item) => !item.pull_request && item.number !== params.issueNumber)
    .filter((item) => typeof item.title === "string" && item.title.trim()
      && typeof item.html_url === "string" && item.html_url)
    .map((item) => ({ id: item.number, title: item.title!, body: item.body, url: item.html_url!, state: item.state }));
  const query = resolveSimilarIssueQuery({ query: "", title: params.title, description: params.body });
  const labels = await collectRepositoryLabels(params.octokit, params.owner, params.repo);
  return {
    // The shared scorer gives open Issues a state bonus. That bonus alone is not relevance.
    similar: query ? findSimilarIssues({ query, candidates, limit: 5 })
      .filter((match) => match.matchedTerms.length > 0 || match.score > 1) : [],
    repositoryLabels: labels.names,
    labelsComplete: labels.complete,
    coverage: {
      issuesCandidateCount: candidates.length,
      issuesTruncated: issues.data.length === ISSUE_PAGE_SIZE,
      labelsPages: labels.pages,
      labelsTruncated: !labels.complete,
    },
  };
}

async function collectRepositoryLabels(
  octokit: MinimalGitHubOctokit,
  owner: string,
  repo: string,
): Promise<{ names: string[]; complete: boolean; pages: number }> {
  const list = octokit.issues.listLabelsForRepo;
  if (!list) return { names: [], complete: false, pages: 0 };
  const names = new Map<string, string>();
  for (let page = 1; page <= LABEL_PAGE_CAP; page += 1) {
    const result = await list({ owner, repo, per_page: LABEL_PAGE_SIZE, page });
    for (const label of result.data) {
      const name = label.name.trim();
      if (name) names.set(name.toLocaleLowerCase("en-US"), name);
    }
    if (result.data.length < LABEL_PAGE_SIZE) {
      return { names: [...names.values()], complete: true, pages: page };
    }
  }
  return { names: [...names.values()], complete: false, pages: LABEL_PAGE_CAP };
}
