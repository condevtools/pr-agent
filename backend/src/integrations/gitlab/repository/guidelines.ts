import { readNumberEnv } from "#core";
import { GITLAB_GUIDELINE_DIRECTORIES, GITLAB_GUIDELINE_FILE_PATHS, isProcessTemplateFile } from "#review";
import { loadProcessGuidelinesWithCache, type ProcessGuideline } from "../../../repository/process-guidelines.js";
import { gitLabApiRequest } from "../api/http-client.js";

const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const GITLAB_GUIDELINE_CACHE_SCOPE = "gitlab-process-guidelines";

export async function loadGitLabRepositoryProcessGuidelines(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
}): Promise<ProcessGuideline[]> {
  const { baseUrl, projectId, gitlabToken, ref } = params;
  return loadProcessGuidelinesWithCache({
    scope: GITLAB_GUIDELINE_CACHE_SCOPE,
    cacheKey: `${baseUrl}:${projectId}@${ref}`,
    ttlMs: readNumberEnv(
      "GITLAB_GUIDELINE_CACHE_TTL_MS",
      DEFAULT_GUIDELINE_CACHE_TTL_MS,
    ),
    maxEntries: MAX_GUIDELINE_CACHE_ENTRIES,
    filePaths: GITLAB_GUIDELINE_FILE_PATHS,
    directories: GITLAB_GUIDELINE_DIRECTORIES,
    maxGuidelines: MAX_GUIDELINES,
    maxGuidelinesPerDirectory: MAX_GUIDELINES_PER_DIRECTORY,
    isTemplateFile: (path) => isProcessTemplateFile(path, "gitlab"),
    readFile: async (path) =>
      readGitLabGuidelineFile({
        baseUrl,
        projectId,
        gitlabToken,
        ref,
        path,
      }),
    listDirectory: async (path) =>
      listGitLabDirectory({
        baseUrl,
        projectId,
        gitlabToken,
        ref,
        path,
      }),
  });
}

async function readGitLabGuidelineFile(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<ProcessGuideline | undefined> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/files/${encodeURIComponent(params.path)}/raw?ref=${encodeURIComponent(params.ref)}`,
      token: params.gitlabToken,
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const content = (await response.text()).trim();
  if (!content) {
    return undefined;
  }

  return {
    path: params.path,
    content: content.slice(0, 4_000),
  };
}

async function listGitLabDirectory(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<Array<{ path: string; type: string }>> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/tree?path=${encodeURIComponent(params.path)}&ref=${encodeURIComponent(params.ref)}&per_page=20`,
      token: params.gitlabToken,
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as Array<{
    path?: string;
    type?: string;
  }>;

  return data
    .map((item) => ({
      path: item.path ?? "",
      type: item.type ?? "",
    }))
    .filter((item) => Boolean(item.path));
}
