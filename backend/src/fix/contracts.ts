import type { PoolClient } from "pg";

import type { StructuredModel } from "../agents/contracts.js";
import type { RunLease, RunStepKind } from "../agent-runtime/runs/contracts.js";

export type FixOutcome = "verified" | "suggestion_only" | "failed";
export type VerificationTargetOutcome = "pass" | "fail" | "timeout" | "not_run";

export interface FixSource {
  tenantId: string;
  integrationId: string;
  runId: string;
  sourceReviewRunId: string;
  findingId: string;
  platform: "github" | "gitlab";
  repository: string;
  baseSha: string;
  headSha: string;
  sourceBundleRef: string;
  sourceBundleHash: string;
  allowedPaths: readonly string[];
  finding: { title: string; body: string; path: string; startLine: number; endLine: number };
}

export interface FixRunInput {
  schemaVersion: 1;
  workflow: "fix.propose.v1";
  policyId: string;
  source: Omit<FixSource, "runId">;
  original: {
    platform: "github" | "gitlab";
    repository: string;
    number: number;
    providerRepositoryId: number;
    headBranch: string;
    headSha: string;
  };
}

export interface VerificationPolicy {
  id: string;
  hash: string;
  nodeImageDigest: string;
  argv: readonly string[];
  dependencyLockPath: string;
  dependencyLockHash: string;
  sandboxHash: string;
  allowedTestPrefixes: readonly string[];
  relevanceTokens: readonly string[];
  deadlineMs: number;
  maxLogBytes: number;
  memoryMb: number;
  cpuCount: number;
  pidsLimit: number;
  tmpfsMb: number;
  publisherPolicyId: string;
  publisherPolicyHash: string;
  publishEnabled: boolean;
  qualification?: FixQualification;
}

export interface FixQualification {
  receiptId: string;
  evidenceHash: string;
  policyHash: string;
  trustedCommandHash: string;
  imageDigest: string;
  caseCount: number;
  repositoryCount: number;
}

export interface FixProposal {
  id: string;
  tenantId: string;
  integrationId: string;
  runId: string;
  sourceReviewRunId: string;
  findingId: string;
  revision: 1 | 2;
  repository: string;
  baseSha: string;
  headSha: string;
  sourceBundleRef: string;
  sourceBundleHash: string;
  codePatch: string;
  testPatch: string;
  codePatchHash: string;
  testPatchHash: string;
  proposalHash: string;
  policyId: string;
  policyHash: string;
  trustedCommandHash: string;
  dependencyLockHash: string;
  dependencyLockPath: string;
  sandboxPolicyHash: string;
  imageDigest: string;
  publisherPolicyHash: string;
  qualificationStatus: "verified" | "not_verified";
  qualificationReceiptId?: string;
  qualificationEvidenceHash?: string;
}

export interface VerificationResult {
  outcome: FixOutcome;
  reasonCodes: readonly string[];
  baselineTarget: VerificationTargetOutcome;
  patchedTarget: VerificationTargetOutcome;
  baselineRegression: readonly string[];
  patchedRegression: readonly string[];
  relevance: "verified" | "failed" | "unknown";
  relevanceAttestation?: {
    kind: "trusted_checker" | "human";
    testPatchHash: string;
    attestationHash: string;
  };
  logRefs: Readonly<Partial<Record<"baselineTarget" | "patchedTarget" | "baselineRegression" | "patchedRegression", string>>>;
  logHashes: Readonly<Partial<Record<"baselineTarget" | "patchedTarget" | "baselineRegression" | "patchedRegression", string>>>;
  imageDigest: string;
  policyHash: string;
  proposalHash: string;
}

export interface FixArtifact {
  workflowId: "fix.propose.v1";
  publicationMode: "suggestion_only";
  source: FixSource;
  proposal?: FixProposal;
  verification?: VerificationResult;
  outcome: FixOutcome;
  reasonCodes: readonly string[];
}

export interface FixWorkflowPolicy {
  verification: VerificationPolicy;
  maxProposalRevisions: 1 | 2;
  maxInputBytes: number;
  maxOutputTokensPerRevision: number;
  maxPatchBytes: number;
  maxFilesPerPatch: number;
}

