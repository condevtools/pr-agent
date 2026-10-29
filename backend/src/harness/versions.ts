import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_RUNTIME_CONFIG = Object.freeze({
  schemaVersion: 1, workflow: "review.single.v1", pollMs: 1_000,
  leaseTtlMs: 60_000, heartbeatMs: 15_000, sweepMs: 5_000,
  maxRunMs: 15 * 60_000, maxJobAttempts: 3, maxStepAttempts: 3,
  maxCheckpointBytes: 4 * 1024 * 1024,
});

const VERSIONED_ENV = [
  "AI_PROVIDER", "AI_MODEL", "OPENAI_MODEL", "OPENAI_COMPATIBLE_MODEL", "OPENAI_BASE_URL",
  "ANTHROPIC_MODEL", "GEMINI_MODEL", "AI_HTTP_TIMEOUT_MS", "PR_AGENT_LOCALE",
  "OPENAI_MAX_COMPLETION_TOKENS", "ANTHROPIC_MAX_TOKENS", "GEMINI_MAX_OUTPUT_TOKENS",
  "AI_MAX_CONCURRENCY", "AI_MAX_QUEUE_SIZE", "REVIEW_CODE_EXTENSIONS",
  "GITHUB_API_URL", "GITLAB_BASE_URL", "GITHUB_MAX_PATCH_CHARS_PER_FILE", "GITHUB_MAX_TOTAL_PATCH_CHARS",
  "GITLAB_MAX_PATCH_CHARS_PER_FILE", "GITLAB_MAX_TOTAL_PATCH_CHARS",
] as const;

export interface RunVersionManifest {
  workflowVersionHash: string;
  promptVersionHash: string;
  modelVersionHash: string;
  toolVersionHash: string;
  policyVersionHash: string;
  runtimeVersionHash: string;
}

export async function buildCodeManifest(sourceRoot: URL): Promise<{ schemaVersion: 1; sourceHash: string }> {
  const root = fileURLToPath(sourceRoot);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(ts|sql)$/.test(entry.name)) files.push(path);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(root, file)).update("\0").update(await readFile(file)).update("\0");
  }
  for (const name of ["../package.json", "../tsconfig.json", "../scripts/copy-harness-assets.mjs",
    "../../package.json", "../../pnpm-workspace.yaml", "../../pnpm-lock.yaml"]) {
    hash.update(name).update("\0").update(await readFile(join(root, name))).update("\0");
  }
  return { schemaVersion: 1, sourceHash: hash.digest("hex") };
}

let installedCodeManifest: Promise<{ schemaVersion: 1; sourceHash: string }> | undefined;

export async function reviewVersionManifest(modelPolicy: unknown): Promise<RunVersionManifest> {
  installedCodeManifest ??= import.meta.url.endsWith(".ts")
    ? buildCodeManifest(new URL("../", import.meta.url))
    : readFile(new URL("./runtime-manifest.json", import.meta.url), "utf8").then((text) => {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || !("sourceHash" in value)
          || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)) {
        throw new Error("Built Harness runtime manifest is invalid");
      }
      return { schemaVersion: 1 as const, sourceHash: value.sourceHash };
    });
  const code = await installedCodeManifest;
  const environment = Object.fromEntries(VERSIONED_ENV.map((name) => [name, process.env[name]?.trim() ?? null]));
  const runtime = { ...REVIEW_RUNTIME_CONFIG, node: process.versions.node, platform: process.platform, arch: process.arch };
  const version = (component: string) => fingerprint({ component, code, environment, modelPolicy, runtime });
  return {
    workflowVersionHash: version("workflow"), promptVersionHash: version("prompt"),
    modelVersionHash: version("model"), toolVersionHash: version("tool"),
    policyVersionHash: version("policy"), runtimeVersionHash: version("runtime"),
  };
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
