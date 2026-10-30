import { z } from "zod";

import type {
  PullRequestReviewInput,
  PullRequestReviewResult,
} from "../contracts.js";
import {
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
  resolveUiLocale,
} from "#core";
import { buildUserPrompt, resolveReviewSystemPrompt } from "./prompts.js";
import {
  buildReviewFallbackFromNonJsonText,
  normalizeReviewResultForSchema,
} from "./normalization.js";
import { requestJsonModel } from "../../model/gateway.js";
import { getSharedModelRuntime, type ModelRuntime } from "../../model/runtime.js";
import { resolveModelName, resolveModelProvider } from "../../model/configuration.js";
export { buildUserPrompt, resolveReviewSystemPrompt } from "./prompts.js";
export { normalizeReviewResultForSchema } from "./normalization.js";
const DEFAULT_AI_HTTP_TIMEOUT_MS = 30_000;

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
    return requestJsonModel({
      configuration: { provider, model },
      requestKind: "single-review",
      schemaName: "pr_review",
      schema: reviewResultJsonSchema,
      prompt,
      systemPrompt: resolveReviewSystemPrompt(),
      timeoutMs: readNumberEnv("AI_HTTP_TIMEOUT_MS", DEFAULT_AI_HTTP_TIMEOUT_MS),
      fallbackPolicy: "permissive-json",
      nonJsonFallback: buildReviewFallbackFromNonJsonText,
      jsonOnlyHint: resolveUiLocale() === "en" ? "Return JSON only." : "请直接返回 JSON。",
      runtime,
      onFallback: logAiDebug,
    });
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
