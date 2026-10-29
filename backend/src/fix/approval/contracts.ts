import type { PoolClient } from "pg";

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
