import { createHash } from "node:crypto";

import type { RepositoryReadAdapter } from "../integrations/shared/repository-read-tools.js";
import { assertSafePath, isSensitivePath, redactRepositoryText } from "../integrations/shared/repository-read-tools.js";
import { fingerprint } from "../agent-runtime/versions.js";
import { assertDatasetPath, type DatasetCaseSource, type DatasetFixtureFile, type DatasetFixtureV1 } from "./dataset-contracts.js";

const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|tsconfig\.json|Makefile|build\.gradle(?:\.kts)?|\.gitlab-ci\.yml|\.github\/workflows\/[^/]+\.ya?ml)$/i;
const EXCLUDED = /(^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|generated)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._/-]|$)|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|wasm|so|dll|dylib|exe|bin|map|min\.js|pem|key|p12|pfx|tfvars)$/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SENSITIVE_JSON_KEY = /^(?:token|password|passwd|secret|api[_-]?key|private[_-]?key)$/i;

export interface DatasetRepositoryAdapter extends RepositoryReadAdapter {
  listFiles(signal?: AbortSignal): Promise<string[]>;
}

export async function buildDatasetFixture(
  source: DatasetCaseSource,
  adapter: DatasetRepositoryAdapter,
  signal?: AbortSignal,
): Promise<DatasetFixtureV1> {
  signal?.throwIfAborted();
  const listed = await adapter.listFiles(signal);
  if (!listed.length || listed.length > MAX_FILES) throw new Error("repository tree exceeds dataset fixture limits");
  const treePaths = [...new Set(listed.map(assertDatasetPath))];
  const tree = new Set(treePaths);
  const changedPaths = declaredChangedPaths(source.collected);
  for (const path of changedPaths) {
    if (isSensitivePath(path) || EXCLUDED.test(path)) throw new Error(`declared changed file is sensitive or unsupported: ${path}`);
    assertSafePath(path);
    if (!tree.has(path)) throw new Error(`declared changed file is unavailable at the fixed revision: ${path}`);
  }
  const paths = [...new Set([
    ...changedPaths,
    ...treePaths.filter((path) => !isSensitivePath(path) && !EXCLUDED.test(path) && MANIFEST.test(path)),
  ])].sort();
  if (!paths.length || paths.length > MAX_FILES) throw new Error("filtered repository fixture is empty or oversized");
  let totalBytes = 0;
  const files: DatasetFixtureFile[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    const file = await adapter.readFile(path, signal);
    if (!file || file.path !== path || file.mode === "120000") throw new Error("fixed repository fixture changed during collection");
    if (file.bytes.byteLength > MAX_FILE_BYTES || file.bytes.includes(0)) throw new Error("repository fixture contains unsupported content");
    const rawContent = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const content = redactFileContent(rawContent);
    const sizeBytes = Buffer.byteLength(content);
    totalBytes += sizeBytes;
    if (totalBytes > MAX_BYTES) throw new Error("repository fixture exceeds total byte limit");
    files.push({ path, kind: MANIFEST.test(path) ? "manifest" : "source", content,
      contentHash: sha256(content), sizeBytes });
  }
  const input = redactDatasetJson(source.input) as Record<string, unknown>;
  const collected = redactDatasetJson(source.collected) as Record<string, unknown>;
  const ci = { value: redactDatasetJson(await adapter.readCiStatus(signal)) };
  const readableTreePaths = treePaths.filter((path) => !isSensitivePath(path) && !EXCLUDED.test(path));
  const repositoryReadComplete = readableTreePaths.every((path) => paths.includes(path));
  const identity = { schemaVersion: 1 as const, sourceRunId: source.sourceRunId, platform: source.platform,
    repository: source.repository, pullNumber: source.pullNumber, baseSha: source.baseSha, headSha: source.headSha,
    sourceCreatedAt: source.sourceCreatedAt, input, collected,
    coverage: { status: "complete" as const, reasonCodes: [] as [],
      repositoryRead: { status: repositoryReadComplete ? "complete" as const : "partial" as const,
        reasonCodes: repositoryReadComplete ? [] : ["repository_read_scoped_to_changed_and_manifests"],
        availablePaths: paths } }, ci,
    files: files.map(({ content, ...metadata }) => ({ ...metadata, contentHash: sha256(content) })), totalBytes };
  return { ...identity, files, fixtureHash: fingerprint(identity) };
}

