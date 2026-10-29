import { gitLabApiRequest } from "../api/http-client.js";
import type { GitLabChange, GitLabCompareResponse } from "./contracts.js";

export async function loadGitLabIncrementalChanges(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  incrementalBaseSha: string;
  headSha: string;
}): Promise<GitLabChange[]> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/compare?from=${encodeURIComponent(params.incrementalBaseSha)}&to=${encodeURIComponent(params.headSha)}`,
      token: params.gitlabToken,
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as GitLabCompareResponse;
  return Array.isArray(data.diffs) ? data.diffs : [];
}
