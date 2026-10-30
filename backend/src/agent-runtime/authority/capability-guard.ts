import type { PoolClient } from "pg";

import { RunControlError } from "../runs/control-contracts.js";
import { runtimeAllowsCapability, type ProductCapability } from "../runtime/capabilities.js";

export async function lockCurrentBindingCapability(
  client: PoolClient,
  input: {
    tenantId: string;
    integrationId: string;
    capability: ProductCapability;
    expectedAuthorityVersion?: number;
  },
): Promise<{ authorityVersion: number }> {
  if (!runtimeAllowsCapability(input.capability)) {
    throw new RunControlError("CAPABILITY_DISABLED", 409,
      `Capability is disabled by runtime configuration: ${input.capability}`);
  }
  const selected = await client.query<{
    authority_version: string;
    capability_enabled: boolean;
  }>(
    `SELECT authority_version,capability_enabled
     FROM pr_agent_harness.lock_current_binding_capability($1::uuid,$2::uuid,$3::text)`,
    [input.tenantId, input.integrationId, input.capability],
  );
  const binding = selected.rows[0];
  if (!binding) {
    throw new RunControlError("BINDING_UNAVAILABLE", 409,
      "Active integration binding is unavailable");
  }
  const authorityVersion = Number(binding.authority_version);
  if (input.expectedAuthorityVersion !== undefined
      && authorityVersion !== input.expectedAuthorityVersion) {
    throw new RunControlError("BINDING_CAPABILITY_CHANGED", 409,
      "Integration capabilities changed while the operation was being admitted");
  }
  if (!binding.capability_enabled) {
    throw new RunControlError("CAPABILITY_DISABLED", 409,
      `Capability is disabled for this integration: ${input.capability}`);
  }
  return { authorityVersion };
}
