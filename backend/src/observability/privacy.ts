import { redactRepositoryText } from "../repository/content-safety/repository-content.js";

const DEFAULT_MAX_BYTES = 16 * 1024;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;
const SENSITIVE_KEYS = new Set([
  "access_token", "api_key", "auth_token", "authorization", "client_secret", "cookie",
  "credential", "credentials", "password", "passwd", "private_key", "refresh_token",
  "secret", "secret_key", "session_cookie", "token",
]);
const BASIC_AUTH_URL = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu;

export function sanitizeObservationValue(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  maximumBytes = DEFAULT_MAX_BYTES,
): unknown {
  const secrets = knownSecretValues(env);
  const seen = new WeakSet<object>();
  const sanitized = sanitize(value, "", 0, seen, secrets);
  const serialized = safeJson(sanitized);
  if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return sanitized;
  // Count JSON escaping and the wrapper itself, not only the unescaped preview.
  const text = redact(serialized, secrets);
  let low = 0;
  let high = Math.min(text.length, maximumBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const preview = { truncated: true, preview: `${text.slice(0, middle)}...` };
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return { truncated: true, preview: `${text.slice(0, low)}...` };
}

export function sanitizeObservationMaskValue(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value !== "string") return sanitizeObservationValue(value, env);
  try {
    return JSON.stringify(sanitizeObservationValue(JSON.parse(value), env));
  } catch {
    const sanitized = sanitizeObservationValue(value, env);
    return typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  }
}

function sanitize(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
  secrets: readonly string[],
): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return boundUtf8(redact(value, secrets), DEFAULT_MAX_BYTES);
  if (value instanceof Error) return { errorType: safeErrorName(value.name) };
  if (typeof value !== "object") return boundUtf8(String(value), 512);
  if (seen.has(value)) return "[CIRCULAR]";
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitize(item, "", depth + 1, seen, secrets));
      if (value.length > items.length) items.push(`[TRUNCATED_${value.length - items.length}_ITEMS]`);
      return items;
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)
      .map(([entryKey, entryValue]) => [
        boundUtf8(entryKey, 160),
        sanitize(entryValue, entryKey, depth + 1, seen, secrets),
      ] as const);
    if (Object.keys(value).length > entries.length) entries.push(["truncated", true]);
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

function knownSecretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => typeof value === "string" && value.length >= 6 &&
      (isSensitiveEnvironmentKey(key) || isCredentialUrl(key, value)))
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length)
    .slice(0, 100);
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return [...SENSITIVE_KEYS].some((candidate) =>
    normalized === candidate || normalized.endsWith(`_${candidate}`));
}

function isSensitiveEnvironmentKey(key: string): boolean {
  return isSensitiveKey(key);
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
}

function isCredentialUrl(key: string, value: string): boolean {
  if (!normalizeKey(key).endsWith("_url")) return false;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch { return false; }
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = redactRepositoryText(value)
    .replace(BASIC_AUTH_URL, "$1[REDACTED]@")
    .replace(BEARER_TOKEN, "$1[REDACTED]");
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; } catch { return "[UNSERIALIZABLE]"; }
}

function safeErrorName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(name) ? name : "Error";
}

function boundUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes - 3) end -= 1;
  return `${value.slice(0, end)}...`;
}
