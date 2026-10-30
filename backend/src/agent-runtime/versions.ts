import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

export const AGENT_RUNTIME_CONFIG = Object.freeze({
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
  sourceAuditHash: string;
  workflowVersionHash: string;
  promptVersionHash: string;
  modelVersionHash: string;
  toolVersionHash: string;
  policyVersionHash: string;
  runtimeVersionHash: string;
}

type VersionComponent = "workflow" | "prompt" | "model" | "tool" | "policy" | "verifier";

interface CodeManifest {
  schemaVersion: 1;
  sourceHash: string;
  componentHashes: Record<VersionComponent, string>;
  productionDependencyHashes: Record<VersionComponent, string>;
}

export async function buildCodeManifest(sourceRoot: URL): Promise<CodeManifest> {
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
  const sources = new Map<string, Buffer>();
  for (const file of files.sort()) {
    sources.set(relative(root, file).split("\\").join("/"), await readFile(file));
  }
  const componentSources = resolveComponentSources(sources);
  const components = Object.fromEntries(
    VERSION_COMPONENTS.map((name) => [name, createHash("sha256")]),
  ) as Record<VersionComponent, ReturnType<typeof createHash>>;
  for (const [name, content] of sources) {
    hash.update(name).update("\0").update(content).update("\0");
  }
  for (const component of VERSION_COMPONENTS) for (const name of [...componentSources[component]].sort()) {
    components[component].update(name).update("\0").update(sources.get(name)!).update("\0");
  }
  let lockfile = "";
  for (const name of ["../package.json", "../tsconfig.json", "../scripts/build.mjs", "../scripts/copy-agent-runtime-assets.mjs",
    "../../package.json", "../../pnpm-workspace.yaml", "../../pnpm-lock.yaml", "../scripts/fix-sandbox-runner.mjs"]) {
    const content = await readFile(join(root, name));
    hash.update(name).update("\0").update(content).update("\0");
    if (name === "../../pnpm-lock.yaml") lockfile = content.toString("utf8");
  }
  const productionDependencyHashes = Object.fromEntries(VERSION_COMPONENTS.map((component) => [
    component,
    fingerprint(resolveProductionDependencyPins(lockfile, componentSources.external[component])),
  ])) as Record<VersionComponent, string>;
  for (const component of VERSION_COMPONENTS) {
    components[component].update("production-dependencies\0").update(productionDependencyHashes[component]);
  }
  return {
    schemaVersion: 1,
    sourceHash: hash.digest("hex"),
    componentHashes: Object.fromEntries(
      Object.entries(components).map(([name, component]) => [name, component.digest("hex")]),
    ) as Record<VersionComponent, string>,
    productionDependencyHashes,
  };
}

let installedCodeManifest: Promise<CodeManifest> | undefined;

async function installedManifest(): Promise<CodeManifest> {
  installedCodeManifest ??= import.meta.url.endsWith(".ts")
    ? buildCodeManifest(new URL("../", import.meta.url))
    : readFile(new URL("./runtime-manifest.json", import.meta.url), "utf8").then((text) => {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || !("sourceHash" in value)
          || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)) {
        throw new Error("Built Harness runtime manifest is invalid");
      }
      if (!("componentHashes" in value) || !isComponentHashes(value.componentHashes)
          || !("productionDependencyHashes" in value)
          || !isComponentHashes(value.productionDependencyHashes)) {
        throw new Error("Built Harness component manifest is invalid");
      }
      return { schemaVersion: 1 as const, sourceHash: value.sourceHash,
        componentHashes: value.componentHashes,
        productionDependencyHashes: value.productionDependencyHashes };
    });
  return installedCodeManifest;
}

/** Host-side verifier capability. The sandbox image remains independently frozen by its digest. */
export async function verifierCapabilityHash(): Promise<string> {
  const code = await installedManifest();
  return fingerprint({ schemaVersion: 1, source: code.componentHashes.verifier,
    productionDependencies: code.productionDependencyHashes.verifier,
    nodeRuntimeLine: process.versions.node.split(".").slice(0, 2).join(".") });
}

