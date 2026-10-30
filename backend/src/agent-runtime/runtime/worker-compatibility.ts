import type { ModelProvider } from "../../model/execution-context.js";
import { getModelExecutionPolicy } from "../budget/model-budget-store.js";
import { runtimeVersionManifest } from "../versions.js";
import { supportedWorkflowIds, type RuntimeCapabilityConfiguration } from "./capabilities.js";

export interface WorkerCompatibility {
  runtimeVersionHash: string;
  supportedWorkflowIds: string[];
}

/** Validates the frozen local model/runtime contract without contacting a provider. */
export async function resolveWorkerCompatibility(
  capabilities: RuntimeCapabilityConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerCompatibility> {
  const provider = modelProvider(env.AI_PROVIDER);
  const model = modelName(provider, env);
  assertProviderConfiguration(provider, env);
  const policy = getModelExecutionPolicy(provider, model, env);
  const manifest = await runtimeVersionManifest(policy);
  return { runtimeVersionHash: manifest.runtimeVersionHash,
    supportedWorkflowIds: supportedWorkflowIds(capabilities) };
}

function modelProvider(raw: string | undefined): ModelProvider {
  const value = raw?.trim().toLowerCase() || "openai";
  if (value === "openai") return "openai";
  if (value === "openai-compatible" || value === "openai_compatible" || value === "compatible") {
    return "openai-compatible";
  }
  if (value === "anthropic" || value === "claude") return "anthropic";
  if (value === "gemini" || value === "google") return "gemini";
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}

function modelName(provider: ModelProvider, env: NodeJS.ProcessEnv): string {
  const value = env.AI_MODEL?.trim()
    || (provider === "openai" ? env.OPENAI_MODEL?.trim() || "gpt-4.1-mini"
      : provider === "openai-compatible" ? env.OPENAI_COMPATIBLE_MODEL?.trim() || "gpt-4o-mini"
        : provider === "anthropic" ? env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest"
          : env.GEMINI_MODEL?.trim() || "gemini-2.0-flash");
  if (!value) throw new Error("Selected AI model must be non-empty");
  return value;
}

function assertProviderConfiguration(provider: ModelProvider, env: NodeJS.ProcessEnv): void {
  if (provider === "openai" && !env.OPENAI_API_KEY?.trim()) throw new Error("Missing OPENAI_API_KEY");
  if (provider === "openai-compatible") {
    if (!(env.OPENAI_COMPATIBLE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim())) {
      throw new Error("Missing OPENAI_COMPATIBLE_API_KEY (or OPENAI_API_KEY)");
    }
    const raw = env.OPENAI_BASE_URL?.trim();
    if (!raw) throw new Error("Missing OPENAI_BASE_URL for AI_PROVIDER=openai-compatible");
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("OPENAI_BASE_URL must be an HTTP(S) URL without credentials");
    }
  }
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY?.trim()) throw new Error("Missing ANTHROPIC_API_KEY");
  if (provider === "gemini" && !env.GEMINI_API_KEY?.trim()) throw new Error("Missing GEMINI_API_KEY");
}
