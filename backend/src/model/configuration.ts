import type { ModelProvider } from "./execution-context.js";

export interface ModelConfiguration {
  provider: ModelProvider;
  model: string;
}

export function resolveModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const raw = (env.AI_PROVIDER?.trim() || "openai").toLowerCase();
  if (raw === "openai") return "openai";
  if (raw === "openai-compatible" || raw === "openai_compatible" || raw === "compatible") {
    return "openai-compatible";
  }
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "gemini" || raw === "google") return "gemini";
  throw new Error(`Unsupported AI_PROVIDER: ${raw}`);
}

export function resolveModelName(provider: ModelProvider, env: NodeJS.ProcessEnv = process.env): string {
  const genericModel = env.AI_MODEL?.trim();
  if (genericModel) return genericModel;
  if (provider === "openai") return env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
  if (provider === "openai-compatible") {
    return env.OPENAI_COMPATIBLE_MODEL?.trim() || "gpt-4o-mini";
  }
  if (provider === "anthropic") {
    return env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest";
  }
  return env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
}

export function resolveModelConfiguration(env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const provider = resolveModelProvider(env);
  return { provider, model: resolveModelName(provider, env) };
}

export function resolveOpenAIApiKey(
  provider: "openai" | "openai-compatible",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return provider === "openai-compatible"
    ? env.OPENAI_COMPATIBLE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()
    : env.OPENAI_API_KEY?.trim();
}
