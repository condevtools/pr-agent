import { z } from "zod";
import { BadWebhookRequestError, githubOnboardingEnabled, logCore, resolveGitHubOnboardingOrigin } from "#core";
import type { DeferredPullRequestClaim, GitHubInstallationSyncStore } from "../../../agent-runtime/authority/github-installation-sync.js";
import type { PublicationAuthorityStore, PublicationBinding } from "../../../agent-runtime/authority/publication-authority.js";
import { getAgentRuntimeServices } from "../../../agent-runtime/runtime/services.js";
import { getSharedGitHubProbot } from "../../../agent-runtime/runtime/credentials.js";
import { enqueueGitHubReviewForBinding } from "../../../review/intake/provider-intake.js";
import { GitHubDeliveryHandoffError } from "../../../review/intake/github-delivery-handoff.js";
import type { GitHubReviewContext } from "../../../review/platforms/github/contracts.js";
import { resolveGitHubPullRequestAutoReviewPolicy, resolveGitHubReviewBehaviorPolicy } from "../../../issues/policy/github/workflow.js";
import { assertGitHubBindingAccess } from "./provider.js";
import { guardGitHubOctokit } from "../api/http-client.js";
import type { GitHubPullSummary, MinimalGitHubOctokit } from "../api/types.js";
import { incrementMetricCounter } from "../../../http/system/metrics-runtime.js";

const id = z.number().int().positive().safe();
const eventSchema = z.object({
  action: z.enum(["opened", "edited", "synchronize", "closed"]),
  installation: z.object({ id, app_id: id.optional() }),
  repository: z.object({ id, name: z.string().regex(/^[a-zA-Z0-9_.-]+$/u),
    owner: z.object({ id, login: z.string().regex(/^[a-zA-Z0-9_.-]+$/u) }) }),
  pull_request: z.object({ number: id, merged: z.boolean().optional() }),
});

/** Called only after authenticated App intake failed to find a usable binding. */
export async function deferGitHubPullRequest(input: {
  eventName: string; runtimeMode: "github-app" | "github-webhook"; payload: unknown;
  deliveryId?: string; sourceHash?: string; env?: NodeJS.ProcessEnv;
}, getStore: () => Promise<Pick<GitHubInstallationSyncStore, "defer">>):
Promise<{ ok: boolean; message: string } | undefined> {
  const env = input.env ?? process.env;
  if (input.eventName !== "pull_request" || input.runtimeMode !== "github-app" || !githubOnboardingEnabled(env)) return;
  const parsed = eventSchema.safeParse(input.payload);
  if (!parsed.success) throw new BadWebhookRequestError("Invalid GitHub App deferred pull request identity");
  const event = parsed.data;
  if (event.action === "closed" && !event.pull_request.merged) return;
  const appId = Number(env.APP_ID);
  if (!Number.isSafeInteger(appId) || appId <= 0 || (event.installation.app_id !== undefined && event.installation.app_id !== appId)
      || !input.deliveryId || !/^[a-zA-Z0-9_-]{1,200}$/u.test(input.deliveryId)
      || !input.sourceHash || !/^[0-9a-f]{64}$/u.test(input.sourceHash)) {
    throw new BadWebhookRequestError("Invalid authenticated GitHub App delivery identity");
  }
  resolveGitHubOnboardingOrigin(env);
  let stored: Awaited<ReturnType<GitHubInstallationSyncStore["defer"]>>;
  try {
    stored = await (await getStore()).defer({ appId, installationId: event.installation.id,
      accountId: event.repository.owner.id, repositoryId: event.repository.id,
      repository: `${event.repository.owner.login}/${event.repository.name}`.toLowerCase(),
      pullNumber: event.pull_request.number, action: event.action,
      deliveryId: input.deliveryId, sourceHash: input.sourceHash });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      incrementMetricCounter("pr_agent_github_deferred_admissions_total", { outcome: "conflict" });
      logCore("error", "github_deferred.integrity_conflict", { domainCode: "GITHUB_DEFERRED_IDENTITY_CONFLICT",
        appId, installationId: event.installation.id, deliveryId: input.deliveryId });
      throw new BadWebhookRequestError("Conflicting GitHub App delivery identity");
    }
    throw error;
  }
  incrementMetricCounter("pr_agent_github_deferred_admissions_total", { outcome: stored.outcome });
  return { ok: true, message: stored.outcome === "suppressed"
    ? "ignored repository disabled by operator policy"
    : "pull_request queued pending GitHub installation synchronization" };
}

interface CurrentPull extends GitHubPullSummary {
  state: "open" | "closed";
  merged: boolean;
  base: GitHubPullSummary["base"] & { repo: { id: number; owner: { id: number } } };
}

export interface DeferredGitHubDependencies {
  findBinding(repositoryId: number): ReturnType<PublicationAuthorityStore["findByProviderRepository"]>;
  loadCurrent(binding: PublicationBinding, claim: DeferredPullRequestClaim, signal: AbortSignal):
    Promise<{ context: GitHubReviewContext; pull: CurrentPull }>;
  resolvePolicy: typeof resolveGitHubPullRequestAutoReviewPolicy;
  resolveMergedPolicy: typeof resolveGitHubReviewBehaviorPolicy;
  enqueue: typeof enqueueGitHubReviewForBinding;
}

