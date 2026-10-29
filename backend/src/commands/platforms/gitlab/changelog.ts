import { localizeText, readStringEnv, resolveUiLocale } from "#core";
import { gitLabApiRequest } from "../../../integrations/gitlab/api/http-client.js";
import type { GitLabCollectedContext } from "../../../integrations/gitlab/repository/contracts.js";
import { mergeChangelogContent as mergeSharedChangelogContent } from "../../presentation/changelog.js";

export async function updateGitLabMergeRequestDescription(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  description: string;
}): Promise<void> {
  const response = await gitLabApiRequest({
    url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/merge_requests/${params.collected.mrId}`,
    token: params.gitlabToken,
    method: "PUT",
    body: {
      description: params.description,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to update GitLab MR description (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}


export async function applyGitLabChangelogUpdate(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const locale = resolveUiLocale();
  const path = readStringEnv("GITLAB_CHANGELOG_PATH", "CHANGELOG.md");
  let existing = "";
  let action: "create" | "update" = "create";

  try {
    const response = await gitLabApiRequest({
      url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(params.collected.sourceBranch)}`,
      token: params.gitlabToken,
    });
    if (response.ok) {
      existing = await response.text();
      action = "update";
    }
  } catch {
    // create new file fallback
  }

  const merged = mergeGitLabChangelogContent(
    existing,
    params.draft,
    `MR !${params.pullNumber}`,
  );
  const commitResponse = await gitLabApiRequest({
    url: `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/repository/commits`,
    token: params.gitlabToken,
    method: "POST",
    body: {
      branch: params.collected.sourceBranch,
      commit_message: `chore(changelog): update from MR !${params.pullNumber}`,
      actions: [
        {
          action,
          file_path: path,
          content: merged,
        },
      ],
    },
  });
  if (!commitResponse.ok) {
    const text = await commitResponse.text();
    throw new Error(
      `Failed to update GitLab CHANGELOG (${commitResponse.status}): ${text.slice(0, 300)}`,
    );
  }

  return {
    message: localizeText(
      {
        zh: `已写入 \`${path}\`（branch: \`${params.collected.sourceBranch}\`）。`,
        en: `Written to \`${path}\` (branch: \`${params.collected.sourceBranch}\`).`,
      },
      locale,
    ),
  };
}

export function mergeGitLabChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  return mergeSharedChangelogContent(currentContent, draft, title);
}
