import type { RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { RunControlError } from "../../agent-runtime/runs/control-contracts.js";
import { bindingAllowsCapability } from "../../agent-runtime/runtime/capabilities.js";
import type { RunApiContextService } from "../common/run-api-context.service.js";

export async function requireEvolutionCapability(
  context: RunApiContextService,
  principal: RunPrincipal,
): Promise<void> {
  if (!bindingAllowsCapability(await context.binding(principal), "evolution")) {
    throw new RunControlError("CAPABILITY_DISABLED", 409, "Evolution is not enabled for this integration");
  }
}
