import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { prepareRunArtifact, RUN_ARTIFACT_LIMITS, type PreparedRunArtifact } from "../../agent-runtime/artifacts/index.js";
import { canonicalJson, fingerprint } from "../../agent-runtime/versions.js";

const MAX_FILES = 2_000;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const FIX_SNAPSHOT_CONTENT_TYPE = "application/vnd.pr-agent.fix-snapshot+json;version=1";

export interface SnapshotSourceFile { path: string; content: Uint8Array }
export interface SnapshotManifest { schemaVersion: 1; sourceBundleHash: string; headSha: string;
  dependencyLockHash: string; files: Array<{ path: string; sha256: string; size: number; mode: "file" }> }
export interface PreparedSnapshotBundle { sourceBundleRef: string; sourceBundleHash: string;
  manifest: SnapshotManifest; artifact: PreparedRunArtifact; content: Buffer }
export interface ReadSnapshotBundleResult { sourceBundleRef: string; sourceBundleHash: string;
  manifest: SnapshotManifest; files: ReadonlyMap<string, string> }
interface SnapshotEnvelope { schemaVersion: 1; headSha: string; dependencyLockHash: string;
  files: Array<{ path: string; sha256: string; size: number; mode: "file"; content: string }> }

/** Builds the exact canonical bytes stored in PostgreSQL. No source snapshot is truncated. */
export async function prepareSnapshotBundle(input: { headSha: string; dependencyLockHash: string;
  files: readonly SnapshotSourceFile[] }): Promise<PreparedSnapshotBundle> {
  const envelope = snapshotEnvelope(input);
  const raw = Buffer.from(canonicalJson(envelope), "utf8");
  const sourceBundleHash = fingerprint(envelope);
  const artifact = await prepareRunArtifact(raw, { contentType: FIX_SNAPSHOT_CONTENT_TYPE, purpose: "fix_snapshot" });
  if (artifact.artifactHash !== sourceBundleHash) throw new Error("snapshot fingerprint is not its artifact identity");
  return { sourceBundleRef: `artifact:${sourceBundleHash}`, sourceBundleHash,
    manifest: manifestFromEnvelope(envelope, sourceBundleHash), artifact, content: raw };
}

