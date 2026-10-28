import type { MinimalGitHubOctokit } from "../integrations/github/github-review-types.js";

export interface GitHubCredentialIdentity {
  actorId: number;
  kind: "user-token" | "github-app-installation";
  installationId?: number;
  appId?: number;
}

export interface GitHubAppIdentity {
  app: { id: number; slug?: string };
  installation: { id: number; app_id: number; suspended_at?: string | null };
}

/** Verifies the principal of the same server-issued credential used for publication. */
export async function verifyGitHubCredentialIdentity(input: {
  credentialRef: string;
  octokit: MinimalGitHubOctokit;
  loadAppIdentity?: (installationId: number) => Promise<GitHubAppIdentity>;
}): Promise<GitHubCredentialIdentity> {
  if (!input.octokit.users) throw new Error("GitHub credential identity lookup is unavailable");
  if (!input.credentialRef.startsWith("github-app:")) {
    if (!/^env:GITHUB_(?:WEBHOOK_)?TOKEN$/.test(input.credentialRef)) {
      throw new Error("Unsupported GitHub credential identity");
    }
    const { data } = await input.octokit.users.getAuthenticated();
    positiveId(data.id);
    return { kind: "user-token", actorId: data.id };
  }
  const installationId = Number(input.credentialRef.slice("github-app:".length));
  positiveId(installationId);
  if (!input.loadAppIdentity) throw new Error("GitHub App identity lookup is unavailable");
  const { app, installation } = await input.loadAppIdentity(installationId);
  positiveId(app.id);
  if (installation.id !== installationId || installation.app_id !== app.id || installation.suspended_at) {
    throw new Error("GitHub installation does not belong to the authenticated app");
  }
  if (typeof app.slug !== "string" || !/^[a-zA-Z0-9-]+$/.test(app.slug)) {
    throw new Error("GitHub App bot identity is unavailable");
  }
  const username = `${app.slug}[bot]`;
  const { data: actor } = await input.octokit.users.getByUsername({ username });
  positiveId(actor.id);
  if (actor.login?.toLowerCase() !== username.toLowerCase() || actor.type !== "Bot") {
    throw new Error("GitHub App bot identity does not match the authenticated app");
  }
  return { kind: "github-app-installation", actorId: actor.id, installationId, appId: app.id };
}

function positiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid GitHub credential identity");
}
