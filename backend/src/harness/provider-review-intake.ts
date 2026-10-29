import type { GitHubReviewRunParams } from "../integrations/github/github-review-types.js";
import type { GitLabReviewRunParams } from "../integrations/gitlab/gitlab-review.js";
import { gitLabApiRequest } from "../integrations/gitlab/gitlab-http.js";
import type { PublicationBinding } from "./authority.js";
import { enqueueReviewRun } from "./review-run-intake.js";
import type { ReviewRunInput } from "./review-run-input.js";

function options(input: GitHubReviewRunParams | GitLabReviewRunParams): ReviewRunInput["options"] {
  return {
    customRules: input.customRules ?? [], includeCiChecks: input.includeCiChecks ?? true,
    enableSecretScan: input.enableSecretScan ?? true, secretScanCustomPatterns: input.secretScanCustomPatterns ?? [],
    enableAutoLabel: input.enableAutoLabel ?? true,
  };
}

export async function enqueueGitHubReview(params: GitHubReviewRunParams, binding: PublicationBinding): Promise<string> {
  if (!params.sourceKey || !params.sourceHash) throw new Error("Durable review intake requires authenticated source identity");
  const { owner, repo } = params.context.repo();
  const { data: pull } = await params.context.octokit.pulls.get({ owner, repo, pull_number: params.pullNumber });
  const run = await enqueueReviewRun(binding, {
    schemaVersion: 1, workflow: "review.single.v1", platform: "github",
    target: { origin: binding.origin, repository: binding.repository, number: params.pullNumber, providerRepositoryId: binding.providerRepositoryId },
    source: { key: params.sourceKey, hash: params.sourceHash },
    revision: { baseSha: pull.base.sha, headSha: pull.head.sha },
    mode: params.mode, trigger: params.trigger, options: options(params),
    presentation: { title: pull.title, body: pull.body ?? "", author: pull.user?.login ?? "unknown",
      baseBranch: pull.base.ref, headBranch: pull.head.ref, webUrl: pull.html_url, draft: Boolean(pull.draft) },
  });
  return run.id;
}

export async function enqueueGitLabReview(
  params: GitLabReviewRunParams,
  binding: PublicationBinding,
  source: ReviewRunInput["source"],
  mode: ReviewRunInput["mode"],
  token: string,
): Promise<string> {
  const number = params.payload.object_attributes.iid;
  const response = await gitLabApiRequest({
    url: `${binding.origin}/api/v4/projects/${binding.providerRepositoryId}/merge_requests/${number}`,
    token,
  });
  if (!response.ok) throw new Error(`GitLab revision lookup failed (${response.status})`);
  const metadata = await response.json() as { diff_refs?: { base_sha?: string; head_sha?: string } };
  if (!metadata.diff_refs?.base_sha || !metadata.diff_refs.head_sha) throw new Error("GitLab immutable review revisions are unavailable");
  const attributes = params.payload.object_attributes;
  const run = await enqueueReviewRun(binding, {
    schemaVersion: 1, workflow: "review.single.v1", platform: "gitlab",
    target: { origin: binding.origin, repository: binding.repository, number, providerRepositoryId: binding.providerRepositoryId },
    source, revision: { baseSha: metadata.diff_refs.base_sha, headSha: metadata.diff_refs.head_sha },
    mode, trigger: params.trigger ?? "gitlab-webhook", options: options(params),
    presentation: { title: attributes.title, body: attributes.description ?? "", author: params.payload.user?.username ?? "unknown",
      baseBranch: attributes.target_branch, headBranch: attributes.source_branch, webUrl: attributes.url,
      draft: Boolean(attributes.draft || attributes.work_in_progress) },
  });
  return run.id;
}
