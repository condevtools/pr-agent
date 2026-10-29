import { z } from "zod";
import type { ModelBudgetLimits } from "../../agent-runtime/budget/model-budget-store.js";

const limits = z.object({ inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(), costMicros: z.number().int().nonnegative() }).strict();
export const deepBudgetSchema = z.object({ version: z.literal(1),
  security: limits, correctness: limits, critic: limits }).strict();

/** Keep critic capacity available even when both parallel workers consume their full share. */
export function freezeDeepBudget(total: ModelBudgetLimits): z.infer<typeof deepBudgetSchema> {
  const share = (fraction: number) => Object.fromEntries(Object.entries(total)
    .map(([key, value]) => [key, Math.floor(value * fraction)]));
  return deepBudgetSchema.parse({ version: 1, security: share(0.3), correctness: share(0.3), critic: share(0.4) });
}

export function deepRolePrefix(stepKey: string): "security" | "correctness" | "critic" {
  if (stepKey.startsWith("deep.role.security.")) return "security";
  if (stepKey.startsWith("deep.role.correctness.")) return "correctness";
  if (stepKey === "deep.critic" || stepKey.startsWith("deep.critic.")) return "critic";
  throw new Error("Deep model step is outside the frozen role topology");
}
