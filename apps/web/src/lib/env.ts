import { createHash } from "node:crypto";

interface RequiredEnvOptions {
  allowPlaceholderInNextBuild?: boolean;
}

function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function readRequiredEnv(
  name: string,
  options: RequiredEnvOptions = {},
): string {
  const value = process.env[name]?.trim();
  if (!value) {
    if (options.allowPlaceholderInNextBuild && isNextBuildPhase()) {
      const token = createHash("sha256")
        .update(`next-build-placeholder:${name}`)
        .digest("hex");
      return `build-${token}`;
    }
    throw new Error(
      `[web/env] Missing required environment variable: ${name}`,
    );
  }
  return value;
}

export function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function resolveAppUrl(): string {
  return (
    readOptionalEnv("BETTER_AUTH_URL") ??
    readOptionalEnv("NEXT_PUBLIC_APP_URL") ??
    "http://localhost:3000"
  );
}
