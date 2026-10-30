import type { PoolConfig } from "pg";

export type AgentProcessRole = "web" | "worker" | "recovery" | "all";

/** Explicit harness configuration only; never fall back to an unrelated DATABASE_URL. */
export function agentRuntimePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = env.HARNESS_DATABASE_URL?.trim();
  const common = { max: 8, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
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
