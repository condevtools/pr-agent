import OpenAI from "openai";
import { z } from "zod";

import type {
  PullRequestReviewInput,
  PullRequestReviewResult,
} from "./review-types.js";
import type { AskConversationTurn, UiLocale } from "#core";
import {
  detectTextLocale,
  fetchWithRetry,
  getHttpShutdownSignal,
  nowMs,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
  readStringEnv,
  resolveUiLocale,
  systemClock,
  type Clock,
} from "#core";
import {
  buildAskPrompt,
  buildAskPromptWithOptions,
  buildUserPrompt,
  resolveAskSystemPrompt,
  resolveReviewSystemPrompt,
} from "./ai-prompts.js";
import {
  buildReviewFallbackFromNonJsonText,
  normalizeAskResultForSchema,
  normalizeReviewResultForSchema,
} from "./ai-result-normalization.js";
import { extractModelText, parseJsonFromModelText } from "./ai-provider-json.js";
import {
  callAnthropicJson,
  parseAnthropicJsonPayload,
  shouldRetryAnthropicWithoutTools,
} from "./ai-provider-anthropic.js";
import {
  buildGeminiGenerationConfig,
  callGeminiJson,
  shouldRetryGeminiWithoutSchema,
} from "./ai-provider-gemini.js";
import {
  createOpenAIClientCache,
  type OpenAIClientCache,
} from "./ai-client-cache.js";
import {
  createAiConcurrencyLimiter,
  type AiConcurrencyLimiter,
  type AiConcurrencyStats,
} from "./ai-concurrency.js";
export {
  buildAskPrompt,
  buildAskPromptWithOptions,
  buildUserPrompt,
  resolveAskSystemPrompt,
  resolveReviewSystemPrompt,
} from "./ai-prompts.js";
export {
  normalizeAskResultForSchema,
  normalizeReviewResultForSchema,
} from "./ai-result-normalization.js";
export {
  parseAnthropicJsonPayload,
  shouldRetryAnthropicWithoutTools,
} from "./ai-provider-anthropic.js";
export {
  buildGeminiGenerationConfig,
  shouldRetryGeminiWithoutSchema,
} from "./ai-provider-gemini.js";
type AIProvider = "openai" | "openai-compatible" | "anthropic" | "gemini";

const DEFAULT_AI_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_AI_ASK_HTTP_TIMEOUT_MS = 60_000;

export interface AiReviewerRuntime {
  clock: Clock;
  clientCache: OpenAIClientCache;
  concurrencyLimiter: AiConcurrencyLimiter;
}

export function createAiReviewerRuntime(
  options?: Partial<AiReviewerRuntime>,
): AiReviewerRuntime {
  return {
    clock: options?.clock ?? systemClock,
    clientCache: options?.clientCache ?? createOpenAIClientCache(),
    concurrencyLimiter: options?.concurrencyLimiter ?? createAiConcurrencyLimiter(),
  };
}

const defaultAiReviewerRuntime = createAiReviewerRuntime();

export function beginAiShutdown(
  runtime: AiReviewerRuntime = defaultAiReviewerRuntime,
): void {
  runtime.concurrencyLimiter.beginShutdown();
}

export async function drainAiRequests(
  timeoutMs: number | undefined = undefined,
  runtime: AiReviewerRuntime = defaultAiReviewerRuntime,
): Promise<boolean> {
  return runtime.concurrencyLimiter.drain(timeoutMs);
}

export function getAiConcurrencyStats(
  runtime: AiReviewerRuntime = defaultAiReviewerRuntime,
): AiConcurrencyStats {
  return runtime.concurrencyLimiter.getStats();
}

const reviewIssueSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  newPath: z.string().min(1),
  oldPath: z.string().min(1),
  type: z.enum(["old", "new"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  issueHeader: z.string().min(1),
  issueContent: z.string().min(1),
  suggestion: z.string().trim().min(1).max(2000).optional(),
});

const reviewResultSchema = z.object({
  summary: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high"]),
  reviews: z.array(reviewIssueSchema).max(30),
  positives: z.array(z.string()).max(10),
  actionItems: z.array(z.string()).max(10),
});

const reviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "riskLevel", "reviews", "positives", "actionItems"],
  properties: {
    summary: { type: "string" },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    reviews: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "newPath",
          "oldPath",
          "type",
          "startLine",
          "endLine",
          "issueHeader",
          "issueContent",
        ],
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          newPath: { type: "string" },
          oldPath: { type: "string" },
          type: { type: "string", enum: ["old", "new"] },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          issueHeader: { type: "string" },
          issueContent: { type: "string" },
          suggestion: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
          },
        },
      },
    },
    positives: {
      type: "array",
      maxItems: 10,
      items: { type: "string" },
    },
    actionItems: {
      type: "array",
      maxItems: 10,
      items: { type: "string" },
    },
  },
} as const;

const askResultSchema = z.object({
  answer: z.string().trim().min(1).max(10_000),
});

const askResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string" },
  },
} as const;

export async function analyzePullRequest(
  pullRequest: PullRequestReviewInput,
  options?: {
    runtime?: AiReviewerRuntime;
  },
): Promise<PullRequestReviewResult> {
  const runtime = options?.runtime ?? defaultAiReviewerRuntime;
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const prompt = buildUserPrompt(pullRequest);

  const parsed = await runtime.concurrencyLimiter.withLimit(async () => {
    if (provider === "openai" || provider === "openai-compatible") {
      return analyzeWithOpenAI({ provider, model, prompt, runtime });
    }
    if (provider === "anthropic") {
      return analyzeWithAnthropic({ model, prompt });
    }
    return analyzeWithGemini({ model, prompt });
  });

  const result = reviewResultSchema.parse(
    normalizeReviewResultForSchema(parsed),
  );
  return {
    ...result,
    reviews: result.reviews.map((item) => {
      const startLine = Math.min(item.startLine, item.endLine);
      const endLine = Math.max(item.startLine, item.endLine);
      const suggestion = item.suggestion?.trim();
      return {
        ...item,
        startLine,
        endLine,
        suggestion: suggestion || undefined,
      };
    }),
  };
}

export async function answerPullRequestQuestion(
  pullRequest: PullRequestReviewInput,
  question: string,
  options?: {
    conversation?: AskConversationTurn[];
    runtime?: AiReviewerRuntime;
  },
): Promise<string> {
  const runtime = options?.runtime ?? defaultAiReviewerRuntime;
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const conversation = options?.conversation ?? [];
  const locale = detectTextLocale(question);
  const prompt = buildAskPrompt(pullRequest, question, conversation, locale);

  const parsed = await runtime.concurrencyLimiter.withLimit(async () => {
    try {
      if (provider === "openai" || provider === "openai-compatible") {
        return await askWithOpenAI({ provider, model, prompt, locale, runtime });
      }
      if (provider === "anthropic") {
        return await askWithAnthropic({ model, prompt, locale });
      }
      return await askWithGemini({ model, prompt, locale });
    } catch (error) {
      if (!shouldRetryAskWithCompactContext(error)) {
        throw error;
      }
      logAiDebug("ask.compact_context_retry", {
        provider,
        model,
        reason: error instanceof Error ? error.message : String(error),
      });

      const compactPrompt = buildAskPromptWithOptions({
        pullRequest,
        question,
        conversation: [],
        maxDiffFiles: 12,
        locale,
      });

      if (provider === "openai" || provider === "openai-compatible") {
        return askWithOpenAI({ provider, model, prompt: compactPrompt, locale, runtime });
      }
      if (provider === "anthropic") {
        return askWithAnthropic({ model, prompt: compactPrompt, locale });
      }
      return askWithGemini({ model, prompt: compactPrompt, locale });
    }
  });

  const result = askResultSchema.parse(normalizeAskResultForSchema(parsed));
  return result.answer.trim();
}

function resolveProvider(): AIProvider {
  const raw = readStringEnv("AI_PROVIDER", "openai").toLowerCase();

  if (raw === "openai") {
    return "openai";
  }

  if (
    raw === "openai-compatible" ||
    raw === "openai_compatible" ||
    raw === "compatible"
  ) {
    return "openai-compatible";
  }

  if (raw === "anthropic" || raw === "claude") {
    return "anthropic";
  }

  if (raw === "gemini" || raw === "google") {
    return "gemini";
  }

  throw new Error(`Unsupported AI_PROVIDER: ${raw}`);
}

function resolveModel(provider: AIProvider): string {
  const genericModel = readOptionalStringEnv("AI_MODEL");
  if (genericModel) {
    return genericModel;
  }

  if (provider === "openai") {
    return readStringEnv("OPENAI_MODEL", "gpt-4.1-mini");
  }

  if (provider === "openai-compatible") {
    return readStringEnv("OPENAI_COMPATIBLE_MODEL", "gpt-4o-mini");
  }

  if (provider === "anthropic") {
    return readStringEnv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest");
  }

  return readStringEnv("GEMINI_MODEL", "gemini-2.0-flash");
}