export async function runtimeVersionManifest(modelPolicy: unknown): Promise<RunVersionManifest> {
  const code = await installedManifest();
  const environment = Object.fromEntries(VERSIONED_ENV.map((name) => [name, process.env[name]?.trim() ?? null]));
  const modelExecution = executableModelPolicy(modelPolicy);
  const version = (component: keyof CodeManifest["componentHashes"], extra: unknown = undefined) =>
    fingerprint({ component, source: code.componentHashes[component], extra });
  const workflowVersionHash = version("workflow", {
    schemaVersion: AGENT_RUNTIME_CONFIG.schemaVersion,
    maxCheckpointBytes: AGENT_RUNTIME_CONFIG.maxCheckpointBytes,
    nodeRuntimeLine: process.versions.node.split(".").slice(0, 2).join("."),
  });
  const promptVersionHash = version("prompt", {
    locale: environment.PR_AGENT_LOCALE,
    reviewCodeExtensions: environment.REVIEW_CODE_EXTENSIONS,
  });
  const modelVersionHash = version("model", modelExecution);
  const modelProvider = modelExecution && typeof modelExecution === "object"
    ? (modelExecution as Record<string, unknown>).provider : undefined;
  const modelEndpointHash = fingerprint({
    provider: modelProvider,
    openAiBaseUrl: modelProvider === "openai" || modelProvider === "openai-compatible"
      ? environment.OPENAI_BASE_URL : null,
    requestTimeoutMs: environment.AI_HTTP_TIMEOUT_MS,
  });
  const toolVersionHash = version("tool", {
    githubOrigin: environment.GITHUB_API_URL,
    gitlabOrigin: environment.GITLAB_BASE_URL,
    githubPatchLimits: [environment.GITHUB_MAX_PATCH_CHARS_PER_FILE, environment.GITHUB_MAX_TOTAL_PATCH_CHARS],
    gitlabPatchLimits: [environment.GITLAB_MAX_PATCH_CHARS_PER_FILE, environment.GITLAB_MAX_TOTAL_PATCH_CHARS],
  });
  const policyVersionHash = version("policy", {
    locale: environment.PR_AGENT_LOCALE,
    reviewCodeExtensions: environment.REVIEW_CODE_EXTENSIONS,
  });
  return {
    sourceAuditHash: code.sourceHash,
    workflowVersionHash, promptVersionHash,
    modelVersionHash: fingerprint({ modelVersionHash, modelEndpointHash }),
    toolVersionHash, policyVersionHash,
    runtimeVersionHash: runtimeCompatibilityHash({ workflowVersionHash, promptVersionHash,
      modelVersionHash: fingerprint({ modelVersionHash, modelEndpointHash }), toolVersionHash, policyVersionHash }),
  };
}

function runtimeCompatibilityHash(value: Pick<RunVersionManifest, "workflowVersionHash" | "promptVersionHash" |
  "modelVersionHash" | "toolVersionHash" | "policyVersionHash">): string {
  return fingerprint({ schemaVersion: 2, workflowVersionHash: value.workflowVersionHash,
    promptVersionHash: value.promptVersionHash, modelVersionHash: value.modelVersionHash,
    toolVersionHash: value.toolVersionHash, policyVersionHash: value.policyVersionHash });
}

const VERSION_COMPONENTS: readonly VersionComponent[] = ["workflow", "prompt", "model", "tool", "policy", "verifier"];

