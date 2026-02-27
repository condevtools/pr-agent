import { parseBooleanEnv, readOptionalStringEnv } from "./env.js";

type CoreLogLevel = "debug" | "warn" | "error";

export function logCore(
  level: CoreLogLevel,
  event: string,
  metadata?: Record<string, unknown>,
): void {
  if (!shouldLogCoreEvents()) {
    return;
  }

  const payload = metadata ? ` ${JSON.stringify(metadata)}` : "";
  const message = `[mr-agent][core] ${event}${payload}`;
  if (level === "warn") {
    console.warn(message);
    return;
  }
  if (level === "error") {
    console.error(message);
    return;
  }
  console.info(message);
}

function shouldLogCoreEvents(
  rawValue: string | undefined = readOptionalStringEnv("MR_AGENT_CORE_LOGS"),
): boolean {
  return parseBooleanEnv(rawValue);
}
