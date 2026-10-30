import type { PoolConfig } from "pg";

export type AgentProcessRole = "web" | "worker" | "recovery" | "all";
export type AgentPoolRole = "web" | "worker" | "recovery";

export interface WorkerSchedulingConfiguration {
  concurrency: number;
  perBindingConcurrency: number;
  specialConcurrency: number;
  recoveryBindingPageSize: number;
}

/** Explicit harness configuration only; never fall back to an unrelated DATABASE_URL. */
export function agentRuntimePoolConfig(
  env: NodeJS.ProcessEnv = process.env,
  role: AgentPoolRole = "web",
): PoolConfig {
  const connectionString = env.HARNESS_DATABASE_URL?.trim();
  const max = strictInteger(env[poolMaxName(role)], poolDefault(role), 1, 64, poolMaxName(role));
  const common = { max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 15_000 };
  if (connectionString) return { ...common, connectionString };
  const host = env.HARNESS_PG_HOST?.trim();
  const database = env.HARNESS_PG_DATABASE?.trim();
  const user = env.HARNESS_PG_USER?.trim();
  const password = env.HARNESS_PG_PASSWORD;
  const port = Number(env.HARNESS_PG_PORT || "5432");
  if (!host || !database || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Configure HARNESS_DATABASE_URL or HARNESS_PG_HOST/DATABASE/USER/PASSWORD/PORT");
  }
  return { ...common, host, database, user, password, port };
}

export function resolveWorkerSchedulingConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): WorkerSchedulingConfiguration {
  const concurrency = strictInteger(env.HARNESS_WORKER_CONCURRENCY, 4, 2, 16,
    "HARNESS_WORKER_CONCURRENCY");
  const perBindingConcurrency = strictInteger(env.HARNESS_WORKER_PER_BINDING_CONCURRENCY, 2, 1, 16,
    "HARNESS_WORKER_PER_BINDING_CONCURRENCY");
  const specialConcurrency = strictInteger(env.HARNESS_WORKER_SPECIAL_CONCURRENCY, 1, 1, concurrency - 1,
    "HARNESS_WORKER_SPECIAL_CONCURRENCY");
  const recoveryBindingPageSize = strictInteger(env.HARNESS_RECOVERY_BINDING_PAGE_SIZE, 32, 1, 64,
    "HARNESS_RECOVERY_BINDING_PAGE_SIZE");
  return { concurrency, perBindingConcurrency, specialConcurrency, recoveryBindingPageSize };
}

export function resolveAgentProcessRole(env: NodeJS.ProcessEnv = process.env): AgentProcessRole {
  const value = env.PR_AGENT_PROCESS_ROLE?.trim().toLowerCase() || "all";
  if (value !== "web" && value !== "worker" && value !== "recovery" && value !== "all") {
    throw new Error("PR_AGENT_PROCESS_ROLE must be web, worker, recovery, or all");
  }
  return value;
}

export function roleStartsWeb(role: AgentProcessRole): boolean { return role === "web" || role === "all"; }
export function roleStartsWorker(role: AgentProcessRole): boolean { return role === "worker" || role === "all"; }
export function roleStartsRecovery(role: AgentProcessRole): boolean { return role === "recovery" || role === "all"; }

function poolMaxName(role: AgentPoolRole): string {
  return `HARNESS_${role.toUpperCase()}_POOL_MAX`;
}

function poolDefault(role: AgentPoolRole): number { return role === "recovery" ? 4 : 8; }

function strictInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