const COMPONENT_ROOTS: Record<VersionComponent, readonly RegExp[]> = {
  workflow: [/^agent-runtime\/runtime(?:\.ts$|\/)/, /^agent-runtime\/workflows\//,
    /^agent-runtime\/execution\/(?:run-worker|store|run-context)\.ts$/],
  prompt: [/^review\/standard\//, /^review\/deep\/(?:roles\/|critic\.ts$)/,
    /^review\/(?:presentation|rendering|strategy)\//],
  model: [/^model\/(?:runtime|structured-model|execution-context|configuration|contracts|client-cache|concurrency)\.ts$/,
    /^model\/providers\//],
  tool: [/^repository\//, /^review\/deep\/tools\//, /^fix\/verification\/(?:jobs|gate)\.ts$/,
    /^fix\/publication\/provider-adapter\.ts$/,
    /^integrations\/(?:github|gitlab)\/(?:api|publication|auth)\//],
  policy: [/^review\/policy\//, /^review\/deep\/policy\.ts$/,
    /^fix\/(?:contracts\.ts$|proposal\/policy\.ts$)/,
    /^evolution\/releases\/(?:policy|gates)\.ts$/],
  verifier: [/^fix\/verification\/(?:cli|worker|docker-verifier|sandbox-policy|sandbox-result)\.ts$/],
};

function resolveComponentSources(sources: Map<string, Buffer>): Record<VersionComponent, Set<string>> & {
  external: Record<VersionComponent, Set<string>>;
} {
  const local = Object.fromEntries(VERSION_COMPONENTS.map((component) => [component, new Set<string>()])) as
    Record<VersionComponent, Set<string>>;
  const external = Object.fromEntries(VERSION_COMPONENTS.map((component) => [component, new Set<string>()])) as
    Record<VersionComponent, Set<string>>;
  for (const component of VERSION_COMPONENTS) {
    const pending = [...sources.keys()].filter((name) => COMPONENT_ROOTS[component].some((root) => root.test(name)));
    while (pending.length) {
      const name = pending.pop()!;
      if (local[component].has(name)) continue;
      local[component].add(name);
      for (const specifier of sourceImports(sources.get(name)!.toString("utf8"), name)) {
        const dependency = resolveLocalImport(name, specifier, sources);
        if (dependency) pending.push(dependency);
        else if (!isNodeBuiltin(specifier) && !specifier.startsWith("#") && !specifier.startsWith(".")) {
          external[component].add(externalPackageName(specifier));
        }
      }
    }
  }
  return Object.assign(local, { external });
}

function sourceImports(source: string, owner: string): string[] {
  const result = new Set<string>();
  const staticImport = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (let match = staticImport.exec(source); match; match = staticImport.exec(source)) result.add(match[1]!);
  for (const specifier of moduleCallImports(source, owner)) result.add(specifier);
  return [...result];
}

/** Lexes executable import()/require() calls so comments cannot hide non-literal dependencies. */
function moduleCallImports(source: string, owner: string): string[] {
  const result: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    offset = skipTrivia(source, offset);
    const character = source[offset];
    if (character === "/" && isRegexLiteralStart(source, offset)) {
      offset = skipRegexLiteral(source, offset, owner);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      offset = skipQuoted(source, offset, character, owner);
      continue;
    }
    if (!character || !/[A-Za-z_$]/.test(character)) { offset += 1; continue; }
    const start = offset++;
    while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset]!)) offset += 1;
    const keyword = source.slice(start, offset);
    if (keyword !== "import" && keyword !== "require") continue;
    const callStart = skipTrivia(source, offset);
    if (keyword === "import" && source[callStart] === ".") continue;
    if (source[callStart] !== "(") continue;
    let argument = skipTrivia(source, callStart + 1);
    const quote = source[argument];
    if (quote !== '"' && quote !== "'") throw new Error(`Non-literal ${keyword} in versioned source ${owner}`);
    const end = skipQuoted(source, argument, quote, owner);
    const raw = source.slice(argument + 1, end - 1);
    if (raw.includes("\\")) throw new Error(`Escaped ${keyword} specifier in versioned source ${owner}`);
    argument = skipTrivia(source, end);
    if (source[argument] !== ")") throw new Error(`Non-literal ${keyword} in versioned source ${owner}`);
    if (!raw) throw new Error(`Invalid ${keyword} in versioned source ${owner}`);
    result.push(raw);
    offset = argument + 1;
  }
  return result;
}

