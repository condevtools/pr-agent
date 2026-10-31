import { createHash } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import type {
  AddAnnotationQueueItemInput,
  AnnotationQueueItemRecord,
  AnnotationQueueRecord,
  CreateTextPromptInput,
  DatasetItemRecord,
  DatasetRecord,
  DatasetRunItemRecord,
  GetOrCreateAnnotationQueueInput,
  GetOrCreateDatasetInput,
  GetOrCreateScoreConfigInput,
  HumanAnnotationScore,
  HumanAnnotationScorePage,
  HumanAnnotationScorePageInput,
  LangfuseQualityClientOptions,
  LangfuseQualityErrorCode,
  LangfuseQualityPort,
  LangfuseQualityRequestContext,
  LinkDatasetRunItemInput,
  ListHumanAnnotationScoresInput,
  ScoreConfigRecord,
  ScoreWriteReceipt,
  TextPromptRecord,
  UpsertDatasetItemInput,
  UpsertScoreInput,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_ITEMS = 500;

type RequestOptions = { timeoutInSeconds: number; maxRetries: 0 | 1; abortSignal?: AbortSignal };

export class LangfuseQualityError extends Error {
  constructor(
    readonly code: LangfuseQualityErrorCode,
    readonly operation: string,
  ) {
    super(`${operation} failed (${code})`);
    this.name = "LangfuseQualityError";
  }
}

export function deterministicLangfuseId(namespace: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update([namespace, ...parts].map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export class LangfuseQualityClient implements LangfuseQualityPort {
  private readonly client: LangfuseClient;
  private readonly requestOptions: RequestOptions;

  constructor(options: LangfuseQualityClientOptions) {
    const publicKey = requireNonEmpty(options.publicKey, "publicKey");
    const secretKey = requireNonEmpty(options.secretKey, "secretKey");
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new LangfuseQualityError("LANGFUSE_QUALITY_INVALID_CONFIG", "constructor");
    }
    if (options.maxRetries !== undefined && options.maxRetries !== 0 && options.maxRetries !== 1) {
      throw new LangfuseQualityError("LANGFUSE_QUALITY_INVALID_CONFIG", "constructor");
    }
    this.requestOptions = {
      timeoutInSeconds: timeoutMs / 1_000,
      maxRetries: options.maxRetries ?? 1,
    };
    this.client = new LangfuseClient({ publicKey, secretKey, baseUrl, timeout: timeoutMs / 1_000 });
  }

  async getTextPrompt(name: string, version: number, context?: LangfuseQualityRequestContext): Promise<TextPromptRecord> {
    if (!Number.isInteger(version) || version <= 0) invalidInput("getTextPrompt");
    const prompt = await this.call("getTextPrompt", () =>
      this.client.api.prompts.get(requirePromptName(name), { version }, this.options(context)));
    if (prompt.type !== "text" || typeof prompt.prompt !== "string") {
      throw new LangfuseQualityError("LANGFUSE_QUALITY_CONFLICT", "getTextPrompt");
    }
    return mapTextPrompt(prompt);
  }

  async createTextPrompt(input: CreateTextPromptInput, context?: LangfuseQualityRequestContext): Promise<TextPromptRecord> {
    const prompt = await this.call("createTextPrompt", () => this.client.api.prompts.create({
      name: requirePromptName(input.name),
      prompt: requireNonEmpty(input.text, "text"),
      type: "text",
      config: input.config,
      labels: input.labels,
      commitMessage: input.commitMessage,
    }, this.options(context)));
    if (prompt.type !== "text" || typeof prompt.prompt !== "string") {
      throw new LangfuseQualityError("LANGFUSE_QUALITY_CONFLICT", "createTextPrompt");
    }
    return mapTextPrompt(prompt);
  }

  async getOrCreateDataset(input: GetOrCreateDatasetInput, context?: LangfuseQualityRequestContext): Promise<DatasetRecord> {
    const name = requireNonEmpty(input.name, "name");
    try {
      return mapDataset(await this.call("getDataset", () => this.client.api.datasets.get(name, this.options(context))));
    } catch (error) {
      if (!isQualityCode(error, "LANGFUSE_QUALITY_NOT_FOUND")) throw error;
    }
    try {
      return mapDataset(await this.call("createDataset", () => this.client.api.datasets.create({
        name,
        description: input.description,
        metadata: input.metadata,
      }, this.options(context))));
    } catch (error) {
      if (!isQualityCode(error, "LANGFUSE_QUALITY_CONFLICT")) throw error;
      return mapDataset(await this.call("getDatasetAfterConflict", () =>
        this.client.api.datasets.get(name, this.options(context))));
    }
  }

  async upsertDatasetItem(input: UpsertDatasetItemInput, context?: LangfuseQualityRequestContext): Promise<DatasetItemRecord> {
    const datasetName = requireNonEmpty(input.datasetName, "datasetName");
    const id = deterministicLangfuseId("dataset-item", datasetName, requireNonEmpty(input.stableKey, "stableKey"));
    const item = await this.call("upsertDatasetItem", () => this.client.api.datasetItems.create({
      id,
      datasetName,
      input: input.input,
      expectedOutput: input.expectedOutput,
      metadata: input.metadata,
      sourceTraceId: input.sourceTraceId,
      sourceObservationId: input.sourceObservationId,
    }, this.options(context)));
    return { id: item.id, datasetId: item.datasetId, datasetName: item.datasetName };
  }

  async linkDatasetRunItem(input: LinkDatasetRunItemInput, context?: LangfuseQualityRequestContext): Promise<DatasetRunItemRecord> {
    const item = await this.call("linkDatasetRunItem", () => this.client.api.datasetRunItems.create({
      runName: requireNonEmpty(input.runName, "runName"),
      datasetItemId: requireNonEmpty(input.datasetItemId, "datasetItemId"),
      traceId: requireNonEmpty(input.traceId, "traceId"),
      observationId: input.observationId,
      runDescription: input.runDescription,
      metadata: input.metadata,
    }, this.options(context)));
    return { id: item.id, datasetRunId: item.datasetRunId, datasetItemId: item.datasetItemId, traceId: item.traceId };
  }

  async getOrCreateScoreConfig(input: GetOrCreateScoreConfigInput, context?: LangfuseQualityRequestContext): Promise<ScoreConfigRecord> {
    const name = requireNonEmpty(input.name, "name");
    const existing = await this.findScoreConfig(name, context);
    if (existing) return validateAndMapScoreConfig(existing, input);
    try {
      const created = await this.call("createScoreConfig", () => this.client.api.scoreConfigs.create({
        name,
        dataType: input.kind,
        description: input.description,
        minValue: input.minValue,
        maxValue: input.maxValue,
        categories: input.categories,
      }, this.options(context)));
      return validateAndMapScoreConfig(created, input);
    } catch (error) {
      if (!isQualityCode(error, "LANGFUSE_QUALITY_CONFLICT")) throw error;
      const concurrent = await this.findScoreConfig(name, context);
      if (!concurrent) throw error;
      return validateAndMapScoreConfig(concurrent, input);
    }
  }

  async upsertScore(input: UpsertScoreInput, context?: LangfuseQualityRequestContext): Promise<ScoreWriteReceipt> {
    const traceId = requireNonEmpty(input.traceId, "traceId");
    const name = requireNonEmpty(input.name, "name");
    const id = deterministicLangfuseId(
      "score",
      traceId,
      input.observationId ?? "",
      name,
      requireNonEmpty(input.stableKey, "stableKey"),
    );
    const response = await this.call("upsertScore", () => this.client.api.scores.create({
      id,
      traceId,
      observationId: input.observationId,
      name,
      value: input.kind === "BOOLEAN" ? (input.value ? 1 : 0) : input.value,
      dataType: input.kind,
      configId: input.configId,
      comment: input.comment,
      metadata: input.metadata,
      source: "API",
    }, this.options(context)));
    if (response.id !== id) throw new LangfuseQualityError("LANGFUSE_QUALITY_CONFLICT", "upsertScore");
    return { id: response.id };
  }

  async getOrCreateAnnotationQueue(input: GetOrCreateAnnotationQueueInput,
    context?: LangfuseQualityRequestContext): Promise<AnnotationQueueRecord> {
    const name = requireNonEmpty(input.name, "name");
    const existing = await this.findAnnotationQueue(name, context);
    if (existing) return validateAndMapQueue(existing, input);
    try {
      const created = await this.call("createAnnotationQueue", () => this.client.api.annotationQueues.createQueue({
        name,
        description: input.description,
        scoreConfigIds: [...input.scoreConfigIds],
      }, this.options(context)));
      return validateAndMapQueue(created, input);
    } catch (error) {
      if (!isQualityCode(error, "LANGFUSE_QUALITY_CONFLICT")) throw error;
      const concurrent = await this.findAnnotationQueue(name, context);
      if (!concurrent) throw error;
      return validateAndMapQueue(concurrent, input);
    }
  }

  async addAnnotationQueueItem(input: AddAnnotationQueueItemInput,
    context?: LangfuseQualityRequestContext): Promise<AnnotationQueueItemRecord> {
    const queueId = requireNonEmpty(input.queueId, "queueId");
    const objectId = requireNonEmpty(input.objectId, "objectId");
    const existing = await this.findAnnotationQueueItem(queueId, objectId, input.objectType, context);
    if (existing) return mapQueueItem(existing);
    try {
      return mapQueueItem(await this.call("addAnnotationQueueItem", () =>
        this.client.api.annotationQueues.createQueueItem(queueId, {
          objectId,
          objectType: input.objectType,
        }, { ...this.options(context), maxRetries: 0 })));
    } catch (error) {
      if (!isQualityCode(error, "LANGFUSE_QUALITY_CONFLICT")) throw error;
      const concurrent = await this.findAnnotationQueueItem(queueId, objectId, input.objectType, context);
      if (!concurrent) throw error;
      return mapQueueItem(concurrent);
    }
  }

  async listHumanAnnotationScores(input: ListHumanAnnotationScoresInput,
    context?: LangfuseQualityRequestContext): Promise<HumanAnnotationScore[]> {
    const traceId = requireNonEmpty(input.traceId, "traceId");
    const pageSize = boundedInteger(input.pageSize ?? DEFAULT_PAGE_SIZE, 1, 100, "listHumanAnnotationScores");
    const maxPages = boundedInteger(input.maxPages ?? DEFAULT_MAX_PAGES, 1, 100, "listHumanAnnotationScores");
    const maxItems = boundedInteger(input.maxItems ?? DEFAULT_MAX_ITEMS, 1, 10_000, "listHumanAnnotationScores");
    const output: HumanAnnotationScore[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages && output.length < maxItems; page += 1) {
      const response = await this.call("listHumanAnnotationScores", () => this.client.api.scoresV3.getManyV3({
        traceId,
        source: "ANNOTATION",
        fields: "details,subject,annotation",
        limit: Math.min(pageSize, maxItems - output.length),
        cursor,
      }, this.options(context)));
      for (const score of response.data) {
        if (score.source !== "ANNOTATION") continue;
        const subjectTraceId = traceIdForSubject(score.subject);
        if (subjectTraceId !== traceId) continue;
        output.push(mapHumanScore(score, traceId));
        if (output.length >= maxItems) break;
      }
      cursor = response.meta.cursor;
      if (!cursor) break;
    }
    return output;
  }

  async listHumanAnnotationScorePage(input: HumanAnnotationScorePageInput,
    context?: LangfuseQualityRequestContext): Promise<HumanAnnotationScorePage> {
    const traceId = requireNonEmpty(input.traceId, "traceId");
    const queueId = requireNonEmpty(input.queueId, "queueId");
    const configId = requireNonEmpty(input.configId, "configId");
    const limit = boundedInteger(input.limit ?? DEFAULT_PAGE_SIZE, 1, 100, "listHumanAnnotationScorePage");
    const response = await this.call("listHumanAnnotationScorePage", () => this.client.api.scoresV3.getManyV3({
      traceId,
      source: "ANNOTATION",
      fields: "details,subject,annotation",
      limit,
      cursor: input.cursor,
    }, this.options(context)));
    const scores = response.data.filter((score) => score.source === "ANNOTATION"
        && score.queueId === queueId && score.configId === configId
        && traceIdForSubject(score.subject) === traceId)
      .map((score) => mapHumanScore(score, traceId));
    return { scores, ...(response.meta.cursor ? { nextCursor: response.meta.cursor } : {}) };
  }

  private async findScoreConfig(name: string, context?: LangfuseQualityRequestContext) {
    for (let page = 1; page <= DEFAULT_MAX_PAGES; page += 1) {
      const response = await this.call("listScoreConfigs", () =>
        this.client.api.scoreConfigs.get({ page, limit: DEFAULT_PAGE_SIZE }, this.options(context)));
      const match = response.data.find((config) => !config.isArchived && config.name === name);
      if (match) return match;
      if (page >= response.meta.totalPages) return undefined;
    }
    return undefined;
  }

  private async findAnnotationQueue(name: string, context?: LangfuseQualityRequestContext) {
    for (let page = 1; page <= DEFAULT_MAX_PAGES; page += 1) {
      const response = await this.call("listAnnotationQueues", () =>
        this.client.api.annotationQueues.listQueues({ page, limit: DEFAULT_PAGE_SIZE }, this.options(context)));
      const match = response.data.find((queue) => queue.name === name);
      if (match) return match;
      if (page >= response.meta.totalPages) return undefined;
    }
    return undefined;
  }

  private async findAnnotationQueueItem(queueId: string, objectId: string,
    objectType: AddAnnotationQueueItemInput["objectType"], context?: LangfuseQualityRequestContext) {
    for (let page = 1; page <= DEFAULT_MAX_PAGES; page += 1) {
      const response = await this.call("listAnnotationQueueItems", () =>
        this.client.api.annotationQueues.listQueueItems(queueId, { page, limit: DEFAULT_PAGE_SIZE }, this.options(context)));
      const match = response.data.find((item) => item.objectId === objectId && item.objectType === objectType);
      if (match) return match;
      if (page >= response.meta.totalPages) return undefined;
    }
    return undefined;
  }

  private async call<T>(operation: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof LangfuseQualityError) throw error;
      throw new LangfuseQualityError(classifyError(error), operation);
    }
  }

  private options(context?: LangfuseQualityRequestContext): RequestOptions {
    context?.signal?.throwIfAborted();
    return context?.signal ? { ...this.requestOptions, abortSignal: context.signal } : this.requestOptions;
  }
}

