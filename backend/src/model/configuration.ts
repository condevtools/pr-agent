import { readOptionalStringEnv, readStringEnv } from "#core";
import type { ModelProvider } from "./execution-context.js";

export interface ModelConfiguration {
  provider: ModelProvider;
  model: string;
}

export function resolveModelProvider(): ModelProvider {
  const raw = readStringEnv("AI_PROVIDER", "openai").toLowerCase();
  if (raw === "openai") return "openai";
  if (raw === "openai-compatible" || raw === "openai_compatible" || raw === "compatible") {
    return "openai-compatible";
  }
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "gemini" || raw === "google") return "gemini";
  throw new Error(`Unsupported AI_PROVIDER: ${raw}`);
}

export function resolveModelName(provider: ModelProvider): string {
  const genericModel = readOptionalStringEnv("AI_MODEL");
  if (genericModel) return genericModel;
  if (provider === "openai") return readStringEnv("OPENAI_MODEL", "gpt-4.1-mini");
  if (provider === "openai-compatible") {
    return readStringEnv("OPENAI_COMPATIBLE_MODEL", "gpt-4o-mini");
  }
  if (provider === "anthropic") {
    return readStringEnv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest");
  }
  return readStringEnv("GEMINI_MODEL", "gemini-2.0-flash");
}

export function resolveModelConfiguration(): ModelConfiguration {
  const provider = resolveModelProvider();
  return { provider, model: resolveModelName(provider) };
}

export function resolveOpenAIApiKey(
  provider: "openai" | "openai-compatible",
): string | undefined {
  return provider === "openai-compatible"
    ? readOptionalStringEnv("OPENAI_COMPATIBLE_API_KEY") ?? readOptionalStringEnv("OPENAI_API_KEY")
    : readOptionalStringEnv("OPENAI_API_KEY");
}
