export type GitHubOnboardingMode = "auto" | "on" | "off";

/** Complete GitHub App credentials select App mode; the onboarding DB secret never does. */
export function githubAppModeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.APP_ID?.trim()
    && (env.PRIVATE_KEY?.trim() || env.PRIVATE_KEY_PATH?.trim())
    && env.WEBHOOK_SECRET?.trim());
}

export function githubOnboardingMode(env: NodeJS.ProcessEnv = process.env): GitHubOnboardingMode {
  const value = env.FEATURE_GITHUB_ONBOARDING?.trim().toLowerCase() || "auto";
  if (value !== "auto" && value !== "on" && value !== "off") {
    throw new Error("FEATURE_GITHUB_ONBOARDING must be auto, on, or off");
  }
  return value;
}

/** Positive installation synchronization is automatic in complete GitHub App mode. */
export function githubOnboardingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return githubAppModeConfigured(env) && githubOnboardingMode(env) !== "off";
}

/** Restrictive lifecycle persistence is mandatory in every complete GitHub App mode. */
export function githubOnboardingRestrictionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return githubAppModeConfigured(env);
}

/** Automatic onboarding is intentionally limited to GitHub.com's public API. */
export function resolveGitHubOnboardingOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GITHUB_API_URL?.trim() || "https://api.github.com";
  try {
    const url = new URL(configured);
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.search || url.hash
        || (url.pathname !== "" && url.pathname !== "/")) {
      throw new Error("unsupported origin");
    }
    return "https://api.github.com";
  } catch {
    throw new Error("GITHUB_API_URL must be the public GitHub API origin for automatic onboarding");
  }
}
