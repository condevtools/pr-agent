import OpenAI from "openai";

import {
  getHttpShutdownSignal,
  readNumberEnv,
  readOptionalStringEnv,
} from "#core";
import type {
  StructuredModel,
  StructuredModelRequest,
} from "./contracts.js";
import type { ModelConfiguration } from "./configuration.js";
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
import type { OpenAIClientCache } from "./client-cache.js";
import type { AiConcurrencyLimiter } from "./concurrency.js";
import { callAnthropicJson } from "./providers/anthropic.js";
import { callGeminiJson } from "./providers/gemini.js";
import { extractModelText, parseJsonFromModelText } from "./providers/json.js";
import { resolveModelConfiguration } from "./configuration.js";
import { getSharedModelRuntime } from "./runtime.js";

export type StructuredModelConfiguration = ModelConfiguration;

export interface StructuredModelOptions {
  configuration?: StructuredModelConfiguration;
  clientCache?: OpenAIClientCache;
  concurrencyLimiter?: AiConcurrencyLimiter;
}

export function createStructuredModel(options: StructuredModelOptions = {}): StructuredModel {
  const configuration = options.configuration ?? resolveModelConfiguration();
  const sharedRuntime = getSharedModelRuntime();
  const clientCache = options.clientCache ?? sharedRuntime.clientCache;
  const concurrencyLimiter = options.concurrencyLimiter ?? sharedRuntime.concurrencyLimiter;
  return {
    generate: <T>(request: StructuredModelRequest<T>) =>
      concurrencyLimiter.withLimit(() => generateStructured(configuration, clientCache, request),
        combineSignals(request.signal, currentModelAbortSignal())),
  };
}

async function generateStructured<T>(
  configuration: StructuredModelConfiguration,
  clientCache: OpenAIClientCache,
  request: StructuredModelRequest<T>,
): Promise<T> {
  const effectiveRequest = configuration.provider === "openai-compatible"
    ? { ...request, systemPrompt: compatibleStructuredSystemPrompt(request) }
    : request;
  const inputBytes = Buffer.byteLength(JSON.stringify({
    systemPrompt: effectiveRequest.systemPrompt,
    prompt: effectiveRequest.prompt,
    schema: effectiveRequest.jsonSchema,
  }));
  if (inputBytes > request.maxInputBytes) {
    throw new Error("Structured model input exceeds the role turn limit");
  }
  const parsed = configuration.provider === "anthropic"
    ? await callAnthropicJson({
      model: configuration.model,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      responseSchema: request.jsonSchema,
      maxOutputTokens: request.maxOutputTokens,
      signal: request.signal,
    })
    : configuration.provider === "gemini"
      ? await callGeminiJson({
        model: configuration.model,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        responseSchema: request.jsonSchema,
        maxOutputTokens: request.maxOutputTokens,
        signal: request.signal,
      })
      : await callOpenAIStructured(configuration, clientCache, effectiveRequest);
  return request.schema.parse(parsed);
}

async function callOpenAIStructured<T>(
  configuration: StructuredModelConfiguration,
  clientCache: OpenAIClientCache,
  request: StructuredModelRequest<T>,
): Promise<unknown> {
  const apiKey = configuration.provider === "openai-compatible"
    ? readOptionalStringEnv("OPENAI_COMPATIBLE_API_KEY") ?? readOptionalStringEnv("OPENAI_API_KEY")
    : readOptionalStringEnv("OPENAI_API_KEY");
  if (!apiKey) throw new Error(configuration.provider === "openai-compatible"
    ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
    : "Missing OPENAI_API_KEY");
  const baseURL = readOptionalStringEnv("OPENAI_BASE_URL");
  if (configuration.provider === "openai-compatible" && !baseURL) {
    throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
  }
  const client = clientCache.get({
    apiKey,
    baseURL,
    timeout: readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
    maxRetries: currentModelExecutionContext() ? 0 : readNumberEnv("AI_HTTP_RETRIES", 2),
  });
  try {
    return await requestOpenAI(client, configuration, request, "json_schema");
  } catch (error) {
    if (configuration.provider !== "openai-compatible" || readHttpStatus(error) !== 400) throw error;
    return requestOpenAI(client, configuration, request, "json_object");
  }
}

async function requestOpenAI<T>(
  client: OpenAI,
  configuration: StructuredModelConfiguration,
  structured: StructuredModelRequest<T>,
  format: "json_schema" | "json_object",
): Promise<unknown> {
  const maxOutputTokens = Math.min(
    requestPositiveInteger(structured.maxOutputTokens, "structured model output limit"),
    currentModelOutputLimit(Math.max(1, readNumberEnv("OPENAI_MAX_COMPLETION_TOKENS", 8_192))),
  );
  const tokenParameter = currentOpenAiTokenParameter(
    configuration.model.startsWith("o") ||
      readOptionalStringEnv("OPENAI_COMPATIBLE_TOKEN_PARAMETER") !== "max_tokens"
      ? "max_completion_tokens"
      : "max_tokens",
  );
  const responseFormat = format === "json_schema"
    ? { type: "json_schema", json_schema: {
      name: structured.schemaName,
      strict: true,
      schema: structured.jsonSchema,
    } }
    : { type: "json_object" };
  const body: Record<string, unknown> = {
    model: configuration.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: structured.systemPrompt },
      { role: "user", content: structured.prompt },
    ],
    response_format: responseFormat,
    [tokenParameter]: maxOutputTokens,
  };
  const response = await executeModelRequest(
    {
      provider: configuration.provider,
      model: configuration.model,
      requestKind: `deep-review-${format}`,
      requestHash: modelRequestHash(body),
      inputTokenUpperBound: estimateInputTokenUpperBound(body),
      maxOutputTokens,
      metadata: { tokenParameter, role: structured.role, turn: structured.turn },
    },
    async () => {
      const modelSignal = combineSignals(currentModelAbortSignal(), structured.signal);
      const shutdownSignal = getHttpShutdownSignal();
      const completion = await client.chat.completions.create(
        body as never,
        { signal: modelSignal ? AbortSignal.any([shutdownSignal, modelSignal]) : shutdownSignal },
      );
      return {
        value: completion,
        rawResponse: completion,
        usage: normalizeUsage(completion.usage),
        providerRequestId: completion.id,
        modelVersion: completion.model,
      };
    },
  );
  return parseJsonFromModelText(extractModelText(response.choices?.[0]?.message?.content));
}

function compatibleStructuredSystemPrompt<T>(request: StructuredModelRequest<T>): string {
  return `${request.systemPrompt}\n\nThe response must be only one JSON value that validates against this exact JSON Schema. `
    + `Do not rename fields, add fields, or use tool-call wrappers.\n${JSON.stringify(request.jsonSchema)}`;
}

function normalizeUsage(usage: {
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

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function requestPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}
