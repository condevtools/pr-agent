export type LangfuseQualityErrorCode =
  | "LANGFUSE_QUALITY_INVALID_CONFIG"
  | "LANGFUSE_QUALITY_UNAUTHORIZED"
  | "LANGFUSE_QUALITY_FORBIDDEN"
  | "LANGFUSE_QUALITY_NOT_FOUND"
  | "LANGFUSE_QUALITY_CONFLICT"
  | "LANGFUSE_QUALITY_RATE_LIMITED"
  | "LANGFUSE_QUALITY_TIMEOUT"
  | "LANGFUSE_QUALITY_UNAVAILABLE"
  | "LANGFUSE_QUALITY_REQUEST_FAILED";

export interface LangfuseQualityClientOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: 0 | 1;
}

export interface TextPromptRecord {
  name: string;
  version: number;
  text: string;
  config?: unknown;
  labels: string[];
}

export interface CreateTextPromptInput {
  name: string;
  text: string;
  config?: unknown;
  labels?: string[];
  commitMessage?: string;
}

export interface DatasetRecord {
  id: string;
  name: string;
  description: string | null;
  metadata?: unknown;
}

export interface GetOrCreateDatasetInput {
  name: string;
  description?: string;
  metadata?: unknown;
}

export interface UpsertDatasetItemInput {
  datasetName: string;
  stableKey: string;
  input?: unknown;
  expectedOutput?: unknown;
  metadata?: unknown;
  sourceTraceId?: string;
  sourceObservationId?: string;
}

export interface DatasetItemRecord {
  id: string;
  datasetId: string;
  datasetName: string;
}

export interface LinkDatasetRunItemInput {
  runName: string;
  datasetItemId: string;
  traceId: string;
  observationId?: string;
  runDescription?: string;
  metadata?: unknown;
}

export interface DatasetRunItemRecord {
  id: string;
  datasetRunId: string;
  datasetItemId: string;
  traceId: string;
}

export type ScoreConfigKind = "NUMERIC" | "CATEGORICAL" | "BOOLEAN";

export interface ScoreConfigCategory {
  value: number;
  label: string;
}

export interface GetOrCreateScoreConfigInput {
  name: string;
  kind: ScoreConfigKind;
  description?: string;
  minValue?: number;
  maxValue?: number;
  categories?: ScoreConfigCategory[];
}

export interface ScoreConfigRecord extends GetOrCreateScoreConfigInput {
  id: string;
}

interface BaseScoreInput {
  stableKey: string;
  traceId: string;
  observationId?: string;
  name: string;
  comment?: string;
  metadata?: Record<string, unknown>;
  configId?: string;
}

export type UpsertScoreInput =
  | (BaseScoreInput & { kind: "NUMERIC"; value: number })
  | (BaseScoreInput & { kind: "CATEGORICAL"; value: string })
  | (BaseScoreInput & { kind: "BOOLEAN"; value: boolean });

export interface ScoreWriteReceipt {
  id: string;
}

export interface GetOrCreateAnnotationQueueInput {
  name: string;
  description?: string;
  scoreConfigIds: string[];
}

export interface AnnotationQueueRecord {
  id: string;
  name: string;
  description: string | null;
  scoreConfigIds: string[];
}

export type AnnotationQueueObjectType = "TRACE" | "OBSERVATION" | "SESSION";

export interface AddAnnotationQueueItemInput {
  queueId: string;
  objectId: string;
  objectType: AnnotationQueueObjectType;
}

export interface AnnotationQueueItemRecord {
  id: string;
  queueId: string;
  objectId: string;
  objectType: AnnotationQueueObjectType;
}

export interface HumanAnnotationScore {
  id: string;
  traceId: string;
  observationId?: string;
  name: string;
  kind: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT" | "CORRECTION";
  value: number | boolean | string;
  comment?: string | null;
  configId?: string | null;
  queueId?: string | null;
  authorUserId?: string | null;
  timestamp: string;
}

export interface ListHumanAnnotationScoresInput {
  traceId: string;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
}

export interface HumanAnnotationScorePageInput {
  traceId: string;
  queueId: string;
  configId: string;
  cursor?: string;
  limit?: number;
}

export interface HumanAnnotationScorePage {
  scores: HumanAnnotationScore[];
  nextCursor?: string;
}

export interface LangfuseQualityRequestContext {
  signal?: AbortSignal;
}

export interface LangfuseQualityPort {
  getTextPrompt(name: string, version: number, context?: LangfuseQualityRequestContext): Promise<TextPromptRecord>;
  createTextPrompt(input: CreateTextPromptInput, context?: LangfuseQualityRequestContext): Promise<TextPromptRecord>;
  getOrCreateDataset(input: GetOrCreateDatasetInput, context?: LangfuseQualityRequestContext): Promise<DatasetRecord>;
  upsertDatasetItem(input: UpsertDatasetItemInput, context?: LangfuseQualityRequestContext): Promise<DatasetItemRecord>;
  linkDatasetRunItem(input: LinkDatasetRunItemInput, context?: LangfuseQualityRequestContext): Promise<DatasetRunItemRecord>;
  getOrCreateScoreConfig(input: GetOrCreateScoreConfigInput, context?: LangfuseQualityRequestContext): Promise<ScoreConfigRecord>;
  upsertScore(input: UpsertScoreInput, context?: LangfuseQualityRequestContext): Promise<ScoreWriteReceipt>;
  getOrCreateAnnotationQueue(input: GetOrCreateAnnotationQueueInput, context?: LangfuseQualityRequestContext): Promise<AnnotationQueueRecord>;
  addAnnotationQueueItem(input: AddAnnotationQueueItemInput, context?: LangfuseQualityRequestContext): Promise<AnnotationQueueItemRecord>;
  listHumanAnnotationScores(input: ListHumanAnnotationScoresInput, context?: LangfuseQualityRequestContext): Promise<HumanAnnotationScore[]>;
  listHumanAnnotationScorePage(input: HumanAnnotationScorePageInput,
    context?: LangfuseQualityRequestContext): Promise<HumanAnnotationScorePage>;
}
