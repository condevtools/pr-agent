import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import type { FixProposal, VerificationPolicy, VerificationResult } from "../contracts.js";
import { assertVerifierPolicy, expectedSandboxPolicyHash, isAllowedAddedTest } from "./sandbox-policy.js";
import { evaluateVerificationResult, sandboxCommandResultSchema, sandboxRunnerResultSchema } from "./sandbox-result.js";
import { fingerprint } from "../../agent-runtime/versions.js";

const MAX_SNAPSHOT_FILES = 2_000;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

interface SnapshotManifest {
  schemaVersion: 1;
  sourceBundleHash: string;
  headSha: string;
  dependencyLockHash: string;
  files: Array<{ path: string; sha256: string; size: number; mode: "file" }>;
}

export interface DockerVerifierOptions {
  snapshotRoot: string;
  dockerBinary?: string;
}

export interface VerifierResourceContext {
  jobId: string;
  owner: string;
  epoch: number;
  deadlineAt: string;
}

export interface VerifierSweepResult {
  removedContainers: number;
  removedVolumes: number;
  failures: string[];
}

export class DockerFixVerifier {
  private containerCursor = "";
  private volumeCursor = "";
  constructor(private readonly options: DockerVerifierOptions) {
    if (!isAbsolute(options.snapshotRoot)) throw new Error("verifier snapshot root must be absolute");
  }

  async verify(proposal: FixProposal, rawPolicy: VerificationPolicy,
    resource: VerifierResourceContext, signal?: AbortSignal): Promise<VerificationResult> {
    const policy = assertVerifierPolicy(rawPolicy);
    const resourceLabels = labelsForResource(resource);
    if (policy.sandboxHash !== expectedSandboxPolicyHash(policy)) {
      throw new Error("sandbox policy hash does not match the implemented isolation profile");
    }
    if (!policy.publishEnabled && policy.nodeImageDigest.endsWith("0".repeat(64))) {
      return unavailable(proposal, policy, "verifier_disabled");
    }
    if (proposal.policyHash !== policy.hash || proposal.sandboxPolicyHash !== policy.sandboxHash
        || proposal.imageDigest !== policy.nodeImageDigest
        || proposal.trustedCommandHash !== fingerprint(policy.argv)
        || proposal.dependencyLockPath !== policy.dependencyLockPath
        || proposal.dependencyLockHash !== policy.dependencyLockHash) {
      return unavailable(proposal, policy, "verification_policy_mismatch");
    }
    const snapshot = await this.loadSnapshot(proposal, policy);
    const targetTestFiles = addedTestFiles(proposal.testPatch, policy);
    const relevance = attestRelevance(proposal.testPatch, targetTestFiles, policy.relevanceTokens);
    if (targetTestFiles.length === 0) return unavailable(proposal, policy, "target_test_missing", relevance);
    if (signal?.aborted) throw signal.reason ?? new Error("verification aborted");
    const runner = await this.runContainer(snapshot, policy, proposal, targetTestFiles, resource, resourceLabels, signal);
    const logHashes = Object.fromEntries(Object.entries(runner).filter(([key]) => key !== "protocolVersion")
      .map(([key, value]) => [key, sha256((value as { log: string }).log)])) as VerificationResult["logHashes"];
    return evaluateVerificationResult({ runner, relevance: relevance.status,
      relevanceReasons: relevance.reasonCodes, imageDigest: policy.nodeImageDigest,
      policyHash: policy.hash, proposalHash: proposal.proposalHash, logHashes });
  }