function resolveOpenAIApiKey(provider: AIProvider): string | undefined {
  return provider === "openai-compatible"
    ? (readOptionalStringEnv("OPENAI_COMPATIBLE_API_KEY") ?? readOptionalStringEnv("OPENAI_API_KEY"))
    : readOptionalStringEnv("OPENAI_API_KEY");
}

function resolveOpenAIClientForProvider(params: {
  provider: "openai" | "openai-compatible";
  timeoutMs: number;
  runtime: AiReviewerRuntime;
}): OpenAI {
  const apiKey = resolveOpenAIApiKey(params.provider);
  if (!apiKey) {
    throw new Error(
      params.provider === "openai-compatible"
        ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
        : "Missing OPENAI_API_KEY",
    );
  }

  const baseURL = readOptionalStringEnv("OPENAI_BASE_URL");
  if (params.provider === "openai-compatible" && !baseURL) {
    throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
  }

  const maxRetries = readNumberEnv("AI_HTTP_RETRIES", 2);
  return params.runtime.clientCache.get({
    apiKey,
    baseURL,
    timeout: params.timeoutMs,
    maxRetries,
  });
}

async function requestOpenAICompletionText(params: {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  prompt: string;
  responseFormat?: unknown;
}): Promise<string> {
  const request: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: params.systemPrompt,
      },
      {
        role: "user",
        content: params.prompt,
      },
    ],
  };
  if (typeof params.responseFormat !== "undefined") {
    request.response_format = params.responseFormat;
  }
  const completion = await params.client.chat.completions.create(
    request as never,
    {
      signal: getHttpShutdownSignal(),
    },
  );
  return extractModelText(completion.choices?.[0]?.message?.content);
}

function buildOpenAIJsonOnlyHintPrompt(prompt: string): string {
  return `${prompt}\n\n${resolveUiLocale() === "en" ? "Return JSON only." : "请直接返回 JSON。"}`;
}

function isAiDebugLoggingEnabled(
  rawValue: string | undefined = readOptionalStringEnv("AI_DEBUG_LOGS"),
): boolean {
  return parseBooleanEnv(rawValue);
}

function logAiDebug(event: string, metadata?: Record<string, unknown>): void {
  if (!isAiDebugLoggingEnabled()) {
    return;
  }
  const payload = metadata ? ` ${JSON.stringify(metadata)}` : "";
  console.info(`[pr-agent][ai] ${event}${payload}`);
}

async function callOpenAIJsonWithFallback(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
  schemaName: string;
  schema: unknown;
  nonJsonFallback: (text: string) => unknown;
  runtime: AiReviewerRuntime;
}): Promise<unknown> {
  const client = resolveOpenAIClientForProvider({
    provider: params.provider,
    timeoutMs: params.timeoutMs,
    runtime: params.runtime,
  });

  try {
    const text = await requestOpenAICompletionText({
      client,
      model: params.model,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: params.schemaName,
          strict: true,
          schema: params.schema,
        },
      },
    });
    return parseJsonFromModelText(text);
  } catch (error) {
    if (
      params.provider !== "openai-compatible" ||
      !shouldTryOpenAICompatibleFallback(error)
    ) {
      throw error;
    }
    logAiDebug("openai.json_schema.fallback_to_json_object", {
      provider: params.provider,
      model: params.model,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const hintPrompt = buildOpenAIJsonOnlyHintPrompt(params.prompt);
  try {
    const text = await requestOpenAICompletionText({
      client,
      model: params.model,
      systemPrompt: params.systemPrompt,
      prompt: hintPrompt,
      responseFormat: {
        type: "json_object",
      },
    });
    return parseJsonFromModelText(text);
  } catch (fallbackError) {
    if (!shouldTryOpenAICompatibleFallback(fallbackError)) {
      throw fallbackError;
    }
    logAiDebug("openai.json_object.fallback_to_raw", {
      provider: params.provider,
      model: params.model,
      reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
    });
  }

  const text = await requestOpenAICompletionText({
    client,
    model: params.model,
    systemPrompt: params.systemPrompt,
    prompt: hintPrompt,
  });
  try {
    return parseJsonFromModelText(text);
  } catch (parseError) {
    if (!isModelResponseNotJsonError(parseError)) {
      throw parseError;
    }
    logAiDebug("openai.raw.non_json_fallback", {
      provider: params.provider,
      model: params.model,
    });
    return params.nonJsonFallback(text);
  }
}

async function analyzeWithOpenAI(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
  runtime: AiReviewerRuntime;
}): Promise<unknown> {
  return callOpenAIJsonWithFallback({
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveReviewSystemPrompt(),
    timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", DEFAULT_AI_HTTP_TIMEOUT_MS),
    schemaName: "pr_review",
    schema: reviewResultJsonSchema,
    nonJsonFallback: buildReviewFallbackFromNonJsonText,
    runtime: params.runtime,
  });
}

async function analyzeWithAnthropic(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  return callAnthropicJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveReviewSystemPrompt(),
    responseSchema: reviewResultJsonSchema,
    onFallback: (event, metadata) => {
      logAiDebug(event, metadata);
    },
  });
}

