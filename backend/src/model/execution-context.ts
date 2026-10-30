import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type ModelProvider = "openai" | "openai-compatible" | "anthropic" | "gemini";

export interface NormalizedModelUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOrThoughtTokens?: number;
  toolInputTokens?: number;
  totalTokens?: number;
  original: Record<string, unknown>;
}

export interface ModelRequestIntent {
  provider: ModelProvider;
  model: string;
  requestKind: string;
  requestHash: string;
  inputTokenUpperBound: number;
  maxOutputTokens: number;
  metadata?: Record<string, unknown>;
}

export interface ModelTransportResult<T> {
  value: T;
  rawResponse: unknown;
  usage?: NormalizedModelUsage;
  providerRequestId?: string;
  modelVersion?: string;
  httpStatus?: number;
}

export interface ModelExecutionContext {
  readonly policy?: unknown;
  readonly signal?: AbortSignal;
  execute<T>(
    intent: ModelRequestIntent,
    transport: () => Promise<ModelTransportResult<T>>,
  ): Promise<T>;
}

const modelExecutionStorage = new AsyncLocalStorage<ModelExecutionContext>();

export function withModelExecutionContext<T>(
  context: ModelExecutionContext,
  callback: () => Promise<T>,
): Promise<T> {
  return modelExecutionStorage.run(context, callback);
}

export function currentModelExecutionContext(): ModelExecutionContext | undefined {
  return modelExecutionStorage.getStore();
}

export function currentModelAbortSignal(): AbortSignal | undefined {
  return currentModelExecutionContext()?.signal;
}

export function currentModelOutputLimit(fallback: number): number {
  const policy = currentModelExecutionContext()?.policy;
  if (policy && typeof policy === "object" &&
      "maxOutputTokens" in policy &&
      Number.isSafeInteger(policy.maxOutputTokens) && Number(policy.maxOutputTokens) > 0) {
    return Math.min(fallback, Number(policy.maxOutputTokens));
  }
  return fallback;
}

export function currentOpenAiTokenParameter(
  fallback: "max_completion_tokens" | "max_tokens",
): "max_completion_tokens" | "max_tokens" {
  const policy = currentModelExecutionContext()?.policy;
  if (policy && typeof policy === "object" &&
      "openAiTokenParameter" in policy &&
      (policy.openAiTokenParameter === "max_tokens" ||
       policy.openAiTokenParameter === "max_completion_tokens")) {
    return policy.openAiTokenParameter;
  }
  return fallback;
}

export async function executeModelRequest<T>(
  intent: ModelRequestIntent,
  transport: () => Promise<ModelTransportResult<T>>,
): Promise<T> {
  const context = currentModelExecutionContext();
  if (!context) throw new ModelExecutionContextRequiredError(intent.requestKind);
  context.signal?.throwIfAborted();
  return context.execute(intent, async () => {
    context.signal?.throwIfAborted();
    return transport();
  });
}

export class ModelExecutionContextRequiredError extends Error {
  constructor(readonly requestKind: string) {
    super(`model request requires a Run execution context: ${requestKind}`);
    this.name = "ModelExecutionContextRequiredError";
  }
}

export function modelRequestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function estimateInputTokenUpperBound(...values: unknown[]): number {
  const bytes = Buffer.byteLength(stableJson(values), "utf8");
  // UTF-8 bytes are a deliberately conservative provider-neutral admission bound.
  return Math.max(1, bytes);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