  sweepExpiredResources(databaseNow: Date, graceMs = 60_000, limit = 100): VerifierSweepResult {
    if (!Number.isFinite(databaseNow.getTime()) || !Number.isSafeInteger(graceMs) || graceMs < 0
        || !Number.isSafeInteger(limit) || limit < 2 || limit > 100) throw new Error("invalid verifier sweep bounds");
    const docker = this.options.dockerBinary ?? "docker";
    const result: VerifierSweepResult = { removedContainers: 0, removedVolumes: 0, failures: [] };
    const containerLimit = Math.ceil(limit / 2);
    const volumeLimit = Math.floor(limit / 2);
    const containerIds = resourcePage(listDocker(docker, ["ps", "-aq", "--filter", "label=pr-agent.fix-verifier=true",
      "--filter", "label=pr-agent.fix-verifier-version=1"]), this.containerCursor, containerLimit);
    this.containerCursor = containerIds.at(-1) ?? "";
    for (const id of containerIds) {
      const inspected = inspectDocker(docker, "container", id);
      if (!inspected || !isExpiredOwnedResource(inspected.name, inspected.labels, databaseNow, graceMs, "container")) continue;
      const removed = dockerCommand(docker, ["rm", "--force", id]);
      if (removed.ok) result.removedContainers += 1;
      else result.failures.push(`container:${id.slice(0, 12)}`);
    }
    const volumes = resourcePage(listDocker(docker, ["volume", "ls", "-q", "--filter", "label=pr-agent.fix-verifier=true",
      "--filter", "label=pr-agent.fix-verifier-version=1"]), this.volumeCursor, volumeLimit);
    this.volumeCursor = volumes.at(-1) ?? "";
    for (const name of volumes) {
      const inspected = inspectDocker(docker, "volume", name);
      if (!inspected || !isExpiredOwnedResource(inspected.name, inspected.labels, databaseNow, graceMs, "volume")) continue;
      const removed = dockerCommand(docker, ["volume", "rm", "--force", name]);
      if (removed.ok) result.removedVolumes += 1;
      else result.failures.push(`volume:${name}`);
    }
    return result;
  }

