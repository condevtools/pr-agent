import type { GitHubReviewRunParams } from "../platforms/github/contracts.js";
import type { GitLabReviewRunParams } from "../platforms/gitlab/workflow.js";
import { gitLabApiRequest } from "../../integrations/gitlab/api/http-client.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { enqueueReviewRun, type GitHubDeferredRunHandoff } from "./run-intake.js";
import type { GitHubPullSummary } from "../../integrations/github/api/types.js";
import type { ReviewRunInput } from "./run-input.js";
import { bindingAllowsCapability, type ReviewWorkflow } from "../../agent-runtime/runtime/capabilities.js";

function options(input: GitHubReviewRunParams | GitLabReviewRunParams): ReviewRunInput["options"] {
  return {
    customRules: input.customRules ?? [], includeCiChecks: input.includeCiChecks ?? true,
    enableSecretScan: input.enableSecretScan ?? true, secretScanCustomPatterns: input.secretScanCustomPatterns ?? [],
    enableAutoLabel: input.enableAutoLabel ?? true,
  };
}

export async function enqueueGitHubReviewForBinding(params: GitHubReviewRunParams, binding: PublicationBinding,
  deferred?: { handoff: GitHubDeferredRunHandoff; pull: GitHubPullSummary }): Promise<string> {
  if (!params.sourceKey || !params.sourceHash) throw new Error("Durable review intake requires authenticated source identity");
  const { owner, repo } = params.context.repo();
  const pull = deferred?.pull
    ?? (await params.context.octokit.pulls.get({ owner, repo, pull_number: params.pullNumber })).data;
  const run = await enqueueReviewRun(binding, {
    schemaVersion: 1, workflow: providerReviewWorkflow(binding), platform: "github",
    target: { origin: binding.origin, repository: binding.repository, number: params.pullNumber, providerRepositoryId: binding.providerRepositoryId },
    source: { key: params.sourceKey, hash: params.sourceHash },
    revision: { baseSha: pull.base.sha, headSha: pull.head.sha },
    mode: params.mode, trigger: params.trigger, options: options(params),
    presentation: { title: pull.title, body: pull.body ?? "", author: pull.user?.login ?? "unknown",
      baseBranch: pull.base.ref, headBranch: pull.head.ref, webUrl: pull.html_url, draft: Boolean(pull.draft) },
  }, params.runActor, deferred?.handoff);
  return run.id;
}

export async function enqueueGitLabReviewForBinding(
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
    schemaVersion: 1, workflow: providerReviewWorkflow(binding), platform: "gitlab",
    target: { origin: binding.origin, repository: binding.repository, number, providerRepositoryId: binding.providerRepositoryId },
    source, revision: { baseSha: metadata.diff_refs.base_sha, headSha: metadata.diff_refs.head_sha },
    mode, trigger: params.trigger ?? "gitlab-webhook", options: options(params),
    presentation: { title: attributes.title, body: attributes.description ?? "", author: params.payload.user?.username ?? "unknown",
      baseBranch: attributes.target_branch, headBranch: attributes.source_branch, webUrl: attributes.url,
      draft: Boolean(attributes.draft || attributes.work_in_progress) },
  }, params.runActor);
  return run.id;
}

export function providerReviewWorkflow(binding: PublicationBinding): ReviewWorkflow {
  return binding.capabilities.defaultReviewWorkflow === "review.deep.v1"
    && bindingAllowsCapability(binding, "review.deep")
    ? "review.deep.v1"
    : "review.single.v1";
}
