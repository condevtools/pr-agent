import { encodePath, fetchWithRetry } from "@mr-agent/core";
import {
  type GitHubCheckRunSummary,
  type GitHubIssueSummary,
  type GitHubPullFile,
  type GitHubPullFilesListParams,
  type GitHubPullsListFilesMethod,
  type GitHubPullSummary,
  type GitHubRepositoryContentFile,
  type GitHubReviewCommentSummary,
  type MinimalGitHubOctokit,
} from "./github-review.js";
import { buildGitHubHttpRetryOptions } from "@mr-agent/shared/http-retry-options.js";

const MAX_LIST_FILES_TRUNCATED_RECORDS = 500;

interface RestGitHubClientConfig {
  token: string;
  baseUrl: string;
}

interface RestGitHubRequestParams {
  method: "GET" | "POST" | "PATCH" | "PUT";
  path: string;
  body?: unknown;
}

export function createRestBackedOctokit(
  config: RestGitHubClientConfig,
): MinimalGitHubOctokit {
  let lastListPullFilesTruncated = false;
  const listPullFilesTruncated = new Map<string, boolean>();
  const updateListFilesTruncated = (
    params: GitHubPullFilesListParams,
    truncated: boolean,
  ) => {
    const key = buildListPullFilesTruncatedKey(params);
    listPullFilesTruncated.set(key, truncated);
    while (listPullFilesTruncated.size > MAX_LIST_FILES_TRUNCATED_RECORDS) {
      const oldest = listPullFilesTruncated.keys().next();
      if (oldest.done) {
        break;
      }
      listPullFilesTruncated.delete(oldest.value);
    }
    lastListPullFilesTruncated = truncated;
  };

  const listFiles: GitHubPullsListFilesMethod = async (params) => {
    const result = await listPullFiles(config, params);
    updateListFilesTruncated(params, result.truncated);
    return {
      data: result.files,
    };
  };

  return {
    repos: {
      getContent: async (params) => {
        const encodedPath = encodePath(params.path);
        const query = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
        const data = await requestJsonRequired<
          GitHubRepositoryContentFile | GitHubRepositoryContentFile[]
        >(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${encodedPath}${query}`,
        });
        return { data };
      },
      compareCommits: async (params) => {
        const data = await requestJsonRequired<{ files?: GitHubPullFile[] }>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/compare/${encodeURIComponent(params.base as string)}...${encodeURIComponent(params.head as string)}`,
        });
        return { data };
      },
      createOrUpdateFileContents: async (params) => {
        await requestJsonOptional(config, {
          method: "PUT",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/contents/${encodePath(params.path as string)}`,
          body: {
            message: params.message,
            content: params.content,
            sha: params.sha,
            branch: params.branch,
          },
        });
        return {};
      },
    },
    pulls: {
      listFiles,
      get: async (params) => {
        const data = await requestJsonRequired<GitHubPullSummary>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}`,
        });
        return { data };
      },
      createReviewComment: async (params) => {
        await requestJsonOptional(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}/comments`,
          body: {
            body: params.body,
            commit_id: params.commit_id,
            path: params.path,
            line: params.line,
            side: params.side,
          },
        });
        return {};
      },
      update: async (params) => {
        await requestJsonOptional(config, {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}`,
          body: {
            body: params.body,
          },
        });
        return {};
      },
      listReviewComments: async (params) => {
        const perPage = Math.max(1, Math.min(Number(params.per_page ?? 100), 100));
        const page = Math.max(1, Number(params.page ?? 1));
        const data = await requestJsonRequired<GitHubReviewCommentSummary[]>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}/comments?per_page=${perPage}&page=${page}`,
        });
        return {
          data: Array.isArray(data)
            ? data.map((item) => ({
                id: Number(item.id),
                body: typeof item.body === "string" ? item.body : null,
                path: typeof item.path === "string" ? item.path : null,
                line: typeof item.line === "number" ? item.line : null,
                start_line: typeof item.start_line === "number" ? item.start_line : null,
                commit_id: typeof item.commit_id === "string" ? item.commit_id : null,
                user: item.user ?? null,
              }))
            : [],
        };
      },
    },
    issues: {
      listForRepo: async (params) => {
        const state = params.state ?? "all";
        const sort = params.sort ?? "updated";
        const direction = params.direction ?? "desc";
        const perPage = Math.max(1, Math.min(Number(params.per_page ?? 100), 100));
        const page = Math.max(1, Number(params.page ?? 1));
        const data = await requestJsonRequired<GitHubIssueSummary[]>(config, {
          method: "GET",
          path:
            `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues` +
            `?state=${encodeURIComponent(state)}` +
            `&sort=${encodeURIComponent(sort)}` +
            `&direction=${encodeURIComponent(direction)}` +
            `&per_page=${perPage}` +
            `&page=${page}`,
        });
        return {
          data: Array.isArray(data)
            ? data.map((item) => ({
                number: Number(item.number),
                title: typeof item.title === "string" ? item.title : null,
                body: typeof item.body === "string" ? item.body : null,
                state: typeof item.state === "string" ? item.state : null,
                html_url:
                  typeof item.html_url === "string" ? item.html_url : null,
                pull_request: item.pull_request,
              }))
            : [],
        };
      },
      listComments: async (params) => {
        const data = await requestJsonRequired<Array<{ id: number; body?: string | null }>>(
          config,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.issue_number}/comments?per_page=${Math.max(1, Math.min(Number(params.per_page ?? 100), 100))}&page=${Math.max(1, Number(params.page ?? 1))}`,
          },
        );
        return {
          data: Array.isArray(data)
            ? data.map((item) => ({
                id: Number(item.id),
                body: typeof item.body === "string" ? item.body : undefined,
              }))
            : [],
        };
      },
      createComment: async (params) => {
        const data = await requestJsonRequired<{ id: number }>(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.issue_number}/comments`,
          body: {
            body: params.body,
          },
        });
        return { data };
      },
      updateComment: async (params) => {
        await requestJsonOptional(config, {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/comments/${params.comment_id}`,
          body: {
            body: params.body,
          },
        });
        return {};
      },
      addLabels: async (params) => {
        await requestJsonOptional(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/issues/${params.issue_number}/labels`,
          body: {
            labels: params.labels,
          },
        });
        return {};
      },
    },
    checks: {
      create: async (params) => {
        await requestJsonOptional(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/check-runs`,
          body: {
            name: params.name,
            head_sha: params.head_sha,
            details_url: params.details_url,
            status: params.status,
            conclusion: params.conclusion,
            completed_at: params.completed_at,
            output: params.output,
          },
        });
        return {};
      },
      listForRef: async (params) => {
        const data = await requestJsonRequired<{ check_runs?: GitHubCheckRunSummary[] }>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/commits/${encodeURIComponent(params.ref as string)}/check-runs?per_page=${Math.max(1, Math.min(Number(params.per_page ?? 100), 100))}`,
        });
        return {
          data: {
            check_runs: Array.isArray(data.check_runs)
              ? data.check_runs
              : [],
          },
        };
      },
    },
    paginate: async (_method, params) => {
      const result = await listPullFiles(config, params);
      updateListFilesTruncated(params, result.truncated);
      return result.files;
    },
    getListFilesTruncated: (params) =>
      listPullFilesTruncated.get(buildListPullFilesTruncatedKey(params)) ?? false,
    getLastListFilesTruncated: () => lastListPullFilesTruncated,
  };
}

function buildListPullFilesTruncatedKey(params: GitHubPullFilesListParams): string {
  const perPage = Math.max(1, Math.min(Number(params.per_page ?? 100), 100));
  return [
    params.owner.trim().toLowerCase(),
    params.repo.trim().toLowerCase(),
    String(params.pull_number),
    String(perPage),
  ].join("|");
}

async function listPullFiles(
  config: RestGitHubClientConfig,
  params: {
    owner: string;
    repo: string;
    pull_number: number;
    per_page: number;
  },
): Promise<{ files: GitHubPullFile[]; truncated: boolean }> {
  const perPage = Math.max(1, Math.min(params.per_page, 100));
  const items: GitHubPullFile[] = [];
  let truncated = false;

  let page = 1;
  while (page <= 20) {
    const pageItems = await requestJsonRequired<GitHubPullFile[]>(config, {
      method: "GET",
      path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}/files?per_page=${perPage}&page=${page}`,
    });

    items.push(...pageItems);
    if (pageItems.length < perPage) {
      break;
    }
    if (page === 20) {
      truncated = true;
      break;
    }

    page += 1;
  }

  return {
    files: items,
    truncated,
  };
}

async function requestJsonRequired<T = unknown>(
  config: RestGitHubClientConfig,
  params: RestGitHubRequestParams,
): Promise<T> {
  const data = await requestJsonOptional<T>(config, params);
  if (typeof data === "undefined") {
    throw new Error(
      `GitHub API ${params.method} ${params.path} expected JSON body but response was empty`,
    );
  }

  return data;
}

async function requestJsonOptional<T = unknown>(
  config: RestGitHubClientConfig,
  params: RestGitHubRequestParams,
): Promise<T | undefined> {
  const response = await requestResponse(config, params);
  if (response.status === 204) {
    return undefined;
  }

  const raw = await response.text();
  if (!raw.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `GitHub API ${params.method} ${params.path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function requestResponse(
  config: RestGitHubClientConfig,
  params: RestGitHubRequestParams,
): Promise<Response> {
  const response = await fetchWithRetry(
    `${config.baseUrl}${params.path}`,
    {
      method: params.method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "mr-agent-webhook-client",
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    },
    buildGitHubHttpRetryOptions(),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${params.method} ${params.path} failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  return response;
}
