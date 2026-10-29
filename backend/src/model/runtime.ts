import type OpenAI from "openai";

import {
  getHttpShutdownSignal,
  readNumberEnv,
  readOptionalStringEnv,
  systemClock,
  type Clock,
} from "#core";
import { createOpenAIClientCache, type OpenAIClientCache } from "./client-cache.js";
import {
  createAiConcurrencyLimiter,
  type AiConcurrencyLimiter,
  type AiConcurrencyStats,
} from "./concurrency.js";
import { resolveOpenAIApiKey } from "./configuration.js";
import {
  currentModelAbortSignal,
  currentModelExecutionContext,
  currentModelOutputLimit,
  currentOpenAiTokenParameter,
  estimateInputTokenUpperBound,
  executeModelRequest,
  modelRequestHash,
  type NormalizedModelUsage,
} from "./execution-context.js";
import { extractModelText, parseJsonFromModelText } from "./providers/json.js";

export interface ModelRuntime {
  clock: Clock;
  clientCache: OpenAIClientCache;
  concurrencyLimiter: AiConcurrencyLimiter;
}

export function createModelRuntime(options?: Partial<ModelRuntime>): ModelRuntime {
  return {
    clock: options?.clock ?? systemClock,
    clientCache: options?.clientCache ?? createOpenAIClientCache(),
    concurrencyLimiter: options?.concurrencyLimiter ?? createAiConcurrencyLimiter(),
  };
}

const sharedModelRuntime = createModelRuntime();

export function getSharedModelRuntime(): Readonly<ModelRuntime> {
  return sharedModelRuntime;
}

export function beginModelShutdown(runtime: ModelRuntime = sharedModelRuntime): void {
  runtime.concurrencyLimiter.beginShutdown();
}

export function drainModelRequests(
  timeoutMs: number | undefined = undefined,
  runtime: ModelRuntime = sharedModelRuntime,
): Promise<boolean> {
  return runtime.concurrencyLimiter.drain(timeoutMs);
}

export function getModelConcurrencyStats(
  runtime: ModelRuntime = sharedModelRuntime,
): AiConcurrencyStats {
  return runtime.concurrencyLimiter.getStats();
}

export function resolveOpenAIClient(params: {
  provider: "openai" | "openai-compatible";
  timeoutMs: number;
  runtime: ModelRuntime;
}): OpenAI {
  const apiKey = resolveOpenAIApiKey(params.provider);
  if (!apiKey) {
    throw new Error(params.provider === "openai-compatible"
      ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
      : "Missing OPENAI_API_KEY");
  }
  const baseURL = readOptionalStringEnv("OPENAI_BASE_URL");
  if (params.provider === "openai-compatible" && !baseURL) {
    throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
  }
  return params.runtime.clientCache.get({
    apiKey,
    baseURL,
    timeout: params.timeoutMs,
    maxRetries: currentModelExecutionContext() ? 0 : readNumberEnv("AI_HTTP_RETRIES", 2),
  });
}

export async function requestOpenAICompletionText(params: {
  client: OpenAI;
  provider: "openai" | "openai-compatible";
  model: string;
  systemPrompt: string;
  prompt: string;
  responseFormat?: unknown;
}): Promise<string> {
  const maxOutputTokens = currentModelOutputLimit(Math.max(
    1,
    readNumberEnv("OPENAI_MAX_COMPLETION_TOKENS", 8_192),
  ));
  const request: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.prompt },
    ],
  };
  const tokenParameter = currentOpenAiTokenParameter(
    params.model.startsWith("o") ||
      readOptionalStringEnv("OPENAI_COMPATIBLE_TOKEN_PARAMETER") !== "max_tokens"
      ? "max_completion_tokens"
      : "max_tokens",
  );
  request[tokenParameter] = maxOutputTokens;
  if (typeof params.responseFormat !== "undefined") request.response_format = params.responseFormat;
  const completion = await executeModelRequest(
    {
      provider: params.provider,
      model: params.model,
      requestKind: typeof params.responseFormat === "undefined"
        ? "chat-completion-raw"
        : "chat-completion-structured",
      requestHash: modelRequestHash(request),
      inputTokenUpperBound: estimateInputTokenUpperBound(
        params.systemPrompt,
        params.prompt,
        params.responseFormat,
      ),
      maxOutputTokens,
      metadata: { tokenParameter },
    },
    async () => {
      const modelSignal = currentModelAbortSignal();
      const shutdownSignal = getHttpShutdownSignal();
      const response = await params.client.chat.completions.create(
        request as never,
        { signal: modelSignal ? AbortSignal.any([shutdownSignal, modelSignal]) : shutdownSignal },
      );
      return {
        value: response,
        rawResponse: response,
        usage: normalizeOpenAIUsage(response.usage),
        providerRequestId: response.id,
        modelVersion: response.model,
      };
    },
  );
  return extractModelText(completion.choices?.[0]?.message?.content);
}

