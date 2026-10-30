import { validateRuntimeEnvironment } from "#core";
import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

import { logCore } from "../core/logging/logger.js";
import { ProcessHeartbeatLoop, ProcessHeartbeatStore } from "./runtime/heartbeat.js";
import { PeriodicMaintenanceLoop } from "./retention/periodic-loop.js";
import { PeriodicMaintenanceStore } from "./retention/periodic-store.js";

export interface MaintenanceOnceOptions {
  action: "preview" | "apply";
  cycleId: string;
}

export async function runMaintenanceProcess(
  env: NodeJS.ProcessEnv = process.env,
  signal = processSignal(),
): Promise<void> {
  const configuration = validateRuntimeEnvironment(env, "maintenance");
  const policy = configuration.maintenance!;
  const pool = new Pool(poolConfiguration(configuration));
  const heartbeat = new ProcessHeartbeatLoop(
    new ProcessHeartbeatStore(pool),
    "maintenance",
    { schemaVersion: 1, mode: policy.mode },
    configuration.heartbeat,
    (error) => logCore("error", "maintenance heartbeat failed", { error }),
  );
  const loop = new PeriodicMaintenanceLoop(
    new PeriodicMaintenanceStore(pool),
    { action: policy.mode, contentDays: policy.contentDays, replayDays: policy.replayDays,
      traceDays: policy.traceDays, batchLimit: policy.batchLimit },
    policy.intervalMs,
    (result) => logCore("debug", "maintenance retention cycle completed", {
      action: result.action, candidates: result.candidates, applied: result.applied,
    }),
  );
  try {
    await heartbeat.start();
    await loop.run(signal);
  } finally {
    await loop.stop().catch((error) => logCore("error", "maintenance cycle shutdown failed", { error }));
    await heartbeat.stop().catch((error) => logCore("error", "maintenance heartbeat shutdown failed", { error }));
    await pool.end();
  }
}

export async function runMaintenanceOnce(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = ["--once"],
) {
  const options = parseMaintenanceOnceArguments(args);
  const configuration = validateRuntimeEnvironment(env, "maintenance");
  const policy = configuration.maintenance!;
  const pool = new Pool(poolConfiguration(configuration));
  try {
    return await new PeriodicMaintenanceStore(pool).run(options.cycleId, {
      action: options.action,
      contentDays: policy.contentDays,
      replayDays: policy.replayDays,
      traceDays: policy.traceDays,
      batchLimit: policy.batchLimit,
    });
  } finally {
    await pool.end();
  }
}

export function parseMaintenanceOnceArguments(args: string[]): MaintenanceOnceOptions {
  if (args[0] !== "--once") throw new Error("Maintenance one-shot invocation must start with --once");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if ((key !== "--action" && key !== "--cycle-id") || !value || values.has(key)) {
      throw new Error("Usage: maintenance-process --once [--action preview|apply] [--cycle-id <uuid>]");
    }
    values.set(key, value);
  }
  const action = values.get("--action") ?? "preview";
  if (action !== "preview" && action !== "apply") throw new Error("Maintenance action must be preview or apply");
  const cycleId = values.get("--cycle-id") ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cycleId)) {
    throw new Error("Maintenance cycle id must be a UUID");
  }
  return { action, cycleId };
}

function poolConfiguration(
  configuration: ReturnType<typeof validateRuntimeEnvironment>,
): PoolConfig {
  const database = configuration.database!;
  const common = { max: configuration.poolMax!, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000, statement_timeout: 30_000, lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000 };
  if (database.connectionString) return { ...common, connectionString: database.connectionString };
  return { ...common, host: database.host, database: database.database, user: database.user,
    password: database.password, port: database.port };
}

function processSignal(): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return controller.signal;
}

if (process.argv[1]?.endsWith("maintenance-process.js")
    || process.argv[1]?.endsWith("maintenance-process.ts")) {
  const args = process.argv.slice(2);
  const execution = args[0] === "--once"
    ? runMaintenanceOnce(process.env, args).then((result) => console.log(JSON.stringify(result)))
    : args.length === 0 ? runMaintenanceProcess()
      : Promise.reject(new Error("Usage: maintenance-process [--once [--action preview|apply] [--cycle-id <uuid>]]"));
  execution.catch((error) => {
    logCore("error", "maintenance process failed", { error });
    process.exitCode = 1;
  });
}
