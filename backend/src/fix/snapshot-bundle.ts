import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { fingerprint } from "../harness/versions.js";

const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;

export interface SnapshotSourceFile { path: string; content: Uint8Array }
export interface SnapshotBundleResult {
  sourceBundleRef: string;
  sourceBundleHash: string;
  manifest: { schemaVersion: 1; sourceBundleHash: string; headSha: string; dependencyLockHash: string;
    files: Array<{ path: string; sha256: string; size: number; mode: "file" }> };
}

export interface ReadSnapshotBundleResult extends SnapshotBundleResult {
  files: ReadonlyMap<string, string>;
}

export function calculateSnapshotBundleHash(input: { headSha: string; dependencyLockHash: string;
  files: readonly SnapshotSourceFile[] }): string {
  const records = input.files.map((file) => ({ path: safePath(file.path), sha256: fingerprintBytes(file.content),
    size: file.content.byteLength, mode: "file" as const })).sort((left, right) => left.path.localeCompare(right.path));
  return fingerprint({ schemaVersion: 1, headSha: input.headSha, dependencyLockHash: input.dependencyLockHash, files: records });
}

/** Reads only a content-addressed bundle created by writeSnapshotBundle and revalidates every byte. */
export async function readSnapshotBundle(input: { root: string; sourceBundleRef: string;
  sourceBundleHash: string }): Promise<ReadSnapshotBundleResult> {
  if (input.sourceBundleRef !== `snapshot:${input.sourceBundleHash}` || !/^[a-f0-9]{64}$/.test(input.sourceBundleHash)) {
    throw new Error("invalid snapshot reference");
  }
  const root = await realpath(resolve(input.root));
  const target = await realpath(join(root, input.sourceBundleHash));
  if (target !== join(root, input.sourceBundleHash)) throw new Error("snapshot escapes root");
  const manifestPath = join(target, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 2 * 1024 * 1024) throw new Error("invalid snapshot manifest file");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotBundleResult["manifest"];
  if (manifest.schemaVersion !== 1 || manifest.sourceBundleHash !== input.sourceBundleHash
      || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) {
    throw new Error("snapshot manifest mismatch");
  }
  const ordered = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(ordered.map(({ path }) => safePath(path))).size !== ordered.length
      || fingerprint({ schemaVersion: 1, headSha: manifest.headSha,
        dependencyLockHash: manifest.dependencyLockHash, files: ordered }) !== input.sourceBundleHash) {
    throw new Error("snapshot manifest hash mismatch");
  }
  let total = 0;
  const files = new Map<string, string>();
  for (const record of ordered) {
    if (record.mode !== "file" || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error("invalid snapshot file");
    const path = safePath(record.path);
    const filePath = join(target, "files", path);
    const fileInfo = await lstat(filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== record.size) throw new Error("invalid snapshot file");
    const bytes = await readFile(filePath);
    total += bytes.byteLength;
    if (total > MAX_BYTES || bytes.byteLength !== record.size || bytes.includes(0)
        || fingerprintBytes(bytes) !== record.sha256) throw new Error("snapshot file content mismatch");
    files.set(path, bytes.toString("utf8"));
  }
  return { sourceBundleRef: input.sourceBundleRef, sourceBundleHash: input.sourceBundleHash, manifest, files };
}

/** Trusted fixed-SHA collector output only; never pass request paths or arbitrary host files. */
export async function writeSnapshotBundle(input: { root: string; headSha: string;
  dependencyLockHash: string; files: readonly SnapshotSourceFile[] }): Promise<SnapshotBundleResult> {
  if (!resolve(input.root).startsWith("/") || !/^[a-f0-9]{40,64}$/.test(input.headSha)
      || !/^[a-f0-9]{64}$/.test(input.dependencyLockHash)) throw new Error("invalid snapshot identity");
  if (input.files.length === 0 || input.files.length > MAX_FILES) throw new Error("snapshot file count exceeds limit");
  let total = 0;
  const records = input.files.map((file) => {
    const path = safePath(file.path);
    if (file.content.includes(0)) throw new Error("binary snapshot files are unsupported");
    total += file.content.byteLength;
    if (total > MAX_BYTES) throw new Error("snapshot bytes exceed limit");
    return { path, content: file.content, sha256: fingerprintBytes(file.content), size: file.content.byteLength };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(records.map(({ path }) => path)).size !== records.length) throw new Error("duplicate snapshot path");
  const identity = { schemaVersion: 1 as const, headSha: input.headSha,
    dependencyLockHash: input.dependencyLockHash,
    files: records.map(({ path, sha256, size }) => ({ path, sha256, size, mode: "file" as const })) };
  const sourceBundleHash = fingerprint(identity);
  const manifest = { ...identity, sourceBundleHash };
  const root = resolve(input.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, sourceBundleHash);
  const temporary = join(root, `.tmp-${sourceBundleHash}-${randomUUID()}`);
  try {
    await mkdir(temporary, { mode: 0o700 });
    for (const file of records) {
      const destination = join(temporary, "files", file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      const handle = await open(destination, "wx", 0o444);
      try { await handle.writeFile(file.content); await handle.sync(); } finally { await handle.close(); }
    }
    const manifestHandle = await open(join(temporary, "manifest.json"), "wx", 0o444);
    try { await manifestHandle.writeFile(JSON.stringify(manifest)); await manifestHandle.sync(); }
    finally { await manifestHandle.close(); }
    await rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      await validateExisting(target, manifest);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { sourceBundleRef: `snapshot:${sourceBundleHash}`, sourceBundleHash, manifest };
}

async function validateExisting(target: string, manifest: SnapshotBundleResult["manifest"]): Promise<void> {
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error("snapshot hash target is not a directory");
  const existing = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  if (fingerprint(existing) !== fingerprint(manifest)) throw new Error("snapshot hash collision");
}

function safePath(value: string): string {
  if (!value || value.length > 512 || value.startsWith("/") || value.includes("\\") || value.includes("\0")
      || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe snapshot path");
  return value;
}
function fingerprintBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
