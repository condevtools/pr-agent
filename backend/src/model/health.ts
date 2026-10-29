import {
  fetchWithRetry,
  nowMs,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
} from "#core";
import {
  resolveModelConfiguration,
  resolveOpenAIApiKey,
} from "./configuration.js";
import type { ModelProvider } from "./execution-context.js";
import { getSharedModelRuntime, type ModelRuntime } from "./runtime.js";

export interface ModelProviderProbeResult {
  ok: boolean;
  provider: ModelProvider;
  model: string;
  status: number;
  latencyMs: number;
  error?: string;
}

export async function probeModelProviderConnectivity(params?: {
  timeoutMs?: number;
  runtime?: ModelRuntime;
}): Promise<ModelProviderProbeResult> {
  const runtime = params?.runtime ?? getSharedModelRuntime();
  const { provider, model } = resolveModelConfiguration();
  const startedAt = nowMs(runtime.clock);
  const timeoutMs = Math.max(
    500,
    params?.timeoutMs ?? readNumberEnv("HEALTHCHECK_AI_TIMEOUT_MS", 5_000),
  );
  try {
    const status = shouldUseLiveModelHealthProbe()
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

function shouldUseLiveModelHealthProbe(
  rawValue: string | undefined = readOptionalStringEnv("HEALTHCHECK_AI_LIVE_PROBE"),
): boolean {
  return parseBooleanEnv(rawValue);
}

function probeProviderConfig(provider: ModelProvider): number {
  if (provider === "openai" || provider === "openai-compatible") {
    if (!resolveOpenAIApiKey(provider)) {
      throw new Error(provider === "openai-compatible"
        ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
        : "Missing OPENAI_API_KEY");
    }
    if (provider === "openai-compatible" && !readOptionalStringEnv("OPENAI_BASE_URL")) {
      throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
    }
    return 204;
  }
  if (provider === "anthropic") {
    if (!readOptionalStringEnv("ANTHROPIC_API_KEY")) throw new Error("Missing ANTHROPIC_API_KEY");
    return 204;
  }
  if (!readOptionalStringEnv("GEMINI_API_KEY")) throw new Error("Missing GEMINI_API_KEY");
  return 204;
}

async function probeProviderRequest(
  provider: ModelProvider,
  model: string,
  timeoutMs: number,
): Promise<number> {
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = resolveOpenAIApiKey(provider);
    if (!apiKey) {
      throw new Error(provider === "openai-compatible"
        ? "Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)"
        : "Missing OPENAI_API_KEY");
    }
    const baseUrl = provider === "openai-compatible"
      ? readOptionalStringEnv("OPENAI_BASE_URL") ?? ""
      : "https://api.openai.com/v1";
    if (!baseUrl) throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
    const response = await fetchWithRetry(
      `${baseUrl.replace(/\/$/, "")}/models`,
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      { timeoutMs, retries: 0, backoffMs: 0 },
    );
    return response.status;
  }
  if (provider === "anthropic") {
    const apiKey = readOptionalStringEnv("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
    const response = await fetchWithRetry(
      "https://api.anthropic.com/v1/models",
      { method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
      { timeoutMs, retries: 0, backoffMs: 0 },
    );
    return response.status;
  }
  const apiKey = readOptionalStringEnv("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
    { method: "GET", headers: { "x-goog-api-key": apiKey } },
    { timeoutMs, retries: 0, backoffMs: 0 },
  );
  return response.status;
}