function mapTextPrompt(prompt: { name: string; version: number; prompt: string; config?: unknown; labels: string[] }): TextPromptRecord {
  return { name: prompt.name, version: prompt.version, text: prompt.prompt, config: prompt.config, labels: [...prompt.labels] };
}

function mapDataset(dataset: { id: string; name: string; description: string | null; metadata?: unknown }): DatasetRecord {
  return { id: dataset.id, name: dataset.name, description: dataset.description, metadata: dataset.metadata };
}

function validateAndMapScoreConfig(
  config: { id: string; name: string; dataType: string; description?: string | null; minValue?: number | null; maxValue?: number | null; categories?: { value: number; label: string }[] },
  expected: GetOrCreateScoreConfigInput,
): ScoreConfigRecord {
  const actualCategories = config.categories?.map(({ value, label }) => ({ value, label })) ?? [];
  const expectedCategories = expected.categories ?? [];
  if (config.dataType !== expected.kind
    || (expected.minValue !== undefined && config.minValue !== expected.minValue)
    || (expected.maxValue !== undefined && config.maxValue !== expected.maxValue)
    || (expected.categories !== undefined && !sameCategories(actualCategories, expectedCategories))) {
    throw new LangfuseQualityError("LANGFUSE_QUALITY_CONFLICT", "getOrCreateScoreConfig");
  }
  return {
    id: config.id,
    name: config.name,
    kind: expected.kind,
    description: config.description ?? undefined,
    minValue: config.minValue ?? undefined,
    maxValue: config.maxValue ?? undefined,
    categories: config.categories?.map((category) => ({ ...category })),
  };
}

