import { localProcessIsHealthy, type LocalProcessRole } from "./runtime/process-health.js";
import { validateRuntimeEnvironment } from "#core";

/** Container liveness only; `cli ready` checks shared deployment dependencies. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--role")) throw new Error("Invalid health arguments");
  const role = args[1] ?? (process.env.PR_AGENT_PROCESS_ROLE?.trim() || "all");
  if (!["web", "worker", "recovery", "all", "verifier", "maintenance"].includes(role)) {
    throw new Error("Invalid health role");
  }
  const configuration = validateRuntimeEnvironment(process.env, "health", { healthRole: role });
  if (role === "web" || role === "all") {
    const port = configuration.http!.port;
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("HTTP liveness failed");
  }
  const roles: LocalProcessRole[] = role === "all" ? ["worker", "recovery"]
    : role === "web" ? [] : [role as LocalProcessRole];
  const directory = process.env.PR_AGENT_HEALTH_DIRECTORY?.trim();
  if (roles.length && !directory) throw new Error("Process health directory is missing");
  for (const localRole of roles) {
    if (!await localProcessIsHealthy({ role: localRole, directory: directory!,
      staleAfterMs: configuration.heartbeat.staleAfterMs })) {
      throw new Error("Local process heartbeat is unavailable");
    }
  }
}

void main().catch(() => {
  console.error('{"code":"LOCAL_PROCESS_UNHEALTHY"}');
  process.exitCode = 1;
});
