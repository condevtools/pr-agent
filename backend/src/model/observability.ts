import type { ModelProvider, NormalizedModelUsage } from "./execution-context.js";

/** Langfuse buckets must not double-count provider totals and their cached/thought subsets. */
export function modelObservationUsage(
  provider: ModelProvider,
  usage: NormalizedModelUsage,
): Record<string, number> | undefined {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const thought = usage.reasoningOrThoughtTokens ?? 0;
  const tool = usage.toolInputTokens ?? 0;
  if (input === undefined || output === undefined ||
    [input, output, cached, cacheWrite, thought, tool].some((n) => !Number.isSafeInteger(n) || n < 0)) {
    return undefined;
  }
  if (provider === "anthropic") {
    return { input, input_cached: cached, input_cache_write: cacheWrite, output };
  }
  if (cached > input) return undefined;
  if (provider === "gemini") {
    return { input: input - cached, input_cached: cached, input_tool: tool,
      output, output_reasoning: thought };
  }
  // An inconsistent subset is not an extra token charge. Preserve the provider's total.
  return thought <= output
    ? { input: input - cached, input_cached: cached, output: output - thought, output_reasoning: thought }
    : { input: input - cached, input_cached: cached, output };
}
