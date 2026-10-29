import { runGitHubReview } from "../integrations/github/github-review.js";
import { createRestBackedOctokit } from "../integrations/github/github-rest-client.js";
import { runGitLabReview } from "../integrations/gitlab/gitlab-review.js";
import type { PublicationBinding } from "./authority.js";
import type { RunLease } from "./run-contracts.js";
import { reviewRunInputSchema } from "./review-run-input.js";
import { publicationRuntimeForBinding } from "./runtime.js";

/** The production worker reuses the same collectors, analyzer, renderers and publisher. */
export async function executeSingleReviewRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const input = reviewRunInputSchema.parse(lease.input);
  if (lease.tenantId !== binding.tenantId || lease.integrationId !== binding.id
      || input.platform !== binding.platform
      || lease.authorityGeneration !== binding.generation || input.target.repository !== binding.repository
      || input.target.origin !== binding.origin || input.target.providerRepositoryId !== binding.providerRepositoryId
      || input.revision.baseSha !== lease.baseSha || input.revision.headSha !== lease.headSha) {
    throw new Error("Durable review binding or revision mismatch");
  }
  const runtime = await publicationRuntimeForBinding(binding);
  const logger = {
    info: (_metadata: unknown, _message: string) => undefined,
    error: (_metadata: unknown, _message: string) => {
      process.emitWarning(`Durable review provider operation failed for Run ${lease.runId}`);
    },
  };
  if (input.platform === "github") {
    const [owner, repo, extra] = input.target.repository.split("/");
    if (!owner || !repo || extra) throw new Error("GitHub repository must have an owner and name");
    const octokit = createRestBackedOctokit({ token: await runtime.resolveCredential(), baseUrl: binding.origin });
    await runGitHubReview({
      context: { repo: () => ({ owner, repo }), octokit, log: logger },
      pullNumber: input.target.number, mode: input.mode, trigger: input.trigger,
      ...input.options, sourceKey: input.source.key, sourceHash: input.source.hash,
      publicationRuntime: { ...runtime, binding: { ...binding, platform: "github" } }, throwOnError: true,
    });
    return;
  }
  const result = await runGitLabReview({
    payload: {
      object_kind: "merge_request", user: { username: input.presentation.author },
      project: { id: binding.providerRepositoryId, name: binding.repository, path_with_namespace: binding.repository,
        web_url: binding.origin },
      object_attributes: { iid: input.target.number, action: "update", state: "opened",
        title: input.presentation.title, description: input.presentation.body,
        url: input.presentation.webUrl, source_branch: input.presentation.headBranch,
        target_branch: input.presentation.baseBranch, draft: input.presentation.draft,
        last_commit: { id: lease.headSha } },
    },
    headers: {}, logger, mode: input.mode, trigger: input.trigger,
    ...input.options, sourceKey: input.source.key, sourceHash: input.source.hash,
    publicationRuntime: { ...runtime, binding: { ...binding, platform: "gitlab" } }, throwOnError: true,
  });
  if (!result.ok) throw new Error("Durable GitLab review did not complete");
}
