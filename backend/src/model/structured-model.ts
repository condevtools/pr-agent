import type {
  StructuredModel,
  StructuredModelRequest,
} from "./contracts.js";
import type { ModelConfiguration } from "./configuration.js";
import { currentModelAbortSignal } from "./execution-context.js";
import type { OpenAIClientCache } from "./client-cache.js";
import type { AiConcurrencyLimiter } from "./concurrency.js";
import { resolveModelConfiguration } from "./configuration.js";
import { getSharedModelRuntime } from "./runtime.js";
import { requestJsonModel } from "./gateway.js";

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
  const parsed = await requestJsonModel({
    configuration,
    requestKind: "structured",
    schemaName: request.schemaName,
    schema: request.jsonSchema,
    prompt: effectiveRequest.prompt,
    systemPrompt: effectiveRequest.systemPrompt,
    maxOutputTokens: request.maxOutputTokens,
    signal: request.signal,
    metadata: { role: request.role, turn: request.turn },
    fallbackPolicy: "strict-structured",
    clientCache,
  });
  return request.schema.parse(parsed);
}

function compatibleStructuredSystemPrompt<T>(request: StructuredModelRequest<T>): string {
  return `${request.systemPrompt}\n\nThe response must be only one JSON value that validates against this exact JSON Schema. `
    + `Do not rename fields, add fields, or use tool-call wrappers.\n${JSON.stringify(request.jsonSchema)}`;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}
