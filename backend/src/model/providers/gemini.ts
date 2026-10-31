import { ProviderHttpError } from "../../core/http/provider-error.js";
import { fetchWithRetry, readNumberEnv, readOptionalStringEnv } from "#core";
import { parseJsonFromModelText } from "./json.js";
import {
  currentModelAbortSignal,
  currentModelOutputLimit,
  estimateInputTokenUpperBound,
  executeModelRequest,
  modelRequestHash,
  type NormalizedModelUsage,
} from "../execution-context.js";

const MAX_ERROR_BODY_PREVIEW_CHARS = 300;

export async function callGeminiJson(params: {
  model: string;
  prompt: string;
  systemPrompt: string;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onFallback?: (event: string, metadata: Record<string, unknown>) => void;
  requestKind?: string;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const apiKey = readOptionalStringEnv("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    params.model,
  )}:generateContent`;

  const requestOptions = {
    timeoutMs:
      params.timeoutMs ??
      readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
    retries: 0,
    backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
  } as const;

  let physicalAttempt = 0;
  const sendRequest = async (includeSchema: boolean): Promise<{
    response: { ok: boolean; status: number };
    body: string;
  }> => {
    physicalAttempt += 1;
    const generationConfig = buildGeminiGenerationConfig(
      includeSchema ? params.responseSchema : undefined,
      params.maxOutputTokens,
    );
    const requestBody = {
      systemInstruction: { parts: [{ text: params.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: params.prompt }] }],
      generationConfig,
    };
    return executeModelRequest(
      {
        provider: "gemini",
        model: params.model,
        requestKind: `${params.requestKind ? `${params.requestKind}:` : ""}${includeSchema ? "generate-content-schema" : "generate-content-json"}`,
        requestHash: modelRequestHash(requestBody),
        inputTokenUpperBound: estimateInputTokenUpperBound(requestBody),
        maxOutputTokens: generationConfig.maxOutputTokens,
        metadata: { ...params.metadata, physicalAttempt },
      },
      async () => {
        const response = await fetchWithRetry(
          endpoint,
          {
            method: "POST",
            signal: combineSignals(currentModelAbortSignal(), params.signal),
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(requestBody),
          },
          requestOptions,
        );
        const body = await response.text();
        const payload = parseGeminiPayload(body);
        return {
          value: { response: { ok: response.ok, status: response.status }, body },
          rawResponse: { response: { ok: response.ok, status: response.status }, body },
          usage: normalizeGeminiUsage(payload?.usageMetadata),
          providerRequestId: payload?.responseId,
          modelVersion: payload?.modelVersion,
          httpStatus: response.status,
          observationOutput: payload?.candidates?.map((candidate) => candidate.content),
        };
      },
      { input: [{ role: "system", content: params.systemPrompt },
        { role: "user", content: params.prompt }], parameters: generationConfig },
    );
  };

  let result = await sendRequest(Boolean(params.responseSchema));
  let { response, body } = result;
  if (!response.ok) {
    if (
      params.responseSchema &&
      shouldRetryGeminiWithoutSchema(response.status, body)
    ) {
      params.onFallback?.("gemini.schema.fallback_to_plain_json", {
        model: params.model,
        status: response.status,
      });
      result = await sendRequest(false);
      response = result.response;
      body = result.body;
    } else {
      throw new ProviderHttpError("Gemini", response.status);
    }
  }

  if (!response.ok) {
    throw new ProviderHttpError("Gemini", response.status);
  }

  const payload = parseGeminiPayload(body);
  if (!payload) throw new Error("Gemini response is not valid JSON");

  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim() ?? "";

  if (!text) {
    throw new Error("Gemini response has no text content");
  }

  return parseJsonFromModelText(text);
}

export function buildGeminiGenerationConfig(
  responseSchema?: Record<string, unknown>,
  maxOutputTokens?: number,
): {
  temperature: number;
  responseMimeType: string;
  maxOutputTokens: number;
  responseSchema?: Record<string, unknown>;
} {
  const configuredMaximum = Math.max(1, readNumberEnv("GEMINI_MAX_OUTPUT_TOKENS", 8_192));
  const requestedMaximum = maxOutputTokens === undefined
    ? configuredMaximum
    : positiveInteger(maxOutputTokens, "Gemini output limit");
  const boundedMaximum = currentModelOutputLimit(Math.min(configuredMaximum, requestedMaximum));
  if (responseSchema) {
    return {
      temperature: 0.2,
      responseMimeType: "application/json",
      maxOutputTokens: boundedMaximum,
      responseSchema,
    };
  }

  return {
    temperature: 0.2,
    responseMimeType: "application/json",
    maxOutputTokens: boundedMaximum,
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

interface GeminiPayload {
  responseId?: string;
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    totalTokenCount?: number;
  };
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function parseGeminiPayload(body: string): GeminiPayload | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" ? parsed as GeminiPayload : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGeminiUsage(
  usage: GeminiPayload["usageMetadata"],
): NormalizedModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount,
    cachedInputTokens: usage.cachedContentTokenCount,
    outputTokens: usage.candidatesTokenCount,
    reasoningOrThoughtTokens: usage.thoughtsTokenCount,
    toolInputTokens: usage.toolUsePromptTokenCount,
    totalTokens: usage.totalTokenCount,
    original: usage as Record<string, unknown>,
  };
}

export function shouldRetryGeminiWithoutSchema(
  status: number,
  errorText: string,
): boolean {
  if (status !== 400) {
    return false;
  }

  const normalized = errorText.toLowerCase();
  if (!normalized) {
    return false;
  }

  const mentionsSchema =
    normalized.includes("responseschema") ||
    normalized.includes("response_schema");
  if (!mentionsSchema) {
    return false;
  }

  return (
    normalized.includes("unknown name") ||
    normalized.includes("unsupported") ||
    normalized.includes("not support") ||
    normalized.includes("not implemented")
  );
}
