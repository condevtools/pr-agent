import { readOptionalStringEnv, type UiLocale } from "#core";
import { findSimilarIssues } from "../../../issues/similarity/scorer.js";
import { buildSimilarIssueComment, buildSimilarIssueQueryMissingMessage, resolveSimilarIssueQuery } from "../../../issues/similarity/presentation.js";
import { gitLabApiRequest } from "../../../integrations/gitlab/api/http-client.js";
import { buildGitLabCommentTargetFromPayload } from "../../../integrations/gitlab/repository/context.js";
import type { GitLabMrWebhookBody } from "../../../integrations/gitlab/webhooks/contracts.js";
import { publishGitLabGeneralComment } from "../../../review/platforms/gitlab/publication.js";

export async function runGitLabSimilarIssueCommand(params: {
  payload: GitLabMrWebhookBody;
  gitlabToken: string;
  query: string;
  locale: UiLocale;
}): Promise<void> {
  const target = buildGitLabCommentTargetFromPayload({
    payload: params.payload,
    baseUrl: readOptionalStringEnv("GITLAB_BASE_URL"),
  });
  const query = resolveSimilarIssueQuery({
    query: params.query,
    title: params.payload.object_attributes.title,
    description: params.payload.object_attributes.description,
  });
  if (!query) {
    await publishGitLabGeneralComment(
      params.gitlabToken,
      target,
      buildSimilarIssueQueryMissingMessage(params.locale),
    );
    return;
  }

  const response = await gitLabApiRequest({
    url: `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/issues?state=all&order_by=updated_at&sort=desc&per_page=100`,
    token: params.gitlabToken,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to load GitLab issues (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const rawIssues = (await response.json()) as Array<{
    iid?: number;
    title?: string;
    description?: string;
    state?: string;
    web_url?: string;
  }>;
  const candidates = rawIssues
    .map((issue) => ({
      id: issue.iid ?? 0,
      title: issue.title ?? "",
      body: issue.description ?? "",
      url: issue.web_url ?? "",
      state: issue.state,
    }))
    .filter((issue) => issue.id > 0)
    .filter((issue) => issue.id !== params.payload.object_attributes.iid)
    .filter((issue) => Boolean(issue.url && issue.title));

  const matches = findSimilarIssues({
    query,
    candidates,
    limit: 5,
  });

  await publishGitLabGeneralComment(
    params.gitlabToken,
    target,
    buildSimilarIssueComment(query, matches, params.locale),
  );
}
