import { z } from "zod";

import type { PublicationBinding } from "./authority.js";
import { RunControlError } from "./run-control-contracts.js";
import { reviewRunInputSchema, type ReviewRunInput } from "./review-run-input.js";
import { publicationRuntimeForBinding } from "./runtime.js";
import { createRestBackedOctokit } from "../integrations/github/github-rest-client.js";
import { gitLabApiRequest } from "../integrations/gitlab/gitlab-http.js";

export const createReviewRequestSchema = z.object({
  number: z.number().int().positive(), mode: z.enum(["report", "comment"]).default("report"),
  options: reviewRunInputSchema.shape.options.default({ customRules: [], includeCiChecks: true,
    enableSecretScan: true, secretScanCustomPatterns: [], enableAutoLabel: true }),
}).strict();
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;

/** Only the trusted integration controls provider/repository/credentials. */
export async function resolveApiReviewInput(binding: PublicationBinding, request: CreateReviewRequest,
  source: ReviewRunInput["source"]): Promise<ReviewRunInput> {
  const runtime = await publicationRuntimeForBinding(binding);
  const credential = await runtime.resolveCredential();
  const base = { schemaVersion: 1 as const, workflow: "review.single.v1" as const, platform: binding.platform,
    target: { origin: binding.origin, repository: binding.repository, number: request.number,
      providerRepositoryId: binding.providerRepositoryId }, source, mode: request.mode,
    trigger: "comment-command" as const, options: request.options };
  if (binding.platform === "github") {
    const [owner, repo, extra] = binding.repository.split("/");
    if (!owner || !repo || extra) throw new Error("Invalid configured GitHub repository");
    const client = createRestBackedOctokit({ token: credential, baseUrl: binding.origin });
    const { data: pull } = await client.pulls.get({ owner, repo, pull_number: request.number });
    return reviewRunInputSchema.parse({ ...base, revision: { baseSha: pull.base.sha, headSha: pull.head.sha },
      presentation: { title: pull.title, body: pull.body ?? "", author: pull.user?.login ?? "unknown",
        baseBranch: pull.base.ref, headBranch: pull.head.ref, webUrl: pull.html_url, draft: Boolean(pull.draft) } });
  }
  const response = await gitLabApiRequest({
    url: `${binding.origin}/api/v4/projects/${binding.providerRepositoryId}/merge_requests/${request.number}`, token: credential,
  });
  if (!response.ok) throw new RunControlError("PROVIDER_LOOKUP_FAILED", 502, "Unable to resolve the merge request revision");
  const value = z.object({
    title: z.string(), description: z.string().nullable().optional(), author: z.object({ username: z.string() }),
    source_branch: z.string(), target_branch: z.string(), web_url: z.string(), draft: z.boolean().optional(),
    diff_refs: z.object({ base_sha: z.string().min(1), head_sha: z.string().min(1) }),
  }).parse(await response.json());
  return reviewRunInputSchema.parse({ ...base,
    revision: { baseSha: value.diff_refs.base_sha, headSha: value.diff_refs.head_sha },
    presentation: { title: value.title, body: value.description ?? "", author: value.author.username,
      baseBranch: value.target_branch, headBranch: value.source_branch, webUrl: value.web_url, draft: Boolean(value.draft) } });
}