export interface FixWorkflowContext {
  lease: RunLease;
  model: StructuredModel;
  readSourceFiles(paths: readonly string[]): Promise<readonly { path: string; content: string }[]>;
  waitForVerification(proposal: FixProposal): Promise<VerificationResult>;
  step<T>(key: string, kind: RunStepKind, inputHash: string, action: () => Promise<T>): Promise<T>;
  store: FixStore;
  signal?: AbortSignal;
}

export interface FixStore {
  registerSource(lease: RunLease, source: FixSource): Promise<void>;
  loadArtifact(lease: RunLease): Promise<FixArtifact | undefined>;
  registerProposal(lease: RunLease, stepKey: string, proposal: FixProposal): Promise<void>;
  registerVerification(lease: RunLease, stepKey: string, proposal: FixProposal, result: VerificationResult): Promise<void>;
  loadVerification(lease: RunLease, proposalId: string): Promise<VerificationResult | undefined>;
  saveArtifact(lease: RunLease, artifact: FixArtifact): Promise<void>;
}

export interface VerificationJobInput {
  tenantId: string;
  integrationId: string;
  runId: string;
  proposalId: string;
  proposalHash: string;
  sourceBundleRef: string;
  sourceBundleHash: string;
  policyHash: string;
  verificationInputHash: string;
  trustedCommandHash: string;
  dependencyLockHash: string;
  dependencyLockPath: string;
  sandboxPolicyHash: string;
  imageDigest: string;
  claimedRunEpoch: number;
}

export type EnqueueVerificationJob = (client: PoolClient, input: VerificationJobInput) => Promise<string>;

export interface FixApprovalIntent {
  proposalId: string;
  proposalHash: string;
  sourceReviewRunId: string;
  findingId: string;
  headSha: string;
  sourceBundleHash: string;
  codePatchHash: string;
  testPatchHash: string;
  policyHash: string;
  trustedCommandHash: string;
  dependencyLockHash: string;
  sandboxPolicyHash: string;
  verificationResultHash: string;
  relevanceAttestationHash: string;
  publisherPolicyHash: string;
  branchNameHash: string;
  publishBaseSha: string;
  orderedOperationPlanHash: string;
}

export interface FixRelevanceAttestation {
  id: string;
  proposalRunId: string;
  proposalId: string;
  proposalHash: string;
  testPatchHash: string;
  findingId: string;
  verificationResultHash: string;
  rubricVersion: string;
  reason: string;
  actor: FixApprovalActor;
  attestationHash: string;
  createdAt: string;
}

export interface CreateFixRelevanceAttestationInput {
  tenantId: string;
  integrationId: string;
  proposalRunId: string;
  proposalId: string;
  proposalHash: string;
  testPatchHash: string;
  findingId: string;
  verificationResultHash: string;
  rubricVersion: string;
  reason: string;
  commandKey: string;
  actor: FixApprovalActor;
}

export interface FixApprovalReceipt {
  approvalId: string;
  intentHash: string;
  status: "open" | "approved" | "revoked" | "expired" | "consumed";
  version: number;
  expiresAt: string;
}

export interface CreateFixApprovalInput {
  tenantId: string;
  integrationId: string;
  proposalRunId: string;
  proposalId: string;
  commandKey: string;
  intent: FixApprovalIntent;
  maker: FixApprovalActor;
  ttlSeconds: number;
}

export interface DecideFixApprovalInput {
  tenantId: string;
  integrationId: string;
  approvalId: string;
  commandKey: string;
  requestHash: string;
  expectedVersion: number;
  actor: FixApprovalActor;
}

export interface ConsumeFixApprovalInput {
  tenantId: string;
  approvalId: string;
  publishRunId: string;
  batchId: string;
  operationSetHash: string;
  intentHash: string;
}

export type CreateFixPublishRun = (client: PoolClient, input: {
  proposalRunId: string;
  approvalId: string;
  intentHash: string;
}) => Promise<string>;

export interface FixApprovalActor {
  type: "user" | "service";
  id: string;
}
