import type { PoolClient } from "pg";

import type { RunStatus } from "../postgres/run-store.js";

export type JsonObject = Record<string, unknown>;

export type RunJobKind = "start" | "resume" | "retry" | "recover" |
  "publication_outcome" | "manual_resume";

export interface RunLease {
  tenantId: string;
  runId: string;
  integrationId: string;
  runType?: string;
  jobId: string;
  jobKind?: RunJobKind;
  jobPayload?: JsonObject;
  owner: string;
  epoch: number;
  jobAttempt: number;
  authorityGeneration: number;
  executionModeGeneration: number;
  deadlineAt: string;
  baseSha: string;
  headSha: string;
  workflowVersionHash: string;
  promptVersionHash: string;
  modelVersionHash: string;
  toolVersionHash: string;
  policyVersionHash: string;
  runtimeVersionHash: string;
  input: JsonObject;
  limits: JsonObject;
  runtimeConfig: JsonObject;
  leaseExpiresAt: string;
}

export interface ClaimableBinding {
  tenantId: string;
  integrationId: string;
  authorityGeneration: number;
  executionModeGeneration: number;
}

export type RunLeaseIdentity = Pick<RunLease, "tenantId" | "runId" | "owner" | "epoch">;

export interface LockedRun {
  status: RunStatus;
  leaseExpiresAt: string;
  deadlineAt: string;
}

export interface RunStep {
  id: string;
  runId: string;
  stepKey: string;
  kind: RunStepKind;
  inputHash: string;
  status: "running" | "succeeded" | "failed";
  attemptId: string;
  attemptNumber: number;
  reused: boolean;
  output?: JsonObject;
  outputHash?: string;
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  sequence: number;
  stepId?: string;
  stepAttemptId?: string;
  schemaVersion: number;
  runtimeVersionHash: string;
  stateHash: string;
  state: JsonObject;
  createdAt: string;
}

export type RunStepKind = "tool" | "model" | "publication" | "coordination" | "verification";

export type ToolCallKind = "provider_read" | "repository_read" | "sandbox_read" | "mcp_read";

export interface RunExecutionSnapshot {
  id: string;
  tenantId: string;
  integrationId: string;
  status: RunStatus;
  version: number;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt?: string;
  deadlineAt: string;
  cancelRequestedAt?: string;
  outcomeCode?: string;
  errorCode?: string;
}

export interface SweepResult {
  retried: number;
  deadLettered: number;
  cancelled: number;
}

export type LeaseTransaction<T> = (client: PoolClient) => Promise<T>;

export class RunLeaseLostError extends Error {
  constructor(readonly runId: string) {
    super(`run lease is no longer valid: ${runId}`);
    this.name = "RunLeaseLostError";
  }
}

export class RunStepConflictError extends Error {
  constructor(readonly stepKey: string) {
    super(`run step identity was reused with different input: ${stepKey}`);
    this.name = "RunStepConflictError";
  }
}

export class RunCheckpointCompatibilityError extends Error {
  constructor(readonly runId: string) {
    super(`run checkpoint is incompatible with the requested runtime: ${runId}`);
    this.name = "RunCheckpointCompatibilityError";
  }
}
