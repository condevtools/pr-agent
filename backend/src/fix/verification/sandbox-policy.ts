import { z } from "zod";

import type { VerificationPolicy } from "../contracts.js";
import { fingerprint } from "../../agent-runtime/versions.js";

const safeRelativePath = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
  && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
"path must be a normalized relative path");

const trustedPolicySchema = z.object({
  id: z.string().min(1).max(128), hash: z.string().regex(/^[a-f0-9]{64}$/),
  nodeImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  argv: z.tuple([z.literal("node"), z.literal("--test")]).rest(safeRelativePath).refine(
    (argv) => argv.length >= 3 && argv.length <= 102, "trusted argv requires 1-100 explicit test files"),
  dependencyLockHash: z.string().regex(/^[a-f0-9]{64}$/),
  dependencyLockPath: safeRelativePath,
  sandboxHash: z.string().regex(/^[a-f0-9]{64}$/),
  allowedTestPrefixes: z.array(safeRelativePath).min(1).max(20),
  relevanceTokens: z.array(z.string().min(2).max(128)).min(1).max(20),
  deadlineMs: z.number().int().min(1_000).max(300_000),
  maxLogBytes: z.number().int().min(4_096).max(2 * 1024 * 1024),
  memoryMb: z.number().int().min(64).max(2_048), cpuCount: z.number().int().min(1).max(4),
  pidsLimit: z.number().int().min(16).max(512), tmpfsMb: z.number().int().min(32).max(1_024),
  publisherPolicyId: z.string().min(1).max(128),
  publisherPolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
  publishEnabled: z.boolean(), qualification: z.unknown().optional(),
}).strict();

export function assertVerifierPolicy(policy: VerificationPolicy): VerificationPolicy {
  const parsed = trustedPolicySchema.parse(policy) as unknown as VerificationPolicy;
  const prefixes = parsed.allowedTestPrefixes.map((prefix) => prefix.endsWith("/") ? prefix : `${prefix}/`);
  for (const path of parsed.argv.slice(2)) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error("trusted argv contains a test outside the allowed prefixes");
    }
  }
  if (fingerprint({ id: parsed.id, nodeImageDigest: parsed.nodeImageDigest, argv: parsed.argv,
    dependencyLockPath: parsed.dependencyLockPath, dependencyLockHash: parsed.dependencyLockHash, sandboxHash: parsed.sandboxHash,
    allowedTestPrefixes: parsed.allowedTestPrefixes, relevanceTokens: parsed.relevanceTokens,
    deadlineMs: parsed.deadlineMs, maxLogBytes: parsed.maxLogBytes, memoryMb: parsed.memoryMb,
    cpuCount: parsed.cpuCount, pidsLimit: parsed.pidsLimit, tmpfsMb: parsed.tmpfsMb,
    publisherPolicyId: parsed.publisherPolicyId, publisherPolicyHash: parsed.publisherPolicyHash,
  }) !== parsed.hash) {
    throw new Error("verification policy hash mismatch");
  }
  return parsed;
}

export function isAllowedAddedTest(path: string, policy: VerificationPolicy): boolean {
  if (!safeRelativePath.safeParse(path).success) return false;
  return policy.allowedTestPrefixes.some((prefix) =>
    path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    && /\.(?:test|spec)\.(?:js|mjs|cjs)$/.test(path));
}

export function expectedSandboxPolicyHash(policy: Pick<VerificationPolicy,
  "nodeImageDigest" | "deadlineMs" | "maxLogBytes" | "memoryMb" | "cpuCount" | "pidsLimit" | "tmpfsMb">): string {
  return fingerprint({ implementation: "docker-node-test-v2", imageDigest: policy.nodeImageDigest,
    network: "none", readOnlyRoot: true, capabilities: "none", noNewPrivileges: true,
    user: "65532:65532", ipc: "none", noDockerSocket: true, snapshotMount: "isolated-volume-readonly",
    phaseIsolation: "one-container-per-command", patchEngine: "unified-patch-v1",
    deadlineMs: policy.deadlineMs, maxLogBytes: policy.maxLogBytes, memoryMb: policy.memoryMb,
    cpuCount: policy.cpuCount, pidsLimit: policy.pidsLimit, tmpfsMb: policy.tmpfsMb });
}