  private async loadSnapshot(proposal: FixProposal, policy: VerificationPolicy): Promise<{
    manifest: SnapshotManifest; files: Array<{ path: string; content: string }>;
  }> {
    if (proposal.sourceBundleRef !== `snapshot:${proposal.sourceBundleHash}`) throw new Error("source bundle reference is not content addressed");
    const root = await realpath(this.options.snapshotRoot);
    const directory = await realpath(join(root, proposal.sourceBundleHash));
    if (relative(root, directory).startsWith("..")) throw new Error("source snapshot escapes verifier root");
    const manifestPath = join(directory, "manifest.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 2 * 1024 * 1024) {
      throw new Error("source snapshot manifest is not a regular bounded file");
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
    if (manifest.schemaVersion !== 1 || manifest.sourceBundleHash !== proposal.sourceBundleHash
        || manifest.headSha !== proposal.headSha || manifest.dependencyLockHash !== policy.dependencyLockHash
        || !Array.isArray(manifest.files) || manifest.files.length > MAX_SNAPSHOT_FILES) {
      throw new Error("source snapshot manifest mismatch");
    }
    const normalized = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(normalized.map(({ path }) => path)).size !== normalized.length
        || fingerprint({ schemaVersion: 1, headSha: manifest.headSha,
          dependencyLockHash: manifest.dependencyLockHash, files: normalized }) !== manifest.sourceBundleHash) {
      throw new Error("source snapshot manifest hash mismatch");
    }
    let bytes = 0;
    const files: Array<{ path: string; content: string }> = [];
    for (const file of normalized) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error("snapshot file metadata is invalid");
      }
      const path = safeRelativePath(file.path);
      const full = resolve(directory, "files", path);
      if (relative(resolve(directory, "files"), full).startsWith("..")) throw new Error("snapshot file escapes bundle");
      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || file.mode !== "file") {
        throw new Error("snapshot contains a non-regular file");
      }
      bytes += info.size;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("source snapshot exceeds byte limit");
      const content = await readFile(full);
      if (content.includes(0) || sha256(content) !== file.sha256) throw new Error("snapshot file content mismatch");
      files.push({ path, content: content.toString("base64") });
    }
    const dependencyLock = normalized.find(({ path }) => path === policy.dependencyLockPath);
    if (!dependencyLock || dependencyLock.sha256 !== policy.dependencyLockHash) {
      throw new Error("snapshot dependency lock mismatch");
    }
    return { manifest, files };
  }

  private async runContainer(
    snapshot: { manifest: SnapshotManifest; files: Array<{ path: string; content: string }> },
    policy: VerificationPolicy,
    proposal: FixProposal,
    targetTestFiles: readonly string[],
    resource: VerifierResourceContext,
    resourceLabels: readonly string[],
    signal?: AbortSignal,
  ) {
    const docker = this.options.dockerBinary ?? "docker";
    const resourceSuffix = resourceNameSuffix(resource);
    const volume = `pr-agent-fix-snapshot-${resourceSuffix}-${randomUUID().slice(0, 8)}`;
    const volumeLabelArgs = resourceLabels.flatMap((label) => ["--label", label]);
    const created = spawnSync(docker, ["volume", "create", ...volumeLabelArgs, volume],
      { timeout: 10_000, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    if (created.status !== 0) throw new Error("could not create isolated verifier snapshot volume");
    const seedName = `pr-agent-fix-seed-${resourceSuffix}-${randomUUID().slice(0, 8)}`;
    try {
      const seedScript = `const fs=require('node:fs'),p=require('node:path');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const x=JSON.parse(s),safe=v=>{if(!v||v[0]=='/'||v.includes('\\\\')||v.split('/').some(q=>!q||q=='.'||q=='..'))throw Error('path');return v};fs.writeFileSync('/seed/manifest.json',JSON.stringify(x.manifest),{mode:0o444});for(const f of x.files){const d=p.join('/seed/files',safe(f.path));fs.mkdirSync(p.dirname(d),{recursive:true,mode:0o755});fs.writeFileSync(d,Buffer.from(f.content,'base64'),{mode:0o444})}});`;
      const seeded = spawnSync(docker, ["run", "--rm", "-i", "--name", seedName,
        ...volumeLabelArgs, "--pull", "never", "--network", "none",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--mount", `type=volume,src=${volume},dst=/seed`, "--entrypoint", "node",
        policy.nodeImageDigest, "-e", seedScript], {
        input: JSON.stringify(snapshot), timeout: 30_000, maxBuffer: 256 * 1024,
        encoding: "utf8", env: { PATH: process.env.PATH ?? "" },
      });
      if (seeded.status !== 0) {
        removeContainerOrThrow(docker, seedName);
        throw new Error("could not seed isolated verifier snapshot volume");
      }
      const phaseDeadline = Math.max(1_000, Math.floor(policy.deadlineMs / 4));
      const phase = (patches: readonly string[], argv: readonly string[]) => this.runSeededContainer(volume, policy, {
        protocolVersion: 1, patches, argv, deadlineMs: phaseDeadline, maxLogBytes: policy.maxLogBytes,
      }, resourceSuffix, resourceLabels, signal, phaseDeadline + 2_000);
      return sandboxRunnerResultSchema.parse({ protocolVersion: 1,
        baselineTarget: await phase([proposal.testPatch], ["node", "--test", ...targetTestFiles]),
        patchedTarget: await phase([proposal.testPatch, proposal.codePatch], ["node", "--test", ...targetTestFiles]),
        baselineRegression: await phase([], policy.argv),
        patchedRegression: await phase([proposal.codePatch], policy.argv),
      });
    } finally {
      removeVolumeOrThrow(docker, volume);
    }
  }

  private async runSeededContainer(
    snapshotVolume: string,
    policy: VerificationPolicy,
    input: Record<string, unknown>,
    resourceSuffix: string,
    resourceLabels: readonly string[],
    signal?: AbortSignal,
    timeoutMs = policy.deadlineMs,
  ) {
    const docker = this.options.dockerBinary ?? "docker";
    const name = `pr-agent-fix-phase-${resourceSuffix}-${randomUUID().slice(0, 8)}`;
    const args = ["run", "--rm", "-i", "--name", name,
      ...resourceLabels.flatMap((label) => ["--label", label]),
      "--pull", "never", "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65532:65532",
      "--pids-limit", String(policy.pidsLimit), "--memory", `${policy.memoryMb}m`, "--memory-swap", `${policy.memoryMb}m`,
      "--cpus", String(policy.cpuCount), "--ulimit", "nofile=256:256", "--ipc", "none", "--hostname", "fix-sandbox",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777",
      "--tmpfs", `/workspace:rw,noexec,nosuid,nodev,size=${policy.tmpfsMb}m,uid=65532,gid=65532,mode=700`,
      "--mount", `type=volume,src=${snapshotVolume},dst=/snapshot,readonly`,
      "--workdir", "/workspace", "--entrypoint", "node", policy.nodeImageDigest,
      "/opt/pr-agent-verifier/fix-sandbox-runner.mjs"];
    const child = spawn(docker, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (captured >= policy.maxLogBytes * 2) return;
      const remaining = policy.maxLogBytes * 2 - captured;
      target.push(chunk.subarray(0, remaining)); captured += Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
    child.stdin.end(JSON.stringify(input));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timer.unref();
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolveExit) => {
      child.once("error", (error) => resolveExit({ code: null, error }));
      child.once("close", (code) => resolveExit({ code }));
    });
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    if (timedOut || signal?.aborted) {
      removeContainerOrThrow(docker, name);
      throw new VerifierSandboxTimeoutError();
    }
    if (exit.error || exit.code !== 0) {
      const detail = redact(Buffer.concat(stderr).toString("utf8")).replace(/\s+/g, " ").slice(0, 512);
      throw new Error(`sandbox container failed (${exit.code ?? "spawn"})${detail ? `: ${detail}` : ""}`);
    }
    const text = Buffer.concat(stdout).toString("utf8");
    const marker = text.split("\n").reverse().find((line: string) => line.startsWith("VERIFIER_RESULT:"));
    if (!marker) throw new Error(`sandbox result missing: ${redact(Buffer.concat(stderr).toString("utf8")).slice(0, 512)}`);
    return sandboxCommandResultSchema.parse(JSON.parse(marker.slice("VERIFIER_RESULT:".length)));
  }
}

