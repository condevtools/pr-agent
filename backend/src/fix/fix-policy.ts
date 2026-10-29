import { z } from "zod";

import type { FixWorkflowPolicy, VerificationPolicy } from "./contracts.js";
import { fingerprint } from "../agent-runtime/versions.js";
import { expectedSandboxPolicyHash } from "./sandbox-policy.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const verificationPolicyValueSchema = z.object({
  nodeImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  argv: z.array(z.string().min(1).max(256)).min(2).max(32),
  dependencyLockPath: z.string().min(1).max(256).refine((value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\")),
  dependencyLockHash: hash, sandboxHash: hash,
  allowedTestPrefixes: z.array(z.string().min(1).max(256)).min(1).max(20),
  relevanceTokens: z.array(z.string().min(2).max(80)).min(1).max(20),
  deadlineMs: z.number().int().min(1_000).max(15 * 60_000),
  maxLogBytes: z.number().int().min(1_024).max(10 * 1024 * 1024),
  memoryMb: z.number().int().min(128).max(8_192), cpuCount: z.number().int().min(1).max(8),
  pidsLimit: z.number().int().min(16).max(2_048), tmpfsMb: z.number().int().min(16).max(2_048),
  publisherPolicyId: z.string().min(1).max(128), publisherPolicyHash: hash,
  publishEnabled: z.boolean().default(false),
  qualification: z.object({ receiptId: z.string().uuid(), evidenceHash: hash, policyHash: hash,
    trustedCommandHash: hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    caseCount: z.number().int().min(50), repositoryCount: z.number().int().min(10) }).strict().optional(),
}).strict().superRefine((policy, context) => {
  if (policy.argv[0] !== "node" || policy.argv[1] !== "--test"
      || policy.argv.some((part) => /(?:^|\/)(?:npm|pnpm|yarn|npx|sh|bash)$/.test(part))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["argv"], message: "only direct node --test commands are supported" });
  }
  if (policy.publishEnabled && !policy.qualification) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["qualification"], message: "publishing requires a qualification receipt" });
  }
});

export function loadFixPolicyRegistry(raw = process.env.FIX_POLICY_REGISTRY_JSON): ReadonlyMap<string, VerificationPolicy> {
  if (!raw) return new Map();
  const parsed = z.record(z.string().min(1).max(128), verificationPolicyValueSchema).parse(JSON.parse(raw));
  return new Map(Object.entries(parsed).map(([id, value]) => {
    if (value.sandboxHash !== expectedSandboxPolicyHash(value)) {
      throw new Error(`fix policy sandbox hash mismatch: ${id}`);
    }
    const { qualification: _qualification, publishEnabled: _publishEnabled, ...operationalPolicy } = value;
    const hashValue = fingerprint({ id, ...operationalPolicy });
    if (value.qualification && value.qualification.policyHash !== hashValue) {
      throw new Error(`fix policy qualification hash mismatch: ${id}`);
    }
    return [id, { id, hash: hashValue, ...value } satisfies VerificationPolicy];
  }));
}

export function createFixWorkflowPolicy(verification: VerificationPolicy): FixWorkflowPolicy {
  return { verification, maxProposalRevisions: 2, maxInputBytes: 128_000,
    maxOutputTokensPerRevision: 4_096, maxPatchBytes: 128_000, maxFilesPerPatch: 20 };
}
