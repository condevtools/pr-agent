import { isIP } from "node:net";
import { fingerprint } from "../agent-runtime/versions.js";

/** Public destination identity is shared with Web; only Worker receives the secret. */
export interface QualityConfiguration {
  enabled: boolean;
  targetFingerprint: string;
  baseUrl: string;
  publicKey: string;
  secretKey?: string;
}

export function resolveQualityConfiguration(env: NodeJS.ProcessEnv = process.env): QualityConfiguration {
  const mode = env.LANGFUSE_QUALITY_ENABLED?.trim().toLowerCase() || "auto";
  if (!["auto", "on", "off"].includes(mode)) throw new Error("LANGFUSE_QUALITY_ENABLED must be auto, on, or off");
  const baseUrl = env.LANGFUSE_BASE_URL?.trim().replace(/\/+$/u, "") || "";
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() || "";
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim() || undefined;
  const tracingMode = env.LANGFUSE_ENABLED?.trim().toLowerCase() || "auto";
  if (!["auto", "on", "off"].includes(tracingMode)) throw new Error("LANGFUSE_ENABLED must be auto, on, or off");
  if (mode === "on" && tracingMode === "off") {
    throw new Error("LANGFUSE_QUALITY_ENABLED=on requires Langfuse tracing for experiment and score links");
  }
  const complete = Boolean(publicKey && allowedUrl(baseUrl, env));
  if (mode === "on" && !complete) throw new Error("Langfuse quality requires a valid base URL, public key, and permitted transport");
  return { enabled: mode !== "off" && tracingMode !== "off" && complete,
    targetFingerprint: fingerprint({ baseUrl, publicKey }), baseUrl, publicKey, secretKey };
}

function allowedUrl(value: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    if (env.LANGFUSE_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true") return true;
    const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (isIP(host) === 4) return /^127\.|^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./u.test(host);
    if (isIP(host) === 6) return host === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/u.test(host);
    return host === "host.docker.internal" || /^[a-z0-9][a-z0-9-]*$/u.test(host);
  } catch { return false; }
}
