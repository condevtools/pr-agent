import { fetchWithRetry, readNumberEnv, readOptionalStringEnv } from "@mr-agent/core";
import { parseJsonFromModelText } from "./ai-provider-json.js";

const MAX_ERROR_BODY_PREVIEW_CHARS = 300;

export async function callGeminiJson(params: {
  model: string;
  prompt: string;
  systemPrompt: string;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  onFallback?: (event: string, metadata: Record<string, unknown>) => void;
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
    retries: readNumberEnv("AI_HTTP_RETRIES", 2),
    backoffMs: readNumberEnv("AI_HTTP_RETRY_BACKOFF_MS", 400),
  } as const;

  const sendRequest = async (includeSchema: boolean): Promise<Response> =>
    fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: params.systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: params.prompt }],
            },
          ],
          generationConfig: buildGeminiGenerationConfig(
            includeSchema ? params.responseSchema : undefined,
          ),
        }),
      },
      requestOptions,
    );

  let response = await sendRequest(Boolean(params.responseSchema));
  if (!response.ok) {
    const body = await response.text();
    if (
      params.responseSchema &&
      shouldRetryGeminiWithoutSchema(response.status, body)
    ) {
      params.onFallback?.("gemini.schema.fallback_to_plain_json", {
        model: params.model,
        status: response.status,
      });
      response = await sendRequest(false);
    } else {
      throw new Error(
        `Gemini API error (${response.status}): ${body.slice(0, MAX_ERROR_BODY_PREVIEW_CHARS)}`,
      );
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gemini API error (${response.status}): ${body.slice(0, MAX_ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

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
): {
  temperature: number;
  responseMimeType: string;
  responseSchema?: Record<string, unknown>;
} {
  if (responseSchema) {
    return {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema,
    };
  }

  return {
    temperature: 0.2,
    responseMimeType: "application/json",
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
