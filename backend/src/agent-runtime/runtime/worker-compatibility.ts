import { resolveModelConfiguration } from "../../model/configuration.js";
import { validateRuntimeEnvironment } from "#core";
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
  options: { requireProviderCredentials?: boolean } = {},
): Promise<WorkerCompatibility> {
  validateRuntimeEnvironment(env, "worker", { requireDatabase: false,
    requireProviderCredentials: options.requireProviderCredentials });
  const policy = resolveFrozenModelExecutionPolicy(env);
  const manifest = await runtimeVersionManifest(policy);
  return { runtimeVersionHash: manifest.runtimeVersionHash,
    supportedWorkflowIds: supportedWorkflowIds(capabilities) };
}

/** Parses the selected model's trusted pricing envelope without contacting the provider. */
export function resolveFrozenModelExecutionPolicy(env: NodeJS.ProcessEnv = process.env) {
  const { provider, model } = resolveModelConfiguration(env);
  return getModelExecutionPolicy(provider, model, env);
}