/** A deferred delivery stores identities only; provider data and review policy are read afresh. */
export async function processDeferredGitHubPullRequest(claim: DeferredPullRequestClaim, parentSignal: AbortSignal,
  store: Pick<GitHubInstallationSyncStore, "completeDeferred">,
  dependencies: DeferredGitHubDependencies = defaultDependencies): Promise<void> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.max(1,
    Math.min(45_000, claim.leaseExpiresAt.getTime() - Date.now() - 1_000)))]);
  const complete = async (outcome: "skipped" | "conflict" | "retry", errorCode: string) => {
    const saved = await store.completeDeferred(claim, { outcome, errorCode,
      ...(outcome === "retry" ? { retryAt: new Date(Date.now() + 30_000) } : {}) });
    if (!saved) throw new Error("Deferred GitHub pull request lease was lost");
    incrementMetricCounter("pr_agent_github_deferred_outcomes_total", { outcome });
  };
  signal.throwIfAborted();
  const target = await dependencies.findBinding(claim.repositoryId);
  if (!target) return complete("retry", "binding_pending");
  const { binding } = target;
  if (binding.platform !== "github" || binding.origin !== "https://api.github.com"
      || binding.githubAppId !== claim.appId || binding.githubAccountId !== claim.accountId
      || binding.credentialRef !== `github-app:${claim.installationId}`
      || binding.providerRepositoryId !== claim.repositoryId) return complete("conflict", "binding_identity_mismatch");
  if (!target.active || binding.state !== "active" || binding.reviewExecutionState !== "active") {
    return complete("skipped", "operator_policy_disabled");
  }
  if (binding.providerAccessState !== "verified") return complete("retry", "provider_access_pending");
  const { context, pull } = await abortable(dependencies.loadCurrent(binding, claim, signal), signal);
  if (pull.number !== claim.pullNumber || pull.base.repo.id !== claim.repositoryId
      || pull.base.repo.owner.id !== claim.accountId) return complete("conflict", "provider_identity_mismatch");
  const merged = claim.action === "closed";
  if ((merged && (pull.state !== "closed" || !pull.merged)) || (!merged && pull.state !== "open")) {
    return complete("skipped", "pull_request_no_longer_eligible");
  }
  if (claim.action === "reopened") return complete("skipped", "unsupported_action");
  const policy = merged
    ? await abortable(dependencies.resolveMergedPolicy({ context, baseRef: pull.base.ref }), signal)
    : await abortable(dependencies.resolvePolicy({ context, baseRef: pull.base.ref,
      action: claim.action as "opened" | "edited" | "synchronize" }), signal);
  if ("enabled" in policy && !policy.enabled) return complete("skipped", "repository_review_disabled");
  signal.throwIfAborted();
  // The enqueue transaction completes the deferred row with the run/job/budget insert.
  try {
    await dependencies.enqueue({ context, pullNumber: claim.pullNumber,
    mode: merged ? "report" : (policy as Awaited<ReturnType<DeferredGitHubDependencies["resolvePolicy"]>>).mode,
    trigger: merged ? "merged" : claim.action === "opened" ? "pr-opened"
      : claim.action === "edited" ? "pr-edited" : "pr-synchronize",
    sourceKey: `github:delivery:${claim.deliveryId}`, sourceHash: claim.sourceHash,
    customRules: policy.customRules, includeCiChecks: policy.includeCiChecks,
    enableSecretScan: policy.secretScanEnabled, secretScanCustomPatterns: policy.secretScanCustomPatterns,
    enableAutoLabel: policy.autoLabelEnabled,
    }, binding, { handoff: { ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch }, pull });
    incrementMetricCounter("pr_agent_github_deferred_outcomes_total", { outcome: "drained" });
  } catch (error) {
    if (error instanceof GitHubDeliveryHandoffError && error.code !== "deferred_claim_stale") {
      return complete("conflict", error.code);
    }
    throw error;
  }
}

const pullSchema = z.object({
  id, number: id, title: z.string(), body: z.string().nullable(), user: z.object({ login: z.string() }).nullable(),
  draft: z.boolean().optional(), state: z.enum(["open", "closed"]), merged: z.boolean(),
  base: z.object({ ref: z.string().min(1), sha: z.string().min(1), repo: z.object({ id, owner: z.object({ id }) }) }),
  head: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
  additions: z.number(), deletions: z.number(), changed_files: z.number(), html_url: z.string(),
});

const defaultDependencies: DeferredGitHubDependencies = {
  findBinding: async (repositoryId) => (await getAgentRuntimeServices()).authority
    .findByProviderRepository("github", resolveGitHubOnboardingOrigin(), repositoryId),
  loadCurrent: async (binding, claim, signal) => {
    await abortable(assertGitHubBindingAccess(binding), signal);
    const octokit = await abortable(getSharedGitHubProbot(binding.origin).auth(claim.installationId), signal);
    const [owner, repo] = binding.repository.split("/") as [string, string];
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner, repo, pull_number: claim.pullNumber, request: { signal },
    });
    return { pull: pullSchema.parse(response.data), context: { repo: () => ({ owner, repo }),
      octokit: guardGitHubOctokit(octokit as unknown as MinimalGitHubOctokit),
      log: { info: (_metadata, message) => logCore("info", "github_deferred_review.info", { message }),
        error: (_metadata, message) => logCore("error", "github_deferred_review.failed", { message }) } } };
  },
  resolvePolicy: resolveGitHubPullRequestAutoReviewPolicy,
  resolveMergedPolicy: resolveGitHubReviewBehaviorPolicy,
  enqueue: enqueueGitHubReviewForBinding,
};

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
