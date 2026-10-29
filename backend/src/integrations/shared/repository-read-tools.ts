import { z } from "zod";
import { redactKnownSecretValues } from "./secret-scan.js";

import type {
  DeepReviewRole,
  DeepToolRegistry,
  EvidenceKind,
  EvidenceRecord,
  ReadonlyToolRequest,
} from "../../agents/contracts.js";
import { fingerprint } from "../../harness/versions.js";

export const REPOSITORY_READ_LIMITS = Object.freeze({
  maxChangedFiles: 100,
  maxFileBytes: 256 * 1024,
  maxRangeLines: 200,
  maxSearchFiles: 40,
  maxSearchMatches: 50,
  maxSummaryChars: 4_096,
  maxQueryChars: 128,
});

export interface RepositoryReadIdentity {
  tenantId: string;
  integrationId: string;
  runId: string;
  platform: "github" | "gitlab";
  repository: string;
  baseSha: string;
  headSha: string;
}

export interface RepositoryReadFile {
  path: string;
  bytes: Uint8Array;
  mode?: string;
}

export interface RepositoryReadAdapter {
  readFile(path: string, signal?: AbortSignal): Promise<RepositoryReadFile | undefined>;
  readCiStatus(signal?: AbortSignal): Promise<unknown>;
}

export interface RepositoryReadToolOptions {
  identity: RepositoryReadIdentity;
  changedPaths: readonly string[];
  adapter: RepositoryReadAdapter;
  signal?: AbortSignal;
}

const requestSchemas = {
  read_file_range: z.object({ path: z.string().min(1).max(512), startLine: z.number().int().positive(),
    endLine: z.number().int().positive() }).strict(),
  search_changed_files: z.object({ query: z.string().min(1).max(REPOSITORY_READ_LIMITS.maxQueryChars) }).strict(),
  find_symbol_references: z.object({ symbol: z.string().regex(/^[A-Za-z_$][\w$.:/-]{0,127}$/) }).strict(),
  read_manifest: z.object({ kind: z.enum(["package", "dependencies", "build", "ci"]) }).strict(),
  read_ci_status: z.object({}).strict(),
} satisfies Record<ReadonlyToolRequest["name"], z.ZodType>;

const MANIFEST_PATHS: Record<"package" | "dependencies" | "build" | "ci", readonly string[]> = {
  package: ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"],
  dependencies: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "poetry.lock", "Cargo.lock", "go.sum"],
  build: ["tsconfig.json", "Makefile", "build.gradle", "build.gradle.kts", "pom.xml"],
  ci: [".github/workflows/ci.yml", ".github/workflows/ci.yaml", ".gitlab-ci.yml"],
};

