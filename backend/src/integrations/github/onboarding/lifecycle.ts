import { z } from "zod";

import { BadWebhookRequestError, resolveGitHubOnboardingOrigin } from "#core";
import type { GitHubInstallationSyncStore } from "../../../agent-runtime/authority/github-installation-sync.js";
import { githubOnboardingEnabled, githubOnboardingRestrictionsEnabled } from "../../../agent-runtime/runtime/config.js";
import { getGitHubInstallationSyncStore } from "../../../agent-runtime/runtime/github-onboarding.js";
import { incrementMetricCounter } from "../../../http/system/metrics-runtime.js";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const lifecyclePayloadSchema = z.object({
  action: z.string().min(1).max(100),
  installation: z.object({
    id: positiveId,
    app_id: positiveId,
    account: z.object({ id: positiveId }).optional(),
  }),
  repositories_removed: z.array(z.object({ id: positiveId })).max(10_000).optional(),
});

export interface GitHubOnboardingLifecycleDependencies {
  getStore(): Promise<Pick<GitHubInstallationSyncStore, "requestSync" | "restrictAndRequest">>;
}

const defaultDependencies: GitHubOnboardingLifecycleDependencies = {
  getStore: getGitHubInstallationSyncStore,
};

/**
 * Receives only verified live deliveries. Positive signals schedule fresh API
 * reconciliation; restrictive signals fence immediately in the same durable receipt.
 */
export async function handleGitHubOnboardingLifecycle(params: {
  eventName: string;
  payload: unknown;
  deliveryId?: string;
  env?: NodeJS.ProcessEnv;
}, dependencies: GitHubOnboardingLifecycleDependencies = defaultDependencies): Promise<
  { ok: true; message: string } | undefined
> {
  const eventName = params.eventName.trim().toLowerCase();
  if (eventName !== "installation" && eventName !== "installation_repositories") return undefined;
  const env = params.env ?? process.env;
  if (!githubOnboardingRestrictionsEnabled(env)) {
    return { ok: true, message: "GitHub onboarding lifecycle persistence is disabled" };
  }

  const parsed = lifecyclePayloadSchema.safeParse(params.payload);
  if (!parsed.success) throw new BadWebhookRequestError("invalid GitHub App lifecycle payload");
  const action = parsed.data.action.trim().toLowerCase();
  const configuredAppId = configuredPositiveId(env.APP_ID, "APP_ID");
  if (parsed.data.installation.app_id !== configuredAppId) {
    throw new BadWebhookRequestError("GitHub App lifecycle identity mismatch");
  }
  const deliveryId = deliveryIdentity(params.deliveryId);
  resolveGitHubOnboardingOrigin(env);
  const accountId = parsed.data.installation.account?.id;
  const identity = { appId: configuredAppId, installationId: parsed.data.installation.id,
    ...(accountId === undefined ? {} : { accountId }), deliveryId };

  let invalidation: Parameters<GitHubInstallationSyncStore["restrictAndRequest"]>[0] | undefined;
  if (eventName === "installation") {
    if (action === "deleted" || action === "suspend") {
      invalidation = {
        ...identity,
        state: "revoked",
        reason: action === "deleted" ? "GitHub App installation deleted" : "GitHub App installation suspended",
      };
    }
  } else if (action === "removed") {
    if (!parsed.data.repositories_removed) {
      throw new BadWebhookRequestError("GitHub repository removal inventory is missing");
    }
    const repositoryIds = [...new Set(parsed.data.repositories_removed.map((repository) => repository.id))];
    invalidation = {
      ...identity,
      ...(repositoryIds.length ? { repositoryIds } : {}),
      state: repositoryIds.length ? "revoked" : "unknown",
      reason: repositoryIds.length
        ? "GitHub App repository access removed"
        : "GitHub App repository selection requires reconciliation",
    };
  }

  if (invalidation) {
    const result = await (await dependencies.getStore()).restrictAndRequest(invalidation);
    incrementMetricCounter("pr_agent_github_onboarding_restrictions_total", { outcome: result.accepted ? "applied" : "duplicate" });
    return { ok: true, message: `GitHub App lifecycle restriction applied to ${result.changedBindings} binding(s)` };
  }
  const positive = eventName === "installation"
    ? ["created", "unsuspend", "new_permissions_accepted"].includes(action) : action === "added";
  if (!positive || !githubOnboardingEnabled(env)) {
    return { ok: true, message: `ignored GitHub App lifecycle action ${action}` };
  }
  const requested = await (await dependencies.getStore()).requestSync({ ...identity, eventClass: "positive",
    reason: `GitHub ${eventName}.${action}` });
  incrementMetricCounter("pr_agent_github_onboarding_requests_total", { outcome: requested.accepted ? "requested" : "coalesced" });
  return { ok: true, message: "GitHub App installation synchronization queued" };
}

function configuredPositiveId(value: string | undefined, name: string): number {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9][0-9]*$/u.test(normalized)) {
    throw new BadWebhookRequestError(`invalid server ${name} configuration`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new BadWebhookRequestError(`invalid server ${name} configuration`);
  return parsed;
}

function deliveryIdentity(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    throw new BadWebhookRequestError("invalid GitHub lifecycle delivery identity");
  }
  return normalized;
}