async function analyzeWithGemini(params: {
  model: string;
  prompt: string;
}): Promise<unknown> {
  return callGeminiJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveReviewSystemPrompt(),
    responseSchema: reviewResultJsonSchema,
    onFallback: (event, metadata) => {
      logAiDebug(event, metadata);
    },
  });
}

async function askWithOpenAI(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
  locale: UiLocale;
  runtime: AiReviewerRuntime;
}): Promise<unknown> {
  return callOpenAIJsonWithFallback({
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveAskSystemPrompt(params.locale),
    timeoutMs: readNumberEnv(
      "AI_ASK_HTTP_TIMEOUT_MS",
      Math.max(
        DEFAULT_AI_ASK_HTTP_TIMEOUT_MS,
        readNumberEnv("AI_HTTP_TIMEOUT_MS", DEFAULT_AI_HTTP_TIMEOUT_MS),
      ),
    ),
    schemaName: "pr_ask",
    schema: askResultJsonSchema,
    nonJsonFallback: (text) => ({ answer: text.trim() || "Model returned empty answer." }),
    runtime: params.runtime,
  });
}

function shouldTryOpenAICompatibleFallback(error: unknown): boolean {
  return shouldFallbackToJsonObject(error) || isModelResponseNotJsonError(error);
}

export function isModelResponseNotJsonError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("model response is not valid json") ||
    message.includes("model returned empty text") ||
    message.includes("model returned empty content")
  );
}

export function shouldFallbackToJsonObject(error: unknown): boolean {
  if (readErrorStatus(error) !== 400) {
    return false;
  }

  const message = collectErrorText(error).toLowerCase();
  if (!message) {
    return false;
  }

  const mentionsResponseFormat = message.includes("response_format");
  const mentionsJsonSchema =
    message.includes("json_schema") || message.includes("json schema");
  if (!mentionsResponseFormat && !mentionsJsonSchema) {
    return false;
  }

  return (
    message.includes("unsupported") ||
    message.includes("not support") ||
    message.includes("not implemented") ||
    message.includes("invalid") ||
    message.includes("illegal") ||
    message.includes("not valid") ||
    message.includes("not allowed") ||
    message.includes("不合法") ||
    message.includes("非法") ||
    message.includes("无效")
  );
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = (error as { status?: unknown }).status;
  return typeof candidate === "number" ? candidate : undefined;
}

function collectErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (!error || typeof error !== "object") {
    return "";
  }

  const bucket: string[] = [];
  const root = error as {
    message?: unknown;
    error?: { message?: unknown };
    response?: { data?: { error?: { message?: unknown } } };
  };

  if (typeof root.message === "string") {
    bucket.push(root.message);
  }
  if (typeof root.error?.message === "string") {
    bucket.push(root.error.message);
  }
  if (typeof root.response?.data?.error?.message === "string") {
    bucket.push(root.response.data.error.message);
  }

  return bucket.join(" ");
}

async function askWithAnthropic(params: {
  model: string;
  prompt: string;
  locale: UiLocale;
}): Promise<unknown> {
  return callAnthropicJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveAskSystemPrompt(params.locale),
    responseSchema: askResultJsonSchema,
    timeoutMs: readNumberEnv(
      "AI_ASK_HTTP_TIMEOUT_MS",
      Math.max(
        DEFAULT_AI_ASK_HTTP_TIMEOUT_MS,
        readNumberEnv("AI_HTTP_TIMEOUT_MS", DEFAULT_AI_HTTP_TIMEOUT_MS),
      ),
    ),
    onFallback: (event, metadata) => {
      logAiDebug(event, metadata);
    },
  });
}