export class VerifierSandboxTimeoutError extends Error {
  constructor() { super("sandbox verification timed out"); this.name = "VerifierSandboxTimeoutError"; }
}

function addedTestFiles(patch: string, policy: VerificationPolicy): string[] {
  const files: string[] = [];
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index] === "--- /dev/null" && lines[index + 1]?.startsWith("+++ b/")) {
      const path = safeRelativePath(lines[index + 1]!.slice(6));
      if (!isAllowedAddedTest(path, policy)) throw new Error("test patch adds a file outside the trusted test prefixes");
      files.push(path);
    }
  }
  return [...new Set(files)].sort();
}

function attestRelevance(testPatch: string, files: readonly string[], tokens: readonly string[]) {
  const reasons: string[] = [];
  if (files.length === 0) reasons.push("no_added_target_test");
  if (!/(?:from\s+["']node:test["']|require\(["']node:test["']\))/.test(testPatch)
      || !/(?:from\s+["']node:assert(?:\/strict)?["']|require\(["']node:assert(?:\/strict)?["']\))/.test(testPatch)) {
    reasons.push("trusted_test_api_missing");
  }
  if (!tokens.some((token) => testPatch.toLowerCase().includes(token.toLowerCase()))) reasons.push("finding_token_missing");
  if (/\b(?:process\.env|Date\.now|Math\.random|setTimeout|fetch\s*\(|node:(?:http|https|net)|\.skip\s*\(|\.only\s*\()/.test(testPatch)) {
    reasons.push("nondeterministic_or_external_test");
  }
  if (reasons.length === 0) reasons.push("relevance_attestation_missing");
  return { status: "unknown" as const, reasonCodes: reasons };
}

function unavailable(proposal: FixProposal, policy: VerificationPolicy, reason: string,
  relevance: { status: "verified" | "failed" | "unknown"; reasonCodes: string[] } = { status: "unknown", reasonCodes: [] }): VerificationResult {
  return { outcome: "suggestion_only", reasonCodes: [...new Set([reason, ...relevance.reasonCodes])],
    baselineTarget: "not_run", patchedTarget: "not_run", baselineRegression: [], patchedRegression: [],
    relevance: relevance.status, logRefs: emptyLogs(), logHashes: emptyLogs(), imageDigest: policy.nodeImageDigest,
    policyHash: policy.hash, proposalHash: proposal.proposalHash };
}

function safeRelativePath(value: string): string {
  if (!value || value.length > 512 || value.startsWith("/") || value.includes("\\") || value.includes("\0")
      || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe relative path");
  return value;
}
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function redact(value: string): string { return value.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]"); }
function emptyLogs(): VerificationResult["logHashes"] {
  return { baselineTarget: undefined, patchedTarget: undefined,
    baselineRegression: undefined, patchedRegression: undefined };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_LABEL = "pr-agent.fix-verifier";

function labelsForResource(resource: VerifierResourceContext): string[] {
  const deadline = new Date(resource.deadlineAt);
  if (!UUID.test(resource.jobId) || !resource.owner || resource.owner.length > 200
      || !Number.isSafeInteger(resource.epoch) || resource.epoch < 1 || !Number.isFinite(deadline.getTime())) {
    throw new Error("invalid verifier resource identity");
  }
  return [`${RESOURCE_LABEL}=true`, `${RESOURCE_LABEL}-version=1`, `${RESOURCE_LABEL}-job=${resource.jobId.toLowerCase()}`,
    `${RESOURCE_LABEL}-owner=${sha256(resource.owner)}`, `${RESOURCE_LABEL}-epoch=${resource.epoch}`,
    `${RESOURCE_LABEL}-deadline-ms=${deadline.getTime()}`];
}

function resourceNameSuffix(resource: VerifierResourceContext): string {
  return `${resource.jobId.replaceAll("-", "").toLowerCase()}-${resource.epoch}`;
}

function resourcePage(resources: string[], after: string, limit: number): string[] {
  const sorted = [...new Set(resources)].sort();
  const next = sorted.findIndex((value) => value > after);
  const start = next < 0 ? 0 : next;
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, limit);
}

function listDocker(docker: string, args: string[]): string[] {
  const result = dockerCommand(docker, args);
  if (!result.ok) throw new Error("could not enumerate verifier Docker resources");
  return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
}

function inspectDocker(docker: string, type: "container" | "volume", identity: string):
  { name: string; labels: Record<string, string> } | undefined {
  const args = type === "volume" ? ["volume", "inspect", identity] : ["inspect", identity];
  const result = dockerCommand(docker, args);
  if (!result.ok) {
    if (/no such (?:object|container|volume)/i.test(result.stderr)) return undefined;
    throw new Error(`could not inspect verifier Docker ${type}`);
  }
  const parsed = JSON.parse(result.stdout) as Array<{ Name?: unknown; Config?: { Labels?: unknown }; Labels?: unknown }>;
  const item = parsed[0];
  const labels = type === "volume" ? item?.Labels : item?.Config?.Labels;
  if (!item || typeof item.Name !== "string" || !labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`invalid verifier Docker ${type} inspection`);
  }
  return { name: item.Name, labels: labels as Record<string, string> };
}

function isExpiredOwnedResource(name: string, labels: Record<string, string>, now: Date, graceMs: number,
  type: "container" | "volume"): boolean {
  if (labels[RESOURCE_LABEL] !== "true" || labels[`${RESOURCE_LABEL}-version`] !== "1") return false;
  const job = labels[`${RESOURCE_LABEL}-job`]; const owner = labels[`${RESOURCE_LABEL}-owner`];
  const epoch = labels[`${RESOURCE_LABEL}-epoch`]; const deadline = labels[`${RESOURCE_LABEL}-deadline-ms`];
  if (!job || !UUID.test(job) || !owner || !/^[a-f0-9]{64}$/.test(owner)
      || !epoch || !/^[1-9][0-9]*$/.test(epoch) || !deadline || !/^[0-9]{13}$/.test(deadline)) return false;
  const suffix = `${job.replaceAll("-", "")}-${epoch}`;
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = type === "volume"
    ? new RegExp(`^pr-agent-fix-snapshot-${escapedSuffix}-[a-f0-9]{8}$`)
    : new RegExp(`^/?pr-agent-fix-(?:seed|phase)-${escapedSuffix}-[a-f0-9]{8}$`);
  const deadlineMs = Number(deadline);
  return pattern.test(name) && Number.isSafeInteger(deadlineMs) && deadlineMs + graceMs < now.getTime();
}

function dockerCommand(docker: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(docker, args, { timeout: 15_000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "" } });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function removeContainerOrThrow(docker: string, name: string): void {
  const removed = dockerCommand(docker, ["rm", "--force", name]);
  if (!removed.ok && inspectDocker(docker, "container", name)) throw new Error("could not remove verifier Docker container");
}

function removeVolumeOrThrow(docker: string, name: string): void {
  const removed = dockerCommand(docker, ["volume", "rm", "--force", name]);
  if (!removed.ok && inspectDocker(docker, "volume", name)) throw new Error("could not remove verifier Docker volume");
}
