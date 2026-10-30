import { z } from "zod";

import { BadWebhookRequestError } from "#core";
import type { GitHubOnboardingStore } from "../../../agent-runtime/authority/github-onboarding.js";
import { githubOnboardingEnabled } from "../../../agent-runtime/runtime/config.js";
import { getGitHubOnboardingStore } from "../../../agent-runtime/runtime/github-onboarding.js";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const lifecyclePayloadSchema = z.object({
  action: z.string().min(1).max(100),
  installation: z.object({
    id: positiveId,
    app_id: positiveId,
  }),
  repositories_removed: z.array(z.object({ id: positiveId })).max(100_000).optional(),
});

export interface GitHubOnboardingLifecycleDependencies {
  getStore(): Promise<Pick<GitHubOnboardingStore, "invalidate">>;
}

const defaultDependencies: GitHubOnboardingLifecycleDependencies = {
  getStore: getGitHubOnboardingStore,
};

/**
 * Applies only restrictive, already-verified GitHub App lifecycle signals.
 * Positive events deliberately never restore access; restoration stays an explicit live revalidation.
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
  if (!githubOnboardingEnabled(env)) {
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
  serverOrigin(env);

  let invalidation: Parameters<GitHubOnboardingStore["invalidate"]>[0] | undefined;
  if (eventName === "installation") {
    if (action === "deleted" || action === "suspend") {
      invalidation = {
        appId: configuredAppId,
        installationId: parsed.data.installation.id,
        state: "revoked",
        reason: action === "deleted" ? "GitHub App installation deleted" : "GitHub App installation suspended",
        deliveryId,
      };
    }
  } else if (action === "removed") {
    if (!parsed.data.repositories_removed) {
      throw new BadWebhookRequestError("GitHub repository removal inventory is missing");
    }
    const repositoryIds = [...new Set(parsed.data.repositories_removed.map((repository) => repository.id))];
    invalidation = {
      appId: configuredAppId,
      installationId: parsed.data.installation.id,
      ...(repositoryIds.length ? { repositoryIds } : {}),
      state: repositoryIds.length ? "revoked" : "unknown",
      reason: repositoryIds.length
        ? "GitHub App repository access removed"
        : "GitHub App repository selection requires reconciliation",
      deliveryId,
    };
  }

  if (!invalidation) return { ok: true, message: `ignored GitHub App lifecycle action ${action}` };
  const store = await dependencies.getStore();
  const changed = await store.invalidate(invalidation);
  return { ok: true, message: `GitHub App lifecycle restriction applied to ${changed} binding(s)` };
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

function serverOrigin(env: NodeJS.ProcessEnv): string {
  const configured = env.GITHUB_API_URL?.trim() || "https://api.github.com";
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new BadWebhookRequestError("invalid server GITHUB_API_URL configuration");
  }
}