async function askWithGemini(params: {
  model: string;
  prompt: string;
  locale: UiLocale;
}): Promise<unknown> {
  return callGeminiJson({
    model: params.model,
    prompt: params.prompt,
    systemPrompt: resolveAskSystemPrompt(params.locale),
    responseSchema: askResultJsonSchema,
    timeoutMs: readNumberEnv(
      "AI_ASK_HTTP_TIMEOUT_MS",
      Math.max(
        DEFAULT_AI_ASK_HTTP_TIMEOUT_MS,
        readNumberEnv("AI_HTTP_TIMEOUT_MS", DEFAULT_AI_HTTP_TIMEOUT_MS),
      ),
    ),
    onFallback: (event, metadata) => {
      logAiDebug(event, metadata);
    },
  });
}

export interface AiProviderProbeResult {
  ok: boolean;
  provider: AIProvider;
  model: string;
  status: number;
  latencyMs: number;
  error?: string;
}

export async function probeAiProviderConnectivity(params?: {
  timeoutMs?: number;
  runtime?: AiReviewerRuntime;
}): Promise<AiProviderProbeResult> {
  const runtime = params?.runtime ?? defaultAiReviewerRuntime;
  const provider = resolveProvider();
  const model = resolveModel(provider);
  const startedAt = nowMs(runtime.clock);
  const timeoutMs = Math.max(
    500,
    params?.timeoutMs ?? readNumberEnv("HEALTHCHECK_AI_TIMEOUT_MS", 5_000),
  );
  const liveProbe = shouldUseLiveAiHealthProbe();

  try {
    const status = liveProbe
      ? await probeProviderRequest(provider, model, timeoutMs)
      : probeProviderConfig(provider);
    return {
      ok: status >= 200 && status < 300,
      provider,
      model,
      status,
      latencyMs: nowMs(runtime.clock) - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      provider,
      model,
      status: 0,
      latencyMs: nowMs(runtime.clock) - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function shouldUseLiveAiHealthProbe(
  rawValue: string | undefined = readOptionalStringEnv("HEALTHCHECK_AI_LIVE_PROBE"),
): boolean {
  return parseBooleanEnv(rawValue);
}

function probeProviderConfig(provider: AIProvider): number {
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = resolveOpenAIApiKey(provider);
    if (!apiKey) {
      throw new Error(
        provider === "openai-compatible"
          ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
          : "Missing OPENAI_API_KEY",
      );
    }
    if (
      provider === "openai-compatible" &&
      !readOptionalStringEnv("OPENAI_BASE_URL")
    ) {
      throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
    }
    return 204;
  }

  if (provider === "anthropic") {
    if (!readOptionalStringEnv("ANTHROPIC_API_KEY")) {
      throw new Error("Missing ANTHROPIC_API_KEY");
    }
    return 204;
  }

  if (!readOptionalStringEnv("GEMINI_API_KEY")) {
    throw new Error("Missing GEMINI_API_KEY");
  }
  return 204;
}

async function probeProviderRequest(
  provider: AIProvider,
  model: string,
  timeoutMs: number,
): Promise<number> {
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = resolveOpenAIApiKey(provider);
    if (!apiKey) {
      throw new Error(
        provider === "openai-compatible"
          ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
          : "Missing OPENAI_API_KEY",
      );
    }
    const baseUrl =
      provider === "openai-compatible"
        ? (readOptionalStringEnv("OPENAI_BASE_URL") ?? "")
        : "https://api.openai.com/v1";
    if (!baseUrl) {
      throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
    }
    const response = await fetchWithRetry(
      `${baseUrl.replace(/\/$/, "")}/models`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      },
      {
        timeoutMs,
        retries: 0,
        backoffMs: 0,
      },
    );
    return response.status;
  }

  if (provider === "anthropic") {
    const apiKey = readOptionalStringEnv("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY");
    }
    const response = await fetchWithRetry(
      "https://api.anthropic.com/v1/models",
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      {
        timeoutMs,
        retries: 0,
        backoffMs: 0,
      },
    );
    return response.status;
  }

  const apiKey = readOptionalStringEnv("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }
  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
    {
      method: "GET",
      headers: {
        "x-goog-api-key": apiKey,
      },
    },
    {
      timeoutMs,
      retries: 0,
      backoffMs: 0,
    },
  );
  return response.status;
}

export function shouldRetryAskWithCompactContext(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const text = collectErrorText(error).toLowerCase();
  if (!text) {
    return false;
  }

  return (
    text.includes("request timed out") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("etimedout") ||
    text.includes("deadline exceeded")
  );
}