export function validateDatasetFixture(source: Pick<DatasetCaseSource, "sourceRunId" | "platform" | "repository" |
  "pullNumber" | "baseSha" | "headSha" | "sourceCreatedAt" | "input" | "collected">, fixture: DatasetFixtureV1): void {
  if (fixture.schemaVersion !== 1 || fixture.sourceRunId !== source.sourceRunId || fixture.platform !== source.platform
      || fixture.repository !== source.repository || fixture.pullNumber !== source.pullNumber
      || fixture.baseSha !== source.baseSha || fixture.headSha !== source.headSha
      || fixture.sourceCreatedAt !== source.sourceCreatedAt || fixture.coverage.status !== "complete"
      || fixture.coverage.reasonCodes.length !== 0 || fixture.files.length === 0 || fixture.files.length > MAX_FILES
      || fingerprint(fixture.input) !== fingerprint(redactDatasetJson(source.input))
      || fingerprint(fixture.collected) !== fingerprint(redactDatasetJson(source.collected))) {
    throw new Error("dataset fixture identity mismatch");
  }
  const expectedAvailablePaths = fixture.files.map(({ path }) => path).sort();
  const repositoryRead = fixture.coverage.repositoryRead;
  if (!repositoryRead || !Array.isArray(repositoryRead.availablePaths) || !Array.isArray(repositoryRead.reasonCodes)
      || fingerprint(repositoryRead.availablePaths.slice().sort()) !== fingerprint(expectedAvailablePaths)
      || (repositoryRead.status === "complete"
        ? repositoryRead.reasonCodes.length !== 0
        : repositoryRead.status !== "partial"
          || !repositoryRead.reasonCodes.includes("repository_read_scoped_to_changed_and_manifests"))) {
    throw new Error("dataset fixture repository-read coverage mismatch");
  }
  let total = 0;
  const paths = new Set<string>();
  for (const file of fixture.files) {
    assertDatasetPath(file.path);
    const size = Buffer.byteLength(file.content);
    if (paths.has(file.path) || size !== file.sizeBytes || size > MAX_FILE_BYTES
        || sha256(file.content) !== file.contentHash || file.content.includes("\0")) {
      throw new Error("dataset fixture file mismatch");
    }
    paths.add(file.path); total += size;
  }
  if (total !== fixture.totalBytes || total > MAX_BYTES) throw new Error("dataset fixture byte count mismatch");
  const { fixtureHash, files, ...rest } = fixture;
  const identity = { ...rest, files: files.map(({ content: _content, ...metadata }) => metadata) };
  if (fingerprint(identity) !== fixtureHash) throw new Error("dataset fixture hash mismatch");
}

export function computeLineageHash(repository: string, pullNumber: number): string {
  return fingerprint({ schemaVersion: 1, repository: repository.normalize("NFC").toLowerCase(), pullNumber });
}

export function computeShingleSignature(files: readonly DatasetFixtureFile[]): string[] {
  const hashes = new Set<string>();
  for (const file of files) {
    const normalized = file.content.normalize("NFC").replace(/\s+/g, " ").trim();
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length < 5) hashes.add(sha256(`${file.path}\0${normalized}`));
    else for (let index = 0; index <= tokens.length - 5; index += 1) {
      hashes.add(sha256(tokens.slice(index, index + 5).join(" ")));
    }
  }
  return [...hashes].sort().slice(0, 256);
}

export function shingleSimilarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left); const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function declaredChangedPaths(collected: Record<string, unknown>): string[] {
  const files = collected.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new Error("persisted collection does not contain a bounded changed file list");
  }
  return [...new Set(files.flatMap((file) => {
    if (!file || typeof file !== "object" || typeof (file as { newPath?: unknown }).newPath !== "string") {
      throw new Error("persisted collection contains an invalid changed file path");
    }
    const path = assertDatasetPath((file as { newPath: string }).newPath);
    const status = (file as { status?: unknown }).status;
    if (status === "removed" || status === "deleted") return [];
    return [path];
  }))].sort();
}

export function redactDatasetJson(value: unknown): unknown {
  return redactDatasetJsonValue(value);
}

function redactDatasetJsonValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key && SENSITIVE_JSON_KEY.test(key)
    ? `[REDACTED]${"\n".repeat(countNewlines(value))}` : redactFileContent(value);
  if (Array.isArray(value)) return value.map((entry) => redactDatasetJsonValue(entry));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) output[entryKey] = redactDatasetJsonValue(entry, entryKey);
    return output;
  }
  return value;
}

function redactFileContent(content: string): string {
  const linePreserving = content.replace(PRIVATE_KEY_BLOCK, (match) =>
    `[REDACTED]${"\n".repeat(countNewlines(match))}`);
  return redactRepositoryText(linePreserving);
}

function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