function isRegexLiteralStart(source: string, offset: number): boolean {
  let previous = offset - 1;
  while (previous >= 0 && /\s/.test(source[previous]!)) previous -= 1;
  return previous < 0 || /[=(:,!\[\{;?&|]/.test(source[previous]!);
}

function skipRegexLiteral(source: string, initial: number, owner: string): number {
  let offset = initial + 1;
  let characterClass = false;
  while (offset < source.length) {
    const character = source[offset];
    if (character === "\\") { offset += 2; continue; }
    if (character === "[") characterClass = true;
    else if (character === "]") characterClass = false;
    else if (character === "/" && !characterClass) {
      offset += 1;
      while (offset < source.length && /[a-z]/i.test(source[offset]!)) offset += 1;
      return offset;
    }
    if (character === "\n" || character === "\r") break;
    offset += 1;
  }
  throw new Error(`Unterminated regular expression in ${owner} while resolving version dependencies`);
}

function skipTrivia(source: string, initial: number): number {
  let offset = initial;
  while (offset < source.length) {
    if (/\s/.test(source[offset]!)) { offset += 1; continue; }
    if (source.startsWith("//", offset)) {
      const newline = source.indexOf("\n", offset + 2);
      offset = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      if (end < 0) throw new Error("Unterminated source comment while resolving version dependencies");
      offset = end + 2;
      continue;
    }
    break;
  }
  return offset;
}

function skipQuoted(source: string, initial: number, quote: string, owner = "source"): number {
  let offset = initial + 1;
  while (offset < source.length) {
    if (source[offset] === "\\") { offset += 2; continue; }
    if (source[offset] === quote) return offset + 1;
    offset += 1;
  }
  throw new Error(`Unterminated source string in ${owner} while resolving version dependencies`);
}

function resolveLocalImport(from: string, specifier: string, sources: Map<string, Buffer>): string | undefined {
  let target: string | undefined;
  if (specifier.startsWith(".")) target = posix.normalize(posix.join(posix.dirname(from), specifier));
  else if (specifier === "#core") target = "core/index.js";
  else if (specifier.startsWith("#core/")) target = `core/${specifier.slice(6)}.js`;
  else if (specifier === "#review") target = "review/index.js";
  else if (specifier.startsWith("#review/")) target = `review/${specifier.slice(8)}.js`;
  else if (specifier === "#model") target = "model/index.js";
  else if (specifier.startsWith("#model/")) target = `model/${specifier.slice(7)}.js`;
  else if (specifier.startsWith("#integrations/")) target = `${specifier.slice(1)}.js`;
  else if (specifier.startsWith("#")) throw new Error(`Unknown source alias ${specifier} imported by ${from}`);
  if (!target) return undefined;
  const withoutExtension = target.replace(/\.(?:js|mjs|cjs)$/, "");
  const resolved = [target, `${withoutExtension}.ts`, `${withoutExtension}/index.ts`]
    .find((candidate) => sources.has(candidate));
  if (!resolved) throw new Error(`Unresolved local import ${specifier} imported by ${from}`);
  return resolved;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

function externalPackageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function resolveProductionDependencyPins(lockfile: string, roots: Set<string>): unknown[] {
  const parsed = loadYaml(lockfile) as Record<string, unknown> | undefined;
  const importers = objectRecord(parsed?.importers, "pnpm importers");
  const backend = objectRecord(importers.backend, "pnpm backend importer");
  const direct = objectRecord(backend.dependencies, "pnpm backend production dependencies");
  const snapshots = objectRecord(parsed?.snapshots, "pnpm snapshots");
  const packages = objectRecord(parsed?.packages, "pnpm packages");
  const pending = [...roots].map((name) => ({ name, reference: dependencyReference(direct[name], name) }));
  const visited = new Set<string>();
  const pins: unknown[] = [];
  while (pending.length) {
    const item = pending.pop()!;
    const snapshotKey = [`${item.name}@${item.reference}`, item.reference]
      .find((candidate) => candidate in snapshots);
    if (!snapshotKey) throw new Error(`pnpm snapshot for ${item.name}@${item.reference} is missing`);
    if (visited.has(snapshotKey)) continue;
    const snapshot = objectRecord(snapshots[snapshotKey], `pnpm snapshot ${snapshotKey}`);
    visited.add(snapshotKey);
    const packageKey = snapshotKey.replace(/\([^/()]*@[^/()]+\).*$/, "").replace(/\(.+$/, "");
    const packageRow = objectRecord(packages[packageKey], `pnpm package ${packageKey}`);
    const resolution = packageRow.resolution && typeof packageRow.resolution === "object"
      ? packageRow.resolution as Record<string, unknown> : {};
    pins.push({ name: item.name, reference: item.reference,
      integrity: typeof resolution.integrity === "string" ? resolution.integrity : null });
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = snapshot[field] && typeof snapshot[field] === "object"
        ? snapshot[field] as Record<string, unknown> : {};
      for (const [name, value] of Object.entries(dependencies)) {
        pending.push({ name, reference: dependencyReference(value, name) });
      }
    }
  }
  return pins.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function dependencyReference(value: unknown, name: string): string {
  const reference = typeof value === "string" ? value
    : value && typeof value === "object" && typeof (value as Record<string, unknown>).version === "string"
      ? (value as Record<string, string>).version : undefined;
  if (!reference || reference.startsWith("link:") || reference.startsWith("workspace:")) {
    throw new Error(`Production dependency ${name} has no resolved pnpm snapshot`);
  }
  return reference;
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function executableModelPolicy(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  return {
    provider: row.provider,
    model: row.model,
    maxOutputTokens: row.maxOutputTokens,
    maxPhysicalCallsPerStep: row.maxPhysicalCallsPerStep,
    openAiTokenParameter: row.openAiTokenParameter,
  };
}

function isComponentHashes(value: unknown): value is CodeManifest["componentHashes"] {
  if (!value || typeof value !== "object") return false;
  return VERSION_COMPONENTS.every((name) =>
    typeof (value as Record<string, unknown>)[name] === "string"
      && /^[a-f0-9]{64}$/.test((value as Record<string, string>)[name]!));
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
