import { z } from "zod";

import type {
  PullRequestReviewInput,
  PullRequestReviewResult,
} from "../contracts.js";
import type { AskConversationTurn, UiLocale } from "#core";
import {
  detectTextLocale,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
  resolveUiLocale,
} from "#core";
import {
  buildAskPrompt,
  buildAskPromptWithOptions,
  buildUserPrompt,
  resolveAskSystemPrompt,
  resolveReviewSystemPrompt,
} from "./prompts.js";
import {
  buildReviewFallbackFromNonJsonText,
  normalizeAskResultForSchema,
  normalizeReviewResultForSchema,
} from "./normalization.js";
import {
  callAnthropicJson,
} from "../../model/providers/anthropic.js";
import {
  callGeminiJson,
} from "../../model/providers/gemini.js";
import {
  callOpenAIJsonWithFallback,
  collectModelErrorText,
  getSharedModelRuntime,
  readModelErrorStatus,
  type ModelRuntime,
} from "../../model/runtime.js";
import { resolveModelName, resolveModelProvider } from "../../model/configuration.js";
export {
  buildAskPrompt,
  buildAskPromptWithOptions,
  buildUserPrompt,
  resolveAskSystemPrompt,
  resolveReviewSystemPrompt,
} from "./prompts.js";
export {
  normalizeAskResultForSchema,
  normalizeReviewResultForSchema,
} from "./normalization.js";
const DEFAULT_AI_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_AI_ASK_HTTP_TIMEOUT_MS = 60_000;

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
    runtime?: ModelRuntime;
  },
): Promise<PullRequestReviewResult> {
  const runtime = options?.runtime ?? getSharedModelRuntime();
  const provider = resolveModelProvider();
  const model = resolveModelName(provider);
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
    runtime?: ModelRuntime;
  },
): Promise<string> {
  const runtime = options?.runtime ?? getSharedModelRuntime();
  const provider = resolveModelProvider();
  const model = resolveModelName(provider);
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

async function analyzeWithOpenAI(params: {
  provider: "openai" | "openai-compatible";
  model: string;
  prompt: string;
  runtime: ModelRuntime;
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
    jsonOnlyHint: resolveUiLocale() === "en" ? "Return JSON only." : "请直接返回 JSON。",
    runtime: params.runtime,
    onFallback: logAiDebug,
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
  runtime: ModelRuntime;
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
    jsonOnlyHint: resolveUiLocale() === "en" ? "Return JSON only." : "请直接返回 JSON。",
    runtime: params.runtime,
    onFallback: logAiDebug,
  });
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

export function shouldRetryAskWithCompactContext(error: unknown): boolean {
  const status = readModelErrorStatus(error);
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const text = collectModelErrorText(error).toLowerCase();
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
