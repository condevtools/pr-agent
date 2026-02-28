import {
  parseBooleanEnv,
  readNumberEnv,
  pingRuntimeStateBackend,
  getRateLimitRecordCount,
} from "@mr-agent/core";
import { probeAiProviderConnectivity, type AiProviderProbeResult } from "@mr-agent/review";
import { incrementMetricCounter } from "./metrics-runtime.js";

export interface WebhookHealthCheck {
  name: string;
  configured: boolean;
}

interface DbProbeResult {
  ok: boolean;
  latencyMs?: number;
}

interface MemoryInfo {
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
}

export interface HealthStatus {
  ok: boolean;
  degraded?: boolean;
  name: string;
  version?: string;
  uptimeSeconds?: number;
  mode: string;
  checks?: {
    ai: AiProviderProbeResult;
    runtimeState?: { ok: boolean };
    webhook?: WebhookHealthCheck;
    db?: DbProbeResult;
    memory?: MemoryInfo;
    rateLimitKeys?: number;
  };
}

export function isDeepHealthQuery(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "deep" || parseBooleanEnv(normalized);
}

async function probeDatabase(): Promise<DbProbeResult> {
  if (!process.env.DATABASE_URL) {
    return { ok: true }; // DB not expected
  }
  try {
    const { getDefaultDb } = await import("@mr-agent/db");
    const db = getDefaultDb();
    if (!db) return { ok: false };
    const start = Date.now();
    await db.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  }
}

function getMemoryInfo(): MemoryInfo {
  const mem = process.memoryUsage();
  const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;
  return {
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    rssMb: toMb(mem.rss),
  };
}

let cachedVersion: string | undefined;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

export async function buildHealthStatus(params: {
  mode: string;
  deep: boolean;
  webhook?: WebhookHealthCheck;
}): Promise<HealthStatus> {
  incrementMetricCounter("mr_agent_health_checks_total", {
    mode: params.mode.trim().toLowerCase() || "unknown",
    deep: params.deep ? "1" : "0",
  });

  const base: HealthStatus = {
    ok: true,
    name: "mr-agent",
    version: getVersion(),
    uptimeSeconds: Math.floor(process.uptime()),
    mode: params.mode,
  };

  if (!params.deep) {
    return base;
  }

  const [ai, runtimeStateOk, dbProbe] = await Promise.all([
    probeAiProviderConnectivity({
      timeoutMs: readNumberEnv("HEALTHCHECK_AI_TIMEOUT_MS", 5_000),
    }),
    pingRuntimeStateBackend(),
    probeDatabase(),
  ]);

  const checks: HealthStatus["checks"] = {
    ai,
    runtimeState: { ok: runtimeStateOk },
    db: dbProbe,
    memory: getMemoryInfo(),
    rateLimitKeys: getRateLimitRecordCount(),
  };
  if (params.webhook) {
    checks.webhook = params.webhook;
  }

  const webhookOk = params.webhook ? params.webhook.configured : true;
  const dbExpected = Boolean(process.env.DATABASE_URL);

  // "degraded" = partial subsystem failure that doesn't block core functionality
  // e.g. webhook unconfigured or DB expected but down
  const degraded =
    (!webhookOk && ai.ok) || (dbExpected && !dbProbe.ok && ai.ok);

  return {
    ...base,
    ok: ai.ok && runtimeStateOk && (!dbExpected || dbProbe.ok) && webhookOk,
    degraded: degraded || undefined,
    checks,
  };
}
