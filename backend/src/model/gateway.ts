import type { OpenAIClientCache } from "./client-cache.js";
import type { ModelConfiguration } from "./configuration.js";
import type { ModelPromptReference } from "./contracts.js";
import { callAnthropicJson } from "./providers/anthropic.js";
import { callGeminiJson } from "./providers/gemini.js";
import {
  callOpenAIJsonWithFallback,
  getSharedModelRuntime,
  type ModelRuntime,
} from "./runtime.js";

export interface JsonModelGatewayRequest {
  configuration: ModelConfiguration;
  requestKind: string;
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  prompt: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  promptReferences?: readonly ModelPromptReference[];
  fallbackPolicy: "strict-structured" | "permissive-json";
  nonJsonFallback?: (text: string) => unknown;
  jsonOnlyHint?: string;
  onFallback?: (event: string, metadata: Record<string, unknown>) => void;
  runtime?: ModelRuntime;
  clientCache?: OpenAIClientCache;
}

export async function requestJsonModel(request: JsonModelGatewayRequest): Promise<unknown> {
  const { configuration } = request;
  if (configuration.provider === "anthropic") {
    return callAnthropicJson({
      model: configuration.model,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      responseSchema: request.schema,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      signal: request.signal,
      requestKind: request.requestKind,
      metadata: gatewayMetadata(request),
      onFallback: request.onFallback,
    });
  }
  if (configuration.provider === "gemini") {
    return callGeminiJson({
      model: configuration.model,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      responseSchema: request.schema,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      signal: request.signal,
      requestKind: request.requestKind,
      metadata: gatewayMetadata(request),
      onFallback: request.onFallback,
    });
  }

  const runtime = request.runtime ?? getSharedModelRuntime();
  return callOpenAIJsonWithFallback({
    provider: configuration.provider,
    model: configuration.model,
    prompt: request.prompt,
    systemPrompt: request.systemPrompt,
    timeoutMs: request.timeoutMs,
    schemaName: request.schemaName,
    schema: request.schema,
    maxOutputTokens: request.maxOutputTokens,
    signal: request.signal,
    fallbackPolicy: request.fallbackPolicy,
    nonJsonFallback: request.nonJsonFallback,
    jsonOnlyHint: request.jsonOnlyHint,
    requestKind: request.requestKind,
    metadata: gatewayMetadata(request),
    runtime: request.clientCache
      ? { ...runtime, clientCache: request.clientCache }
      : runtime,
    onFallback: request.onFallback,
  });
}

function gatewayMetadata(request: JsonModelGatewayRequest): Record<string, unknown> {
  return {
    schemaName: request.schemaName,
    ...request.metadata,
    ...(request.promptReferences && request.promptReferences.length > 0
      ? { promptReferences: request.promptReferences }
      : {}),
  };
}
