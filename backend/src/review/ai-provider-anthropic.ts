import { ProviderHttpError } from "../core/provider-http-error.js";
import {
  fetchWithRetry,
  readNumberEnv,
  readOptionalStringEnv,
} from "#core";
import { parseJsonFromModelText } from "./ai-provider-json.js";
import {
  currentModelExecutionContext,
  currentModelAbortSignal,
  currentModelOutputLimit,
  estimateInputTokenUpperBound,
  executeModelRequest,
  modelRequestHash,
  type NormalizedModelUsage,
} from "../model/execution-context.js";

const MAX_ERROR_BODY_PREVIEW_CHARS = 300;

type AnthropicResponsePayload = {
  id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  content?: Array<{ type?: string; text?: string; input?: unknown }>;
};

export async function callAnthropicJson(params: {
  model: string;
  prompt: string;
  systemPrompt: string;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onFallback?: (event: string, metadata: Record<string, unknown>) => void;
}): Promise<unknown> {
  const apiKey = readOptionalStringEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const requestOptions = {
    timeoutMs:
      params.timeoutMs ??
      readNumberEnv("AI_HTTP_TIMEOUT_MS", 30_000),
    retries: currentModelExecutionContext()
      ? 0
      : readNumberEnv("AI_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
  } as const;

  let physicalAttempt = 0;
  const sendRequest = async (useTools: boolean): Promise<{
    response: { ok: boolean; status: number };
    body: string;
  }> => {
    physicalAttempt += 1;
    const requestBody = buildAnthropicRequestBody({
      model: params.model,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      responseSchema: useTools ? params.responseSchema : undefined,
      maxOutputTokens: params.maxOutputTokens,
    });
    return executeModelRequest(
      {
        provider: "anthropic",
        model: params.model,
        requestKind: useTools ? "messages-tools" : "messages-plain",
        requestHash: modelRequestHash(requestBody),
        inputTokenUpperBound: estimateInputTokenUpperBound(requestBody),
        maxOutputTokens: Number(requestBody.max_tokens),
        metadata: { physicalAttempt },
      },
      async () => {
        const response = await fetchWithRetry(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            signal: combineSignals(currentModelAbortSignal(), params.signal),
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(requestBody),
          },
          requestOptions,
        );
        const body = await response.text();
        const payload = parseJsonObject(body);
        return {
          value: { response: { ok: response.ok, status: response.status }, body },
          rawResponse: { response: { ok: response.ok, status: response.status }, body },
          usage: normalizeAnthropicUsage(payload?.usage),
          providerRequestId: response.headers.get("request-id") ?? payload?.id,
          modelVersion: payload?.model,
          httpStatus: response.status,
        };
      },
    );
  };

  let result = await sendRequest(Boolean(params.responseSchema));
  let { response, body } = result;
  if (!response.ok) {
    if (
      params.responseSchema &&
      shouldRetryAnthropicWithoutTools(response.status, body)
    ) {
      params.onFallback?.("anthropic.tools.fallback_to_plain_messages", {
        model: params.model,
        status: response.status,
      });
      result = await sendRequest(false);
      response = result.response;
      body = result.body;
    } else {
      throw new ProviderHttpError("Anthropic", response.status);
    }
  }

  if (!response.ok) {
    throw new ProviderHttpError("Anthropic", response.status);
  }

  const payload = parseJsonObject(body);
  if (!payload) throw new Error("Anthropic response is not valid JSON");
  return parseAnthropicJsonPayload(payload);
}

function parseJsonObject(body: string): AnthropicResponsePayload | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as AnthropicResponsePayload
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAnthropicUsage(
  usage: AnthropicResponsePayload["usage"],
): NormalizedModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    cacheWriteInputTokens: usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: undefined,
    original: usage as Record<string, unknown>,
  };
}

function buildAnthropicRequestBody(params: {
  model: string;
  systemPrompt: string;
  prompt: string;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  const configuredMaximum = Math.max(1, readNumberEnv("ANTHROPIC_MAX_TOKENS", 8_192));
  const requestedMaximum = params.maxOutputTokens === undefined
    ? configuredMaximum
    : positiveInteger(params.maxOutputTokens, "Anthropic output limit");
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: currentModelOutputLimit(
      Math.min(configuredMaximum, requestedMaximum),
    ),
    temperature: 0.2,
    system: params.systemPrompt,
    messages: [{ role: "user", content: params.prompt }],
  };
  if (!params.responseSchema) {
    return body;
  }

  body.tools = [
    {
      name: "emit_json",
      description: "Emit a structured JSON payload matching the required schema.",
      input_schema: params.responseSchema,
    },
  ];
  body.tool_choice = { type: "tool", name: "emit_json" };
  return body;
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

export function shouldRetryAnthropicWithoutTools(
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

  const mentionsTooling =
    normalized.includes("tool_choice") ||
    normalized.includes("tool use") ||
    normalized.includes("tool_use") ||
    normalized.includes("tools") ||
    normalized.includes("input_schema");
  if (!mentionsTooling) {
    return false;
  }

  return (
    normalized.includes("unknown") ||
    normalized.includes("unsupported") ||
    normalized.includes("not support") ||
    normalized.includes("not implemented") ||
    normalized.includes("invalid_request_error")
  );
}

export function parseAnthropicJsonPayload(payload: AnthropicResponsePayload): unknown {
  const toolInput = payload.content?.find((item) => item.type === "tool_use")?.input;
  if (toolInput !== undefined) {
    return toolInput;
  }

  const text =
    payload.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n")
      .trim() ?? "";

  if (!text) {
    throw new Error("Anthropic response has no text or tool_use content");
  }

  return parseJsonFromModelText(text);
}