export async function callOpenAIJsonWithFallback(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
  schemaName: string;
  schema: unknown;
  nonJsonFallback: (text: string) => unknown;
  jsonOnlyHint: string;
  runtime: ModelRuntime;
  onFallback?: (event: string, metadata: Record<string, unknown>) => void;
}): Promise<unknown> {
  const client = resolveOpenAIClient(params);
  try {
    const text = await requestOpenAICompletionText({
      client,
      provider: params.provider,
      model: params.model,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      responseFormat: {
        type: "json_schema",
        json_schema: { name: params.schemaName, strict: true, schema: params.schema },
      },
    });
    return parseJsonFromModelText(text);
  } catch (error) {
    if (params.provider !== "openai-compatible" || !shouldTryOpenAICompatibleFallback(error)) {
      throw error;
    }
    params.onFallback?.("openai.json_schema.fallback_to_json_object", fallbackMetadata(params, error));
  }

  const hintPrompt = `${params.prompt}\n\n${params.jsonOnlyHint}`;
  try {
    const text = await requestOpenAICompletionText({
      client,
      provider: params.provider,
      model: params.model,
      systemPrompt: params.systemPrompt,
      prompt: hintPrompt,
      responseFormat: { type: "json_object" },
    });
    return parseJsonFromModelText(text);
  } catch (error) {
    if (!shouldTryOpenAICompatibleFallback(error)) throw error;
    params.onFallback?.("openai.json_object.fallback_to_raw", fallbackMetadata(params, error));
  }

  const text = await requestOpenAICompletionText({
    client,
    provider: params.provider,
    model: params.model,
    systemPrompt: params.systemPrompt,
    prompt: hintPrompt,
  });
  try {
    return parseJsonFromModelText(text);
  } catch (error) {
    if (!isModelResponseNotJsonError(error)) throw error;
    params.onFallback?.("openai.raw.non_json_fallback", {
      provider: params.provider,
      model: params.model,
    });
    return params.nonJsonFallback(text);
  }
}

export function isModelResponseNotJsonError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("model response is not valid json") ||
    message.includes("model returned empty text") ||
    message.includes("model returned empty content");
}

export function shouldFallbackToJsonObject(error: unknown): boolean {
  if (readErrorStatus(error) !== 400) return false;
  const message = collectModelErrorText(error).toLowerCase();
  if (!message) return false;
  const mentionsFormat = message.includes("response_format") ||
    message.includes("json_schema") || message.includes("json schema");
  if (!mentionsFormat) return false;
  return [
    "unsupported", "not support", "not implemented", "invalid", "illegal",
    "not valid", "not allowed", "不合法", "非法", "无效",
  ].some((part) => message.includes(part));
}

export function readModelErrorStatus(error: unknown): number | undefined {
  return readErrorStatus(error);
}

export function collectModelErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return "";
  const root = error as {
    message?: unknown;
    error?: { message?: unknown };
    response?: { data?: { error?: { message?: unknown } } };
  };
  return [root.message, root.error?.message, root.response?.data?.error?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function shouldTryOpenAICompatibleFallback(error: unknown): boolean {
  return shouldFallbackToJsonObject(error) || isModelResponseNotJsonError(error);
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function normalizeOpenAIUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
} | undefined): NormalizedModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
    outputTokens: usage.completion_tokens,
    reasoningOrThoughtTokens: usage.completion_tokens_details?.reasoning_tokens ?? undefined,
    totalTokens: usage.total_tokens,
    original: usage as Record<string, unknown>,
  };
}

function fallbackMetadata(
  params: { provider: string; model: string },
  error: unknown,
): Record<string, unknown> {
  return {
    provider: params.provider,
    model: params.model,
    reason: error instanceof Error ? error.message : String(error),
  };
}
