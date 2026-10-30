import { createProbot } from "probot";

import { validateCredentialRef, type PublicationBinding } from "../authority/publication-authority.js";
import { normalizeIntegrationTarget } from "../postgres/run-store.js";

let credentialApp: ReturnType<typeof createProbot> | undefined;
let credentialAppOrigin: string | undefined;

export function getSharedGitHubProbot(origin = process.env.GITHUB_API_URL?.trim() || "https://api.github.com"):
ReturnType<typeof createProbot> {
  const normalized = origin.replace(/\/$/u, "");
  if (credentialAppOrigin && credentialAppOrigin !== normalized) {
    throw new Error("GitHub App credential destination changed during runtime");
  }
  if (!credentialApp) {
    credentialApp = createProbot({ overrides: { baseUrl: normalized } });
    credentialAppOrigin = normalized;
  }
  return credentialApp;
}

export async function resolvePublicationCredential(binding: PublicationBinding): Promise<string> {
  validatePublicationCredentialOrigin(binding);
  validateCredentialRef(binding.credentialRef);
  if (binding.credentialRef.startsWith("github-app:")) {
    if (binding.platform !== "github") throw new Error("GitHub installation credential cannot authorize a GitLab binding");
    const installationId = Number(binding.credentialRef.slice("github-app:".length));
    if (!Number.isSafeInteger(installationId)) throw new Error("Invalid GitHub installation identity");
    const octokit = await getSharedGitHubProbot(binding.origin).auth(installationId);
    const auth = await octokit.auth({ type: "installation" }) as { token?: unknown };
    if (typeof auth.token !== "string" || !auth.token) throw new Error("GitHub installation credential is unavailable");
    return auth.token;
  }
  const name = binding.credentialRef.slice("env:".length);
  if ((binding.platform === "gitlab") !== (name === "GITLAB_TOKEN")) throw new Error("Credential platform mismatch");
  const token = process.env[name]?.trim();
  if (!token) throw new Error("Server publication credential is unavailable");
  return token;
}

export function validatePublicationCredentialOrigin(
  binding: Pick<PublicationBinding, "platform" | "origin" | "repository">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configured = binding.platform === "github"
    ? env.GITHUB_API_URL?.trim() || "https://api.github.com"
    : env.GITLAB_BASE_URL?.trim() || "https://gitlab.com";
  const expected = normalizeIntegrationTarget(binding.platform, configured, binding.repository).origin;
  if (binding.origin !== expected) throw new Error("Publication binding origin does not match the configured credential destination");
}

export function clearSharedCredentialRuntime(): void {
  credentialApp = undefined;
  credentialAppOrigin = undefined;
}
