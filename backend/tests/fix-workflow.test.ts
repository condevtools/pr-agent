import assert from "node:assert/strict";
import test from "node:test";

import type { StructuredModelRequest } from "../src/agents/contracts.js";
import type { FixArtifact, FixProposal, FixSource, FixWorkflowPolicy, VerificationResult } from "../src/fix/contracts.js";
import { executeFixProposal } from "../src/fix/fix-workflow.js";
import { FixPatchValidationError, validateFixPatchPair } from "../src/fix/patch-validator.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import { fingerprint } from "../src/agent-runtime/versions.js";

const digest = `sha256:${"a".repeat(64)}`;
const source: FixSource = {
  tenantId: "00000000-0000-4000-8000-000000000001", integrationId: "00000000-0000-4000-8000-000000000002",
  runId: "00000000-0000-4000-8000-000000000003", sourceReviewRunId: "00000000-0000-4000-8000-000000000004",
  findingId: "b".repeat(64), platform: "github", repository: "acme/repo", baseSha: "1".repeat(40), headSha: "2".repeat(40),
  sourceBundleRef: "bundle/fixed", sourceBundleHash: "c".repeat(64), allowedPaths: ["src/value.ts"],
  finding: { title: "wrong value", body: "returns the wrong value", path: "src/value.ts", startLine: 1, endLine: 1 },
};
const verificationPolicy = {
  id: "node", hash: "d".repeat(64), nodeImageDigest: digest, argv: ["node", "--test", "tests"],
  dependencyLockPath: "package-lock.json", dependencyLockHash: "e".repeat(64), sandboxHash: "f".repeat(64),
  allowedTestPrefixes: ["tests"], relevanceTokens: ["wrong", "value"], deadlineMs: 60_000,
  maxLogBytes: 100_000, memoryMb: 512, cpuCount: 1, pidsLimit: 64, tmpfsMb: 64,
  publisherPolicyId: "draft-v1", publisherPolicyHash: "0".repeat(64), publishEnabled: false,
} as const;
const policy: FixWorkflowPolicy = { verification: verificationPolicy, maxProposalRevisions: 2,
  maxInputBytes: 100_000, maxOutputTokensPerRevision: 2_000, maxPatchBytes: 20_000, maxFilesPerPatch: 4 };
const codePatch = ["diff --git a/src/value.ts b/src/value.ts", "--- a/src/value.ts", "+++ b/src/value.ts",
  "@@ -1 +1 @@", "-export const value = 1;", "+export const value = 2;", ""].join("\n");
const testPatch = ["diff --git a/tests/value.test.ts b/tests/value.test.ts", "new file mode 100644", "--- /dev/null",
  "+++ b/tests/value.test.ts", "@@ -0,0 +1,2 @@", "+import { value } from '../src/value.js';", "+if (value !== 2) throw new Error('wrong value');", ""].join("\n");

test("patch validator accepts only allow-listed code and independent new tests", () => {
  const files = [{ path: "src/value.ts", content: "export const value = 1;" }];
  const validated = validateFixPatchPair(codePatch, testPatch, source, policy, files);
  assert.deepEqual(validated.code.files, ["src/value.ts"]);
  assert.deepEqual(validated.test.files, ["tests/value.test.ts"]);
  assert.match(validated.code.hash, /^[a-f0-9]{64}$/);

  assert.throws(() => validateFixPatchPair(codePatch.replaceAll("src/value.ts", "package.json"), testPatch, source, policy, files),
    (error: unknown) => error instanceof FixPatchValidationError && error.code === "forbidden_path");
  assert.throws(() => validateFixPatchPair(codePatch, testPatch.replace("--- /dev/null", "--- a/tests/value.test.ts"), source, policy, files),
    (error: unknown) => error instanceof FixPatchValidationError && error.code === "test_patch_must_add_file");
  assert.throws(() => validateFixPatchPair(codePatch, testPatch.replace("new file mode 100644", "new file mode 120000"), source, policy, files),
    (error: unknown) => error instanceof FixPatchValidationError && error.code === "binary_mode_rename_or_symlink_forbidden");
  assert.throws(() => validateFixPatchPair(codePatch, testPatch, source, policy,
    [{ path: "src/value.ts", content: "export const value = 999;" }]),
  (error: unknown) => error instanceof FixPatchValidationError && error.code === "patch_context_mismatch");
});

test("fix workflow persists validated proposal and remains suggestion-only without qualification", async () => {
  const steps = new Map<string, unknown>(); let proposal: FixProposal | undefined; let artifact: FixArtifact | undefined;
  const verification: VerificationResult = { outcome: "verified", reasonCodes: [], baselineTarget: "fail", patchedTarget: "pass",
    baselineRegression: [], patchedRegression: [], relevance: "verified",
    logRefs: { baselineTarget: "logs/base", patchedTarget: "logs/patched", baselineRegression: undefined, patchedRegression: undefined },
    logHashes: { baselineTarget: "1".repeat(64), patchedTarget: "2".repeat(64), baselineRegression: undefined, patchedRegression: undefined },
    imageDigest: digest, policyHash: verificationPolicy.hash, proposalHash: "" };
  const lease = leaseFixture();
  const result = await executeFixProposal(source, {
    lease, model: { generate: async <T>(request: StructuredModelRequest<T>) => {
      assert.equal(request.role, "fix"); assert.doesNotMatch(request.prompt, /00000000-0000-4000-8000-000000000001/);
      return request.schema.parse({ codePatch, testPatch, summary: "fix value" });
    } },
    readSourceFiles: async (paths) => paths.map((path) => ({ path, content: "export const value = 1;" })),
    waitForVerification: async () => verification,
    step: async <T>(key: string, _kind: never, _hash: string, action: () => Promise<T>) => {
      if (steps.has(key)) return steps.get(key) as T; const value = await action(); steps.set(key, value); return value;
    },
    store: {
      registerSource: async () => {}, loadArtifact: async () => artifact,
      registerProposal: async (_lease, _key, value) => { proposal = value; verification.proposalHash = value.proposalHash; },
      registerVerification: async () => {},
      loadVerification: async () => verification, saveArtifact: async (_lease, value) => { artifact = value; },
    },
  }, policy);
  assert.equal(proposal?.qualificationStatus, "not_verified");
  assert.equal(result.outcome, "suggestion_only");
  assert.deepEqual(result.reasonCodes, ["publishing_not_qualified", "relevance_attestation_missing"]);
});

function leaseFixture(): RunLease {
  return { tenantId: source.tenantId, integrationId: source.integrationId, runId: source.runId,
    jobId: "00000000-0000-4000-8000-000000000005", owner: "worker", epoch: 1, jobAttempt: 1,
    authorityGeneration: 1, executionModeGeneration: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    baseSha: source.baseSha, headSha: source.headSha, workflowVersionHash: fingerprint("workflow"),
    promptVersionHash: fingerprint("prompt"), modelVersionHash: fingerprint("model"), toolVersionHash: fingerprint("tool"),
    policyVersionHash: fingerprint("policy"), runtimeVersionHash: fingerprint("runtime"), input: {}, limits: {}, runtimeConfig: {},
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
}
