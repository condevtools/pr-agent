import { redactKnownSecretValues } from "./secret-scan.js";

const SECRET_VALUE = /(["']?(?:token|password|passwd|secret|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s,'"}]+)/gi;
const TOKEN_VALUE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function isSensitivePath(path: string): boolean {
  return path.split("/").some((segment) => /^(?:\.git|\.env(?:\..*)?|\.envrc|.*\.tfvars(?:\.json)?|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(segment));
}

export function assertSafePath(raw: string): string {
  if (!raw || raw.length > 512 || raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) {
    throw new Error("repository path is invalid");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("repository path traversal is not allowed");
  }
  if (isSensitivePath(raw)) throw new Error("sensitive repository path is not readable");
  return raw;
}

export function redactRepositoryText(text: string): string {
  return redactKnownSecretValues(text.replace(PRIVATE_KEY, (value) =>
    "[REDACTED]" + "\n".repeat((value.match(/\n/g) ?? []).length)))
    .replace(TOKEN_VALUE, "[REDACTED]")
    .replace(SECRET_VALUE, "$1[REDACTED]");
}
