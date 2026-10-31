import { collectGitHubPullRequestContext } from "../integrations/github/repository/context.js";
import { executeGitHubReview } from "./platforms/github/workflow.js";
import { createRestBackedOctokit } from "../integrations/github/api/http-client.js";
import { collectGitLabMergeRequestContext } from "../integrations/gitlab/repository/context.js";
import { executeGitLabReview } from "./platforms/gitlab/workflow.js";
import { GitHubRepositoryReadAdapter } from "../integrations/github/repository/read-adapter.js";
import { GitLabRepositoryReadAdapter } from "../integrations/gitlab/repository/read-adapter.js";
import { currentRunExecutionContext, durableReviewCollection } from "../agent-runtime/execution/run-context.js";
import { executeDeepReviewRun } from "./deep/run.js";
import type { PublicationBinding } from "../agent-runtime/authority/publication-authority.js";
import type { RunLease } from "../agent-runtime/runs/contracts.js";
import { reviewRunInputSchema } from "./intake/run-input.js";
import { publicationRuntimeForBinding } from "../agent-runtime/runtime/publication.js";
import { logCore } from "#core";
import { assertGitHubBindingAccess } from "../integrations/github/onboarding/provider.js";

/** The production worker reuses the same collectors, analyzer, renderers and publisher. */
export async function executeReviewRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const input = reviewRunInputSchema.parse(lease.input);
  if (lease.tenantId !== binding.tenantId || lease.integrationId !== binding.id
      || input.platform !== binding.platform
      || lease.authorityGeneration !== binding.generation || input.target.repository !== binding.repository
      || input.target.origin !== binding.origin || input.target.providerRepositoryId !== binding.providerRepositoryId
      || input.revision.baseSha !== lease.baseSha || input.revision.headSha !== lease.headSha) {
    throw new Error("Durable review binding or revision mismatch");
  }
  const runtime = await publicationRuntimeForBinding(binding);
  await assertGitHubBindingAccess(binding);
  const logger = {
    info: (_metadata: unknown, _message: string) => undefined,
    error: (_metadata: unknown, _message: string) => {
      logCore("error", "review_provider.operation_failed", { runId: lease.runId });
    },
  };
  if (input.platform === "github") {
    const [owner, repo, extra] = input.target.repository.split("/");
    if (!owner || !repo || extra) throw new Error("GitHub repository must have an owner and name");
    const token = await runtime.resolveCredential();
    const octokit = createRestBackedOctokit({ token, baseUrl: binding.origin });
    if (input.workflow === "review.deep.v1") {
      const collected = await durableReviewCollection("github.collect_context.v1", () => collectGitHubPullRequestContext({
        octokit, owner, repo, pullNumber: input.target.number, customRules: input.options.customRules,
        includeCiChecks: input.options.includeCiChecks,
      }));
      await executeDeepReviewRun(collected, new GitHubRepositoryReadAdapter({
        apiBaseUrl: binding.origin, token, owner, repo, headSha: lease.headSha, signal: currentRunExecutionContext()?.signal,
      }));
      return;
    }
    await executeGitHubReview({
      context: { repo: () => ({ owner, repo }), octokit, log: logger },
      pullNumber: input.target.number, mode: input.mode, trigger: input.trigger,
      ...input.options, sourceKey: input.source.key, sourceHash: input.source.hash,
      publicationRuntime: { ...runtime, binding: { ...binding, platform: "github" } }, throwOnError: true,
    });
    return;
  }
  const payload = {
      object_kind: "merge_request" as const, user: { username: input.presentation.author },
      project: { id: binding.providerRepositoryId, name: binding.repository, path_with_namespace: binding.repository,
        web_url: binding.origin },
      object_attributes: { iid: input.target.number, action: "update", state: "opened",
        title: input.presentation.title, description: input.presentation.body,
        url: input.presentation.webUrl, source_branch: input.presentation.headBranch,
        target_branch: input.presentation.baseBranch, draft: input.presentation.draft,
        last_commit: { id: lease.headSha } },
    };
  if (input.workflow === "review.deep.v1") {
    const token = await runtime.resolveCredential();
    const collected = await durableReviewCollection("gitlab.collect_context.v1", () => collectGitLabMergeRequestContext({
      payload, gitlabToken: token, baseUrl: binding.origin, customRules: input.options.customRules,
      includeCiChecks: input.options.includeCiChecks,
    }));
    await executeDeepReviewRun(collected, new GitLabRepositoryReadAdapter({
      baseUrl: binding.origin, token, projectId: binding.providerRepositoryId, headSha: lease.headSha, signal: currentRunExecutionContext()?.signal,
    }));
    return;
  }
  const result = await executeGitLabReview({ payload,
    headers: {}, logger, mode: input.mode, trigger: input.trigger,
    ...input.options, sourceKey: input.source.key, sourceHash: input.source.hash,
    publicationRuntime: { ...runtime, binding: { ...binding, platform: "gitlab" } }, throwOnError: true,
  });
  if (!result.ok) throw new Error("Durable GitLab review did not complete");
}