export function readSnapshotBundleContent(input: { content: Uint8Array; sourceBundleRef: string;
  sourceBundleHash: string }): ReadSnapshotBundleResult {
  assertSnapshotIdentity(input.sourceBundleRef, input.sourceBundleHash);
  const raw = Buffer.from(input.content);
  if (raw.byteLength > RUN_ARTIFACT_LIMITS.maxRawBytes) throw new Error("snapshot artifact exceeds raw byte limit");
  if (sha256(raw) !== input.sourceBundleHash) throw new Error("snapshot artifact hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(utf8.decode(raw)); }
  catch { throw new Error("snapshot artifact is not canonical UTF-8 JSON"); }
  const envelope = parseEnvelope(parsed);
  if (canonicalJson(envelope) !== raw.toString("utf8") || fingerprint(envelope) !== input.sourceBundleHash) {
    throw new Error("snapshot artifact canonical identity mismatch");
  }
  return { sourceBundleRef: input.sourceBundleRef, sourceBundleHash: input.sourceBundleHash,
    manifest: manifestFromEnvelope(envelope, input.sourceBundleHash),
    files: new Map(envelope.files.map((file) => [file.path, file.content])) };
}

/** Materializes only server-validated content into a fresh operator-owned directory and always removes it. */
export async function withMaterializedSnapshot<T>(input: { content: Uint8Array; sourceBundleRef: string;
  sourceBundleHash: string }, action: (directory: string) => Promise<T>): Promise<T> {
  const snapshot = readSnapshotBundleContent(input);
  const root = await mkdtemp(join(tmpdir(), "pr-agent-fix-snapshot-"));
  try {
    await writeExclusive(join(root, "manifest.json"), Buffer.from(JSON.stringify(snapshot.manifest)), 0o400);
    for (const [path, content] of snapshot.files) {
      const destination = join(root, "files", safePath(path));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeExclusive(destination, Buffer.from(content, "utf8"), 0o400);
    }
    return await action(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function snapshotEnvelope(input: { headSha: string; dependencyLockHash: string;
  files: readonly SnapshotSourceFile[] }): SnapshotEnvelope {
  if (!/^[a-f0-9]{40,64}$/.test(input.headSha) || !/^[a-f0-9]{64}$/.test(input.dependencyLockHash)) {
    throw new Error("invalid snapshot identity");
  }
  if (input.files.length === 0 || input.files.length > MAX_FILES) throw new Error("snapshot file count exceeds limit");
  const files = input.files.map((file) => {
    const path = safePath(file.path); let content: string;
    try { content = utf8.decode(file.content); } catch { throw new Error(`snapshot file is not valid UTF-8: ${path}`); }
    if (content.includes("\0")) throw new Error(`snapshot file contains binary content: ${path}`);
    const bytes = Buffer.from(content, "utf8");
    if (!bytes.equals(Buffer.from(file.content))) throw new Error(`snapshot UTF-8 is not canonical: ${path}`);
    return { path, sha256: sha256(bytes), size: bytes.byteLength, mode: "file" as const, content };
  }).sort((left, right) => comparePath(left.path, right.path));
  if (new Set(files.map(({ path }) => path)).size !== files.length) throw new Error("duplicate snapshot path");
  return { schemaVersion: 1, headSha: input.headSha, dependencyLockHash: input.dependencyLockHash, files };
}

function parseEnvelope(value: unknown): SnapshotEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot envelope is invalid");
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.headSha !== "string" || !/^[a-f0-9]{40,64}$/.test(row.headSha)
      || typeof row.dependencyLockHash !== "string" || !/^[a-f0-9]{64}$/.test(row.dependencyLockHash)
      || !Array.isArray(row.files) || row.files.length === 0 || row.files.length > MAX_FILES
      || Object.keys(row).some((key) => !["schemaVersion", "headSha", "dependencyLockHash", "files"].includes(key))) {
    throw new Error("snapshot envelope is invalid");
  }
  const files = row.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot file is invalid");
    const file = value as Record<string, unknown>; const path = safePath(file.path);
    if (file.mode !== "file" || typeof file.content !== "string" || typeof file.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || Number(file.size) < 0
        || Object.keys(file).some((key) => !["path", "sha256", "size", "mode", "content"].includes(key))) {
      throw new Error("snapshot file metadata is invalid");
    }
    if (file.content.includes("\0")) throw new Error("snapshot file contains binary content");
    const bytes = Buffer.from(file.content, "utf8");
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw new Error("snapshot file content mismatch");
    return { path, sha256: file.sha256, size: Number(file.size), mode: "file" as const, content: file.content };
  });
  const sorted = [...files].sort((left, right) => comparePath(left.path, right.path));
  if (new Set(sorted.map(({ path }) => path)).size !== sorted.length
      || sorted.some((file, index) => file.path !== files[index]?.path)) throw new Error("snapshot file ordering is invalid");
  return { schemaVersion: 1, headSha: row.headSha, dependencyLockHash: row.dependencyLockHash, files };
}

function manifestFromEnvelope(envelope: SnapshotEnvelope, sourceBundleHash: string): SnapshotManifest {
  return { schemaVersion: 1, sourceBundleHash, headSha: envelope.headSha,
    dependencyLockHash: envelope.dependencyLockHash,
    files: envelope.files.map(({ content: _content, ...file }) => file) };
}
function assertSnapshotIdentity(ref: string, hash: string): void {
  if (ref !== `artifact:${hash}` || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid snapshot artifact reference");
}
async function writeExclusive(path: string, content: Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
function safePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.startsWith("/") || value.includes("\\")
      || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("unsafe snapshot path");
  }
  return value;
}
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function comparePath(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
