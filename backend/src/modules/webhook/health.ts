import { parseBooleanEnv, readNumberEnv } from "#core";
import { probeAiProviderConnectivity, type AiProviderProbeResult } from "#review";
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
    ai: AiProviderProbeResult;
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

  const ai = await probeAiProviderConnectivity({
    timeoutMs: readNumberEnv("HEALTHCHECK_AI_TIMEOUT_MS", 5_000),
  });

  const checks: HealthStatus["checks"] = {
    ai,
  };
  if (params.webhook) {
    checks.webhook = params.webhook;
  }

  const webhookOk = params.webhook ? params.webhook.configured : true;
  return {
    ...base,
    ok: ai.ok && webhookOk,
    checks,
  };
}