function sameCategories(
  actual: { value: number; label: string }[],
  expected: { value: number; label: string }[],
): boolean {
  if (actual.length !== expected.length) return false;
  const orderedActual = [...actual].sort(compareCategory);
  const orderedExpected = [...expected].sort(compareCategory);
  return orderedActual.every((category, index) => {
    const other = orderedExpected[index];
    return other?.value === category.value && other.label === category.label;
  });
}

function compareCategory(left: { value: number; label: string }, right: { value: number; label: string }): number {
  return left.value - right.value || left.label.localeCompare(right.label);
}

function validateAndMapQueue(
  queue: { id: string; name: string; description: string | null; scoreConfigIds: string[] },
  expected: GetOrCreateAnnotationQueueInput,
): AnnotationQueueRecord {
  const actualIds = [...queue.scoreConfigIds].sort();
  const expectedIds = [...expected.scoreConfigIds].sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new LangfuseQualityError("LANGFUSE_QUALITY_CONFLICT", "getOrCreateAnnotationQueue");
  }
  return { id: queue.id, name: queue.name, description: queue.description, scoreConfigIds: [...queue.scoreConfigIds] };
}

function mapQueueItem(item: { id: string; queueId: string; objectId: string; objectType: AddAnnotationQueueItemInput["objectType"] }): AnnotationQueueItemRecord {
  return { id: item.id, queueId: item.queueId, objectId: item.objectId, objectType: item.objectType };
}