export function isSensitivePath(path: string): boolean {
  return path.split("/").some((segment) => /^(?:\.git|\.env(?:\..*)?|\.envrc|.*\.tfvars(?:\.json)?|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(segment));
}
const SECRET_VALUE = /(["']?(?:token|password|passwd|secret|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s,'"}]+)/gi;
const TOKEN_VALUE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export class RepositoryReadToolRegistry implements DeepToolRegistry {
  private readonly changedPaths: string[];
  private readonly identity: RepositoryReadIdentity;

  constructor(private readonly options: RepositoryReadToolOptions) {
    if (options.changedPaths.length > REPOSITORY_READ_LIMITS.maxChangedFiles) {
      throw new Error("changed file list exceeds the repository-read limit");
    }
    this.identity = { tenantId: options.identity.tenantId, integrationId: options.identity.integrationId,
      runId: options.identity.runId, platform: options.identity.platform, repository: options.identity.repository,
      baseSha: options.identity.baseSha, headSha: options.identity.headSha };
    this.changedPaths = [...new Set(options.changedPaths.map(assertSafePath))].sort();
  }

  catalog(_role: DeepReviewRole): readonly ReadonlyToolRequest["name"][] {
    return ["read_file_range", "search_changed_files", "find_symbol_references", "read_manifest", "read_ci_status"];
  }

  async invoke(
    role: DeepReviewRole,
    name: ReadonlyToolRequest["name"],
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<EvidenceRecord> {
    const signals = [signal, this.options.signal].filter((value): value is AbortSignal => Boolean(value));
    signal = signals.length ? AbortSignal.any(signals) : undefined;
    signal?.throwIfAborted();
    const parsed = requestSchemas[name].parse(raw) as Record<string, unknown>;
    switch (name) {
      case "read_file_range": return this.readRange(role, parsed as { path: string; startLine: number; endLine: number }, signal);
      case "search_changed_files": return this.search(role, String(parsed.query), false, signal);
      case "find_symbol_references": return this.search(role, String(parsed.symbol), true, signal);
      case "read_manifest": return this.readManifest(role, parsed.kind as keyof typeof MANIFEST_PATHS, signal);
      case "read_ci_status": return this.ciStatus(role, signal);
    }
  }

  private async readRange(role: DeepReviewRole, input: { path: string; startLine: number; endLine: number }, signal?: AbortSignal): Promise<EvidenceRecord> {
    const path = assertSafePath(input.path);
    if (input.endLine < input.startLine || input.endLine - input.startLine + 1 > REPOSITORY_READ_LIMITS.maxRangeLines) {
      throw new Error(`file range must contain 1-${REPOSITORY_READ_LIMITS.maxRangeLines} lines`);
    }
    const text = await this.readText(path, signal);
    const lines = text.split("\n");
    if (input.startLine > lines.length) throw new Error("file range starts after the end of the file");
    const content = lines.slice(input.startLine - 1, input.endLine)
      .map((line, offset) => `${input.startLine + offset}: ${line}`).join("\n");
    return this.evidence(role, "file_range", "read_file_range", input, content, {
      path, startLine: input.startLine, endLine: Math.min(input.endLine, Math.max(input.startLine, lines.length)),
    });
  }

  private async search(role: DeepReviewRole, query: string, symbol: boolean, signal?: AbortSignal): Promise<EvidenceRecord> {
    const matches: string[] = [];
    let searched = 0;
    const expression = symbol
      ? new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(query)}([^A-Za-z0-9_$]|$)`)
      : undefined;
    for (const path of this.changedPaths.slice(0, REPOSITORY_READ_LIMITS.maxSearchFiles)) {
      if (matches.length >= REPOSITORY_READ_LIMITS.maxSearchMatches) break;
      let text: string;
      try { text = await this.readText(path, signal); }
      catch (error) {
        if (error instanceof RepositoryFileUnavailableError) continue;
        throw error;
      }
      searched += 1;
      for (const [index, line] of text.split("\n").entries()) {
        if ((expression ? expression.test(line) : line.includes(query))) {
          matches.push(`${path}:${index + 1}: ${line.trim()}`);
          if (matches.length >= REPOSITORY_READ_LIMITS.maxSearchMatches) break;
        }
      }
    }
    const content = `searched=${searched}\nmatches=${matches.length}\n${matches.join("\n")}`;
    const tool = symbol ? "find_symbol_references" : "search_changed_files";
    const kind = symbol ? "symbol_references" : "changed_files_search";
    return this.evidence(role, kind, tool, symbol ? { symbol: query } : { query }, content,
      {}, searched < this.changedPaths.length || matches.length >= REPOSITORY_READ_LIMITS.maxSearchMatches);
  }

  private async readManifest(role: DeepReviewRole, kind: keyof typeof MANIFEST_PATHS, signal?: AbortSignal): Promise<EvidenceRecord> {
    for (const candidate of MANIFEST_PATHS[kind]) {
      if (isSensitivePath(candidate)) continue;
      try {
        const content = await this.readText(candidate, signal);
        return this.evidence(role, "manifest", "read_manifest", { kind }, content, { path: candidate });
      } catch (error) {
        if (!(error instanceof RepositoryFileUnavailableError)) throw error;
      }
    }
    throw new RepositoryFileUnavailableError(`no ${kind} manifest exists at the fixed revision`);
  }

  private async ciStatus(role: DeepReviewRole, signal?: AbortSignal): Promise<EvidenceRecord> {
    const value = await this.options.adapter.readCiStatus(signal);
    return this.evidence(role, "ci_status", "read_ci_status", {}, JSON.stringify(value), {});
  }

  private async readText(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const safePath = assertSafePath(path);
    const result = await this.options.adapter.readFile(safePath, signal);
    if (!result) throw new RepositoryFileUnavailableError("repository file was not found at the fixed revision");
    if (result.path !== safePath || result.mode === "120000") throw new Error("repository adapter returned a symlink or mismatched path");
    if (result.bytes.byteLength > REPOSITORY_READ_LIMITS.maxFileBytes) throw new Error("repository file exceeds the read limit");
    if (result.bytes.includes(0)) throw new Error("binary repository content is not readable");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    return redactRepositoryText(decoded);
  }

  private evidence(
    role: DeepReviewRole,
    kind: EvidenceKind,
    toolName: ReadonlyToolRequest["name"],
    request: Record<string, unknown>,
    content: string,
    location: { path?: string; startLine?: number; endLine?: number },
    forceTruncated = false,
  ): EvidenceRecord & { requestHash: string } {
    content = redactRepositoryText(content);
    const truncated = forceTruncated || content.includes("[REDACTED]")
      || content.length > REPOSITORY_READ_LIMITS.maxSummaryChars;
    const summary = content.slice(0, REPOSITORY_READ_LIMITS.maxSummaryChars);
    const contentHash = fingerprint({ content });
    const requestHash = fingerprint({ identity: this.identity, role,
      request: { name: toolName, ...request } });
    const id = fingerprint({ ...this.identity, toolName, requestHash, contentHash, location });
    return { id, runId: this.identity.runId, headSha: this.identity.headSha,
      kind, status: "succeeded", requestHash, contentHash, summary, truncated, ...location };
  }
}

export class RepositoryFileUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryFileUnavailableError"; }
}

export function assertSafePath(raw: string): string {
  if (!raw || raw.length > 512 || raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) {
    throw new Error("repository path is invalid");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("repository path traversal is not allowed");
  }
  if (isSensitivePath(raw)) throw new Error("sensitive repository path is not readable");
  return raw;
}

export function redactRepositoryText(text: string): string {
  return redactKnownSecretValues(text.replace(PRIVATE_KEY, (value) => "[REDACTED]" + "\n".repeat((value.match(/\n/g) ?? []).length)))
    .replace(TOKEN_VALUE, "[REDACTED]")
    .replace(SECRET_VALUE, "$1[REDACTED]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function boundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("provider response exceeds the read limit");
  if (!response.body) return JSON.parse(await response.text()) as T;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error("provider response exceeds the read limit");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
}

export function repositoryReadSignal(parent?: AbortSignal, timeoutMs = 10_000, role?: AbortSignal): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("repository read timeout must be between 100 and 30000ms");
  }
  return AbortSignal.any([parent, role, AbortSignal.timeout(timeoutMs)]
    .filter((value): value is AbortSignal => Boolean(value)));
}
