import { parseBooleanEnv } from "#core";
import { incrementMetricCounter } from "./metrics-runtime.js";

export interface WebhookHealthCheck {
  name: string;
  configured: boolean;
}

export interface HealthStatus {
  ok: boolean;
  name: string;
  mode: string;
  checks?: {
    webhook?: WebhookHealthCheck;
  };
}

export function isDeepHealthQuery(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "deep" || parseBooleanEnv(normalized);
}

export async function buildHealthStatus(params: {
  mode: string;
  deep: boolean;
  webhook?: WebhookHealthCheck;
}): Promise<HealthStatus> {
  incrementMetricCounter("pr_agent_health_checks_total", {
    mode: params.mode.trim().toLowerCase() || "unknown",
    deep: params.deep ? "1" : "0",
  });

  const base: HealthStatus = {
    ok: true,
    name: "pr-agent",
    mode: params.mode,
  };

  if (!params.deep) {
    return base;
  }

  // Public diagnostics inspect local webhook configuration only. Shared runtime
  // dependencies are checked by /ready; model credentials belong to Worker.
  return {
    ...base,
    ok: params.webhook?.configured ?? true,
    checks: params.webhook ? { webhook: params.webhook } : {},
  };
}