function traceIdForSubject(subject: { kind: string; id: string; traceId?: string } | undefined): string | undefined {
  if (!subject) return undefined;
  if (subject.kind === "trace") return subject.id;
  if (subject.kind === "observation") return subject.traceId;
  return undefined;
}

function mapHumanScore(score: {
  id: string;
  subject?: { kind: string; id: string; traceId?: string };
  name: string;
  dataType: HumanAnnotationScore["kind"];
  value: number | boolean | string;
  comment?: string | null;
  configId?: string | null;
  queueId?: string | null;
  authorUserId?: string | null;
  timestamp: string;
}, traceId: string): HumanAnnotationScore {
  return { id: score.id, traceId,
    observationId: score.subject?.kind === "observation" ? score.subject.id : undefined,
    name: score.name, kind: score.dataType, value: score.value, comment: score.comment,
    configId: score.configId, queueId: score.queueId, authorUserId: score.authorUserId,
    timestamp: score.timestamp };
}

function normalizeBaseUrl(value: string): string {
  const raw = requireNonEmpty(value, "baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LangfuseQualityError("LANGFUSE_QUALITY_INVALID_CONFIG", "constructor");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username || url.password || url.search || url.hash) {
    throw new LangfuseQualityError("LANGFUSE_QUALITY_INVALID_CONFIG", "constructor");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function requireNonEmpty(value: string, _field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalidInput("inputValidation");
  return value.trim();
}

function requirePromptName(value: string): string {
  const name = requireNonEmpty(value, "name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(name)) invalidInput("promptName");
  return name;
}

function boundedInteger(value: number, min: number, max: number, operation: string): number {
  if (!Number.isInteger(value) || value < min || value > max) invalidInput(operation);
  return value;
}

function invalidInput(operation: string): never {
  throw new LangfuseQualityError("LANGFUSE_QUALITY_INVALID_CONFIG", operation);
}

function isQualityCode(error: unknown, code: LangfuseQualityErrorCode): error is LangfuseQualityError {
  return error instanceof LangfuseQualityError && error.code === code;
}

function classifyError(error: unknown): LangfuseQualityErrorCode {
  const status = typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
  if (status === 401) return "LANGFUSE_QUALITY_UNAUTHORIZED";
  if (status === 403) return "LANGFUSE_QUALITY_FORBIDDEN";
  if (status === 404) return "LANGFUSE_QUALITY_NOT_FOUND";
  if (status === 409) return "LANGFUSE_QUALITY_CONFLICT";
  if (status === 429) return "LANGFUSE_QUALITY_RATE_LIMITED";
  if (status !== undefined && status >= 500) return "LANGFUSE_QUALITY_UNAVAILABLE";
  const name = error instanceof Error ? error.name : "";
  if (name === "LangfuseAPITimeoutError" || name === "AbortError") return "LANGFUSE_QUALITY_TIMEOUT";
  if (error instanceof Error && /abort|cancel/iu.test(error.message)) return "LANGFUSE_QUALITY_TIMEOUT";
  if (error instanceof Error && error.message === '"timeout"') return "LANGFUSE_QUALITY_TIMEOUT";
  if (error instanceof TypeError) return "LANGFUSE_QUALITY_UNAVAILABLE";
  return "LANGFUSE_QUALITY_REQUEST_FAILED";
}
