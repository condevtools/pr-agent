import { createHash } from "node:crypto";

import type { RepositoryOperationType } from "../../agent-runtime/publication/publication.js";
import { canonicalJson, fingerprint } from "../../agent-runtime/versions.js";
import type { FixProposal, VerificationResult } from "../contracts.js";
import type { FixApprovalIntent } from "../approval/contracts.js";
import { applyUnifiedPatch } from "../../repository/diff/unified-patch.js";
import { isFixDifferentialEligible } from "../verification/gate.js";

export interface FixPublicationOriginal {
  platform: "github" | "gitlab";
  repository: string;
  number: number;
  headBranch: string;
  headSha: string;
}

export interface FixPublicationPlanOperation {
  operationType: Exclude<RepositoryOperationType, "publication">;
  slot: "fix.branch" | "fix.commit" | "fix.draft_pr";
  payload: Record<string, unknown>;
}

export interface FixRelevanceAttestation {
  kind: "trusted_checker" | "human";
  testPatchHash: string;
  attestationHash: string;
}

export interface FixPublicationPlan {
  branchName: string;
  branchNameHash: string;
  publishBaseSha: string;
  operations: readonly FixPublicationPlanOperation[];
  orderedOperationPlanHash: string;
  intent: FixApprovalIntent & {
    schemaVersion: 1;
    original: FixPublicationOriginal;
    branchName: string;
    operations: readonly FixPublicationPlanOperation[];
    relevanceAttestationHash: string;
  };
}

/** Builds the entire provider write plan before approval. Nothing provider-derived may be added later. */
export function buildFixPublicationPlan(
  proposal: FixProposal,
  original: FixPublicationOriginal,
  files: ReadonlyMap<string, string>,
  verification: VerificationResult,
  relevance: FixRelevanceAttestation,
): FixPublicationPlan {
  if (original.platform === "gitlab") throw new Error("GitLab fix publication is suggestion-only: conditional branch creation is unsupported");
  if (proposal.repository !== original.repository || proposal.headSha !== original.headSha
      || verification.proposalHash !== proposal.proposalHash || verification.policyHash !== proposal.policyHash
      || verification.imageDigest !== proposal.imageDigest
      || sha256(proposal.codePatch) !== proposal.codePatchHash || sha256(proposal.testPatch) !== proposal.testPatchHash) {
    throw new Error("fix publication inputs do not describe one frozen proposal");
  }
  if (proposal.qualificationStatus !== "verified" || !isFixDifferentialEligible(verification)
      || (relevance.kind === "trusted_checker" && verification.relevance !== "verified")
      || relevance?.testPatchHash !== proposal.testPatchHash
      || !/^[a-f0-9]{64}$/.test(relevance?.attestationHash ?? "")) {
    throw new Error("fix proposal is not independently qualified for publication");
  }
  if (!Number.isSafeInteger(original.number) || original.number <= 0 || !safeBranch(original.headBranch)) {
    throw new Error("invalid original pull request identity");
  }
  const codeFiles = applyUnifiedPatch(files, proposal.codePatch);
  const patched = applyUnifiedPatch(codeFiles, proposal.testPatch);
  const changes = [...patched.entries()].filter(([path, content]) => files.get(path) !== content).map(([path, content]) => ({
    path, action: files.has(path) ? "update" as const : "create" as const,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
    contentSha256: sha256(content),
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (changes.length === 0 || changes.length > 20 || changes.some(({ path }) => !safePath(path))
      || changes.reduce((sum, file) => sum + Buffer.byteLength(file.contentBase64, "utf8"), 0) > 2 * 1024 * 1024) {
    throw new Error("fix publication change set exceeds policy limits");
  }
  const branchName = `pr-agent/fix-${proposal.proposalHash.slice(0, 16)}`;
  const common = {
    schemaVersion: 1, platform: original.platform, repository: original.repository,
    originalNumber: original.number, originalHeadBranch: original.headBranch,
    originalHeadSha: original.headSha, branchName, proposalId: proposal.id,
    proposalHash: proposal.proposalHash,
  };
  const commitMessage = `fix: ${proposal.findingId.slice(0, 12)}\n\nPR-Agent-Proposal: ${proposal.proposalHash}`;
  const operations: FixPublicationPlanOperation[] = [
    { operationType: "fix_branch" as const, slot: "fix.branch" as const,
      payload: { ...common, kind: "github-fix-branch", sourceSha: original.headSha } },
    { operationType: "fix_commit", slot: "fix.commit", payload: { ...common, kind: `${original.platform}-fix-commit`,
      expectedHeadSha: original.headSha, createBranch: false, commitMessage, changes } },
    { operationType: "fix_draft_pr", slot: "fix.draft_pr", payload: { ...common, kind: `${original.platform}-fix-draft-pr`,
      baseBranch: original.headBranch, headBranch: branchName, draft: true,
      title: `[PR-Agent] Fix ${proposal.findingId.slice(0, 12)}`,
      body: `Automated fix proposal for finding \`${proposal.findingId}\`.\n\nProposal: \`${proposal.proposalHash}\``,
      expectedCommitMessage: commitMessage, changes, expectedCommitPayload: { ...common, kind: "github-fix-commit",
        expectedHeadSha: original.headSha, createBranch: false, commitMessage, changes } } },
  ];
  const orderedOperationPlanHash = fingerprint(operations);
  const intent = {
    schemaVersion: 1 as const,
    proposalId: proposal.id, proposalHash: proposal.proposalHash,
    sourceReviewRunId: proposal.sourceReviewRunId, findingId: proposal.findingId,
    headSha: proposal.headSha, sourceBundleHash: proposal.sourceBundleHash,
    codePatchHash: proposal.codePatchHash, testPatchHash: proposal.testPatchHash,
    policyHash: proposal.policyHash, trustedCommandHash: proposal.trustedCommandHash,
    dependencyLockHash: proposal.dependencyLockHash, sandboxPolicyHash: proposal.sandboxPolicyHash,
    verificationResultHash: fingerprint(verification), publisherPolicyHash: proposal.publisherPolicyHash,
    branchNameHash: sha256(branchName), publishBaseSha: original.headSha, orderedOperationPlanHash,
    relevanceAttestationHash: fingerprint(relevance), original: { ...original }, branchName, operations,
  };
  // Reject values that cannot survive JSONB canonicalization exactly.
  canonicalJson(intent);
  return { branchName, branchNameHash: intent.branchNameHash, publishBaseSha: original.headSha,
    operations, orderedOperationPlanHash, intent };
}

function safeBranch(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.startsWith("-") && !value.includes("..")
    && !/[~^:?*[\]\\\s]/.test(value) && !value.endsWith("/") && !value.endsWith(".");
}
function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some((part) => !part || part === "." || part === "..");
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
