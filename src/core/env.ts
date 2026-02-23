export function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

export function readStringEnv(
  name: string,
  fallback = "",
): string {
  const value = readOptionalStringEnv(name);
  if (typeof value === "undefined") {
    return fallback;
  }
  return value;
}

export function readOptionalStringEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

const DEFAULT_TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function parseBooleanEnv(
  rawValue: string | undefined,
  truthyValues: ReadonlySet<string> = DEFAULT_TRUTHY_ENV_VALUES,
): boolean {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  return truthyValues.has(normalized);
}
