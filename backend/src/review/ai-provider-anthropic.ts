import {
  fetchWithRetry,
  readNumberEnv,
  readOptionalStringEnv,
} from "#core";
import { parseJsonFromModelText } from "./ai-provider-json.js";

const MAX_ERROR_BODY_PREVIEW_CHARS = 300;

type AnthropicResponsePayload = {
  content?: Array<{ type?: string; text?: string; input?: unknown }>;
};

export async function callAnthropicJson(params: {
  model: string;
  prompt: string;
  systemPrompt: string;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
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
    retries: readNumberEnv("AI_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
  } as const;

  const sendRequest = async (useTools: boolean): Promise<Response> =>
    fetchWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          buildAnthropicRequestBody({
            model: params.model,
            systemPrompt: params.systemPrompt,
            prompt: params.prompt,
            responseSchema: useTools ? params.responseSchema : undefined,
          }),
        ),
      },
      requestOptions,
    );

  let response = await sendRequest(Boolean(params.responseSchema));
  if (!response.ok) {
    const body = await response.text();
    if (
      params.responseSchema &&
      shouldRetryAnthropicWithoutTools(response.status, body)
    ) {
      params.onFallback?.("anthropic.tools.fallback_to_plain_messages", {
        model: params.model,
        status: response.status,
      });
      response = await sendRequest(false);
    } else {
      throw new Error(
        `Anthropic API error (${response.status}): ${body.slice(0, MAX_ERROR_BODY_PREVIEW_CHARS)}`,
      );
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API error (${response.status}): ${body.slice(0, MAX_ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }

  const payload = (await response.json()) as AnthropicResponsePayload;
  return parseAnthropicJsonPayload(payload);
}

function buildAnthropicRequestBody(params: {
  model: string;
  systemPrompt: string;
  prompt: string;
  responseSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: Math.max(1, readNumberEnv("ANTHROPIC_MAX_TOKENS", 8_192)),
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
