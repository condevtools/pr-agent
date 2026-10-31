export type QualityActorType = "user" | "service" | "system";

export interface QualityActor {
  actorType: QualityActorType;
  actorId: string;
}

export interface QualityScope {
  tenantId: string;
  integrationId: string;
}

export type QualityPromptStatus = "candidate" | "active" | "retired";

export interface QualityPromptVersion {
  id: string;
  scope: QualityScope;
  promptKey: string;
  remotePromptName: string;
  remotePromptVersion: number;
  template: unknown;
  contentHash: string;
  variables: string[];
  sourceFingerprint: string;
  targetFingerprint: string;
  status: QualityPromptStatus;
  importedBy: QualityActor;
  approvedBy?: QualityActor;
  activationCommandKey?: string;
  approvedAt?: string;
  retiredAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ImportQualityPromptInput {
  promptKey: string;
  remotePromptName: string;
  remotePromptVersion: number;
  template: unknown;
  contentHash: string;
  variables: string[];
  sourceFingerprint: string;
  targetFingerprint: string;
  actor: QualityActor;
}

export type QualitySyncJobKind = "prompt_pull" | "dataset_export" | "evaluation_export"
  | "annotation_queue" | "annotation_pull" | "scores_export";
export type QualitySyncJobStatus = "queued" | "running" | "retry_wait" | "succeeded" | "dead_letter";

export interface QualitySyncJob {
  id: string;
  scope: QualityScope;
  kind: QualitySyncJobKind;
  externalId: string;
  idempotencyKey: string;
  requestHash: string;
  targetFingerprint: string;
  payload: Record<string, unknown>;
  principal: Record<string, unknown>;
  status: QualitySyncJobStatus;
  attemptCount: number;
  maxAttempts: number;
  maxAgeSeconds: number;
  availableAt: string;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt?: string;
  result?: Record<string, unknown>;
  errorCode?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface QualitySyncLease extends QualitySyncJob {
  status: "running";
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface EnqueueQualitySyncJobInput {
  kind: QualitySyncJobKind;
  externalId: string;
  idempotencyKey: string;
  requestHash: string;
  targetFingerprint: string;
  payload: Record<string, unknown>;
  principal: Record<string, unknown>;
  maxAttempts?: number;
  maxAgeSeconds?: number;
  availableAt?: Date;
}

export interface QualityTraceLink {
  id: string;
  scope: QualityScope;
  runId: string;
  runAttempt: number;
  traceId: string;
  externalId: string;
  targetFingerprint: string;
  createdAt: string;
}

export interface RecordQualityTraceInput {
  runId: string;
  runAttempt: number;
  traceId: string;
  externalId: string;
  targetFingerprint: string;
}

export type QualityAnnotationState = "pending_review" | "promoted" | "rejected";

export interface QualityAnnotationImport {
  id: string;
  scope: QualityScope;
  sourceRunId: string;
  traceLinkId: string;
  remoteScoreId: string;
  contentHash: string;
  score: Record<string, unknown>;
  state: QualityAnnotationState;
  importedBy: QualityActor;
  reviewedBy?: QualityActor;
  reviewCommandKey?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ImportQualityAnnotationInput {
  sourceRunId: string;
  traceLinkId: string;
  remoteScoreId: string;
  contentHash: string;
  score: Record<string, unknown>;
  actor: QualityActor & { actorType: "service" | "system" };
}

export class QualityStorageConflictError extends Error {
  readonly code = "QUALITY_STORAGE_CONFLICT";
}

export class QualityStorageNotFoundError extends Error {
  readonly code = "QUALITY_STORAGE_NOT_FOUND";
}

export class QualityLeaseLostError extends Error {
  readonly code = "QUALITY_LEASE_LOST";
}
