import { isAbsolute } from "node:path";
import { z } from "zod";
import { githubAppModeConfigured, githubOnboardingMode,
  githubOnboardingRestrictionsEnabled, resolveGitHubOnboardingOrigin } from "./github-onboarding.js";

export type RuntimeEnvironmentProfile =
  "web" | "worker" | "recovery" | "verifier" | "maintenance" | "admin" | "migrate" | "health";

export interface RuntimeEnvironmentConfiguration {
  profile: RuntimeEnvironmentProfile;
  database?: { connectionString?: string; host?: string; database?: string; user?: string; password?: string; port: number };
  poolMax?: number;
  heartbeat: { intervalMs: number; staleAfterMs: number };
  http?: { port: number; bodyLimit: string };
  maintenance?: { mode: "preview" | "apply"; intervalMs: number; batchLimit: number;
    contentDays: number; replayDays: number; traceDays: number };
}

const profiles = ["web", "worker", "recovery", "verifier", "maintenance", "admin", "migrate", "health"] as const;
const value = z.string().max(1_000_000).optional();
const criticalEnvironmentSchema = z.object({
  HARNESS_DATABASE_URL: value, HARNESS_PG_HOST: value, HARNESS_PG_DATABASE: value,
  HARNESS_PG_USER: value, HARNESS_PG_PASSWORD: value, HARNESS_PG_PORT: value,
  HARNESS_WEB_POOL_MAX: value, HARNESS_WORKER_POOL_MAX: value, HARNESS_RECOVERY_POOL_MAX: value,
  HARNESS_MAINTENANCE_POOL_MAX: value, RUNTIME_HEARTBEAT_INTERVAL_MS: value,
  RUNTIME_HEARTBEAT_STALE_MS: value, PR_AGENT_HEALTH_DIRECTORY: value,
  PORT: value, WEBHOOK_BODY_LIMIT: value, NODE_ENV: value,
  HARNESS_MAINTENANCE_MODE: value, HARNESS_MAINTENANCE_INTERVAL_MS: value,
  HARNESS_MAINTENANCE_BATCH_LIMIT: value, HARNESS_MAINTENANCE_CONTENT_DAYS: value,
  HARNESS_MAINTENANCE_REPLAY_DAYS: value, HARNESS_MAINTENANCE_TRACE_DAYS: value,
  AI_PROVIDER: value, AI_MODEL: value, OPENAI_MODEL: value, OPENAI_COMPATIBLE_MODEL: value,
  ANTHROPIC_MODEL: value, GEMINI_MODEL: value, OPENAI_BASE_URL: value,
  OPENAI_API_KEY: value, OPENAI_COMPATIBLE_API_KEY: value, ANTHROPIC_API_KEY: value,
  GEMINI_API_KEY: value, HARNESS_MODEL_PRICING_JSON: value,
  FEATURE_DEEP_REVIEW: value, FEATURE_ISSUE_TRIAGE: value, FEATURE_FIX: value, FEATURE_EVOLUTION: value,
  FIX_DEFAULT_POLICY_ID: value, FIX_POLICY_REGISTRY_JSON: value,
  APP_ID: value, PRIVATE_KEY: value, PRIVATE_KEY_PATH: value, WEBHOOK_SECRET: value,
  FEATURE_GITHUB_ONBOARDING: value, HARNESS_ONBOARDING_PG_PASSWORD: value,
  GITHUB_WEBHOOK_SECRET: value, GITHUB_WEBHOOK_TOKEN: value, GITHUB_WEBHOOK_SKIP_SIGNATURE: value,
  GITHUB_TOKEN: value, GITHUB_API_URL: value, GITLAB_WEBHOOK_SECRET: value,
  GITLAB_TOKEN: value, GITLAB_BASE_URL: value, HARNESS_API_PRINCIPALS_JSON: value,
  HARNESS_API_PRINCIPALS_FILE: value, EXPOSE_ERROR_STACK: value, PR_AGENT_CORE_LOGS: value,
  HARNESS_WORKER_CONCURRENCY: value, HARNESS_WORKER_PER_BINDING_CONCURRENCY: value,
  HARNESS_WORKER_SPECIAL_CONCURRENCY: value, HARNESS_RECOVERY_BINDING_PAGE_SIZE: value,
  HTTP_TIMEOUT_MS: value, HTTP_RETRIES: value, HTTP_RETRY_BACKOFF_MS: value,
  HTTP_RETRY_MAX_DELAY_MS: value, GITHUB_HTTP_TIMEOUT_MS: value, GITHUB_HTTP_RETRIES: value,
  GITHUB_HTTP_RETRY_BACKOFF_MS: value, GITLAB_HTTP_TIMEOUT_MS: value, GITLAB_HTTP_RETRIES: value,
  GITLAB_HTTP_RETRY_BACKOFF_MS: value, ALLOW_INSECURE_GITLAB_HTTP: value,
  GITHUB_PUSH_URL: value, GITLAB_PUSH_URL: value, NOTIFY_WEBHOOK_URL: value,
  GITHUB_WEBHOOK_MAX_BODY_BYTES: value, GITLAB_WEBHOOK_MAX_BODY_BYTES: value,
  COMMAND_RATE_LIMIT_MAX: value, COMMAND_RATE_LIMIT_WINDOW_MS: value,
  MAX_METRIC_COUNTER_RECORDS: value,
  GITHUB_POLICY_CONFIG_CACHE_TTL_MS: value, GITLAB_POLICY_CONFIG_CACHE_TTL_MS: value,
  GITHUB_GUIDELINE_CACHE_TTL_MS: value, GITLAB_GUIDELINE_CACHE_TTL_MS: value,
  GITHUB_INCREMENTAL_STATE_TTL_MS: value, GITLAB_INCREMENTAL_STATE_TTL_MS: value,
  NOTIFY_HTTP_TIMEOUT_MS: value, NOTIFY_HTTP_RETRIES: value, NOTIFY_HTTP_RETRY_BACKOFF_MS: value,
  FIX_APPROVAL_TTL_SECONDS: value, EVOLUTION_RELEASE_ACTIVATION_ENABLED: value,
  AI_HTTP_TIMEOUT_MS: value, AI_HTTP_RETRIES: value,
  AI_HTTP_RETRY_BACKOFF_MS: value, AI_MAX_CONCURRENCY: value, AI_MAX_QUEUE_SIZE: value,
  AI_SHUTDOWN_DRAIN_TIMEOUT_MS: value, OPENAI_MAX_COMPLETION_TOKENS: value,
  ANTHROPIC_MAX_TOKENS: value, GEMINI_MAX_OUTPUT_TOKENS: value,
  MAX_OPENAI_CLIENT_CACHE_ENTRIES: value, GITHUB_MAX_PATCH_CHARS_PER_FILE: value,
  GITHUB_MAX_TOTAL_PATCH_CHARS: value, GITLAB_MAX_PATCH_CHARS_PER_FILE: value,
  GITLAB_MAX_TOTAL_PATCH_CHARS: value, AI_DEBUG_LOGS: value, NOTIFY_WEBHOOK_FORMAT: value,
}).catchall(z.string());
const validationOptionsSchema = z.object({ requireDatabase: z.boolean().optional(),
  requireRoleDependencies: z.boolean().optional(), requireProviderCredentials: z.boolean().optional(),
  healthRole: z.string().optional() }).strict();
const inputSchema = z.object({ profile: z.enum(profiles), env: criticalEnvironmentSchema,
  options: validationOptionsSchema }).strict().superRefine((input, context) => {
  try { assertProfileEnvironment(input.env, input.profile, input.options); }
  catch (error) { context.addIssue({ code: z.ZodIssueCode.custom,
    message: error instanceof Error ? error.message : "Invalid runtime environment" }); }
});

/** Fail-fast role-aware validation. Error messages name fields, never configured values. */
export function validateRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  profile: RuntimeEnvironmentProfile,
  options: { requireDatabase?: boolean; requireRoleDependencies?: boolean;
    requireProviderCredentials?: boolean; healthRole?: string } = {},
): RuntimeEnvironmentConfiguration {
  const result = inputSchema.safeParse({ profile, env: definedEnvironment(env), options });
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid runtime environment");
  const input = result.data;
  const heartbeat = heartbeatConfiguration(input.env, profile !== "admin" && profile !== "migrate");

  if (profile === "health") {
    return { profile, heartbeat, ...(options.healthRole === "web" || options.healthRole === "all"
      ? { http: { port: integer(input.env, "PORT", 3_000, 1, 65_535), bodyLimit: "1mb" } } : {}) };
  }

  const database = options.requireDatabase === false ? undefined : databaseConfiguration(input.env);
  const poolMax = integer(input.env, poolName(profile), poolDefault(profile), 1,
    profile === "maintenance" ? 16 : 64);

  const configuration: RuntimeEnvironmentConfiguration = { profile, database, poolMax, heartbeat };
  if (profile === "web") configuration.http = {
    port: integer(input.env, "PORT", 3_000, 1, 65_535),
    bodyLimit: bodyLimit(input.env),
  };
  if (profile === "maintenance") configuration.maintenance = maintenanceConfiguration(input.env);
  return configuration;
}

function assertProfileEnvironment(env: Record<string, string>, profile: RuntimeEnvironmentProfile,
  options: { requireDatabase?: boolean; requireRoleDependencies?: boolean;
    requireProviderCredentials?: boolean; healthRole?: string }): void {
  heartbeatConfiguration(env, profile !== "admin" && profile !== "migrate");
  if (profile === "health") {
    const directory = optional(env, "PR_AGENT_HEALTH_DIRECTORY");
    if (directory && !isAbsolute(directory)) invalid("PR_AGENT_HEALTH_DIRECTORY");
    if (options.healthRole === "web" || options.healthRole === "all") integer(env, "PORT", 3_000, 1, 65_535);
    return;
  }
  if (options.requireDatabase !== false) databaseConfiguration(env);
  integer(env, poolName(profile), poolDefault(profile), 1, profile === "maintenance" ? 16 : 64);
  const directory = optional(env, "PR_AGENT_HEALTH_DIRECTORY");
  if (profile !== "admin" && profile !== "migrate" && directory && !isAbsolute(directory)) {
    invalid("PR_AGENT_HEALTH_DIRECTORY");
  }
  if (options.requireRoleDependencies !== false) {
    if (["web", "worker", "recovery"].includes(profile)) validatePublicationCredentialSources(env);
    if (profile === "web") validateWeb(env);
    if (profile === "worker") validateWorker(env, options.requireProviderCredentials !== false);
    if (profile === "verifier") validateVerifier(env);
  }
  if (options.requireRoleDependencies === false
      && ["web", "worker", "recovery"].includes(profile)) validatePublicationCredentialSources(env);
  validateTuning(env, profile);
  if (profile === "web") { integer(env, "PORT", 3_000, 1, 65_535); bodyLimit(env); }
  if (profile === "maintenance") maintenanceConfiguration(env);
}

function validateWeb(env: Record<string, string>): void {
  validateFrozenModelContract(env);
  validateCapabilities(env);
  exclusive(env, "HARNESS_API_PRINCIPALS_JSON", "HARNESS_API_PRINCIPALS_FILE");
  const principals = optional(env, "HARNESS_API_PRINCIPALS_FILE");
  if (principals && !isAbsolute(principals)) invalid("HARNESS_API_PRINCIPALS_FILE");
  boolean(env, "EXPOSE_ERROR_STACK", false);
  const onboardingMode = githubOnboardingMode(env);
  const appMode = githubAppModeConfigured(env);
  if (onboardingMode === "on" && !appMode) {
    invalid("APP_ID/PRIVATE_KEY/WEBHOOK_SECRET with FEATURE_GITHUB_ONBOARDING");
  }
  if (githubOnboardingRestrictionsEnabled(env)) {
    if (!optional(env, "HARNESS_ONBOARDING_PG_PASSWORD")) invalid("HARNESS_ONBOARDING_PG_PASSWORD");
    if (optional(env, "HARNESS_DATABASE_URL")) invalid("HARNESS_DATABASE_URL with FEATURE_GITHUB_ONBOARDING");
    if (!optional(env, "APP_ID") || !(optional(env, "PRIVATE_KEY") || optional(env, "PRIVATE_KEY_PATH"))
        || !optional(env, "WEBHOOK_SECRET")) {
      invalid("APP_ID/PRIVATE_KEY/WEBHOOK_SECRET with FEATURE_GITHUB_ONBOARDING");
    }
    integer(env, "APP_ID", 0, 1, Number.MAX_SAFE_INTEGER);
    try { resolveGitHubOnboardingOrigin(env); }
    catch { invalid("GITHUB_API_URL with FEATURE_GITHUB_ONBOARDING"); }
  }
  const skipGitHubSignature = boolean(env, "GITHUB_WEBHOOK_SKIP_SIGNATURE", false);
  if (skipGitHubSignature && optional(env, "NODE_ENV")?.toLowerCase() === "production") {
    invalid("GITHUB_WEBHOOK_SKIP_SIGNATURE");
  }
  if ((optional(env, "GITLAB_TOKEN") || optional(env, "GITLAB_BASE_URL"))
      && !optional(env, "GITLAB_WEBHOOK_SECRET")) invalid("GITLAB_WEBHOOK_SECRET");
  if (optional(env, "GITHUB_WEBHOOK_TOKEN")
      && !(optional(env, "GITHUB_WEBHOOK_SECRET") || optional(env, "WEBHOOK_SECRET"))) {
    invalid("GITHUB_WEBHOOK_SECRET/WEBHOOK_SECRET");
  }
}

function validateWorker(env: Record<string, string>, requireProviderCredentials: boolean): void {
  const provider = validateFrozenModelContract(env);
  if (requireProviderCredentials) validateProviderCredentials(env, provider);
  validateCapabilities(env);
  const concurrency = integer(env, "HARNESS_WORKER_CONCURRENCY", 4, 2, 16);
  integer(env, "HARNESS_WORKER_PER_BINDING_CONCURRENCY", 2, 1, 16);
  integer(env, "HARNESS_WORKER_SPECIAL_CONCURRENCY", 1, 1, concurrency - 1);
  integer(env, "HARNESS_RECOVERY_BINDING_PAGE_SIZE", 32, 1, 64);
}

function validateFrozenModelContract(env: Record<string, string>): string {
  const provider = (optional(env, "AI_PROVIDER") ?? "openai").toLowerCase().replace("_", "-");
  if (!["openai", "openai-compatible", "compatible", "anthropic", "claude", "gemini", "google"].includes(provider)) {
    invalid("AI_PROVIDER");
  }
  if (provider === "openai-compatible" || provider === "compatible") httpUrl(env, "OPENAI_BASE_URL", true);
  if (!optional(env, "HARNESS_MODEL_PRICING_JSON")) invalid("HARNESS_MODEL_PRICING_JSON");
  return provider;
}

function validateProviderCredentials(env: Record<string, string>, provider: string): void {
  if (provider === "openai" && !optional(env, "OPENAI_API_KEY")) invalid("OPENAI_API_KEY");
  if ((provider === "openai-compatible" || provider === "compatible")
      && !(optional(env, "OPENAI_COMPATIBLE_API_KEY") || optional(env, "OPENAI_API_KEY"))) {
    invalid("OPENAI_COMPATIBLE_API_KEY/OPENAI_API_KEY");
  }
  if ((provider === "anthropic" || provider === "claude") && !optional(env, "ANTHROPIC_API_KEY")) {
    invalid("ANTHROPIC_API_KEY");
  }
  if ((provider === "gemini" || provider === "google") && !optional(env, "GEMINI_API_KEY")) invalid("GEMINI_API_KEY");
}

function validatePublicationCredentialSources(env: Record<string, string>): void {
  exclusive(env, "PRIVATE_KEY", "PRIVATE_KEY_PATH");
  const githubParts = ["APP_ID", "PRIVATE_KEY", "PRIVATE_KEY_PATH", "WEBHOOK_SECRET"]
    .filter((name) => optional(env, name));
  if (githubParts.length && (!optional(env, "APP_ID")
      || !(optional(env, "PRIVATE_KEY") || optional(env, "PRIVATE_KEY_PATH"))
      || !optional(env, "WEBHOOK_SECRET"))) invalid("APP_ID/PRIVATE_KEY/WEBHOOK_SECRET");
  const path = optional(env, "PRIVATE_KEY_PATH");
  if (path && !isAbsolute(path)) invalid("PRIVATE_KEY_PATH");
}

function validateCapabilities(env: Record<string, string>): void {
  feature(env, "FEATURE_DEEP_REVIEW", true);
  feature(env, "FEATURE_ISSUE_TRIAGE", true);
  const fix = feature(env, "FEATURE_FIX", false);
  feature(env, "FEATURE_EVOLUTION", false);
  if (fix && (!optional(env, "FIX_DEFAULT_POLICY_ID") || !optional(env, "FIX_POLICY_REGISTRY_JSON"))) {
    invalid("FIX_DEFAULT_POLICY_ID/FIX_POLICY_REGISTRY_JSON");
  }
}

function validateVerifier(env: Record<string, string>): void {
  if (!optional(env, "FIX_POLICY_REGISTRY_JSON")) invalid("FIX_POLICY_REGISTRY_JSON");
  const directory = optional(env, "PR_AGENT_HEALTH_DIRECTORY");
  if (directory && !isAbsolute(directory)) invalid("PR_AGENT_HEALTH_DIRECTORY");
}

function validateTuning(env: Record<string, string>, profile: RuntimeEnvironmentProfile): void {
  const commonNumbers: Array<[string, number, number]> = [
    ["HTTP_TIMEOUT_MS", 100, 300_000], ["HTTP_RETRIES", 0, 10],
    ["HTTP_RETRY_BACKOFF_MS", 0, 60_000], ["HTTP_RETRY_MAX_DELAY_MS", 1, 300_000],
    ["GITHUB_HTTP_TIMEOUT_MS", 100, 300_000], ["GITHUB_HTTP_RETRIES", 0, 10],
    ["GITHUB_HTTP_RETRY_BACKOFF_MS", 0, 60_000], ["GITLAB_HTTP_TIMEOUT_MS", 100, 300_000],
    ["GITLAB_HTTP_RETRIES", 0, 10], ["GITLAB_HTTP_RETRY_BACKOFF_MS", 0, 60_000],
  ];
  if (["web", "worker", "recovery"].includes(profile)) {
    for (const rule of commonNumbers) optionalInteger(env, ...rule);
    for (const name of ["GITHUB_API_URL", "GITLAB_BASE_URL"] as const) httpUrl(env, name, false);
    boolean(env, "ALLOW_INSECURE_GITLAB_HTTP", false);
    for (const name of ["GITHUB_PUSH_URL", "GITLAB_PUSH_URL", "NOTIFY_WEBHOOK_URL"] as const) {
      httpUrl(env, name, false);
    }
  }
  if (profile === "web") {
    const rules: Array<[string, number, number]> = [
      ["GITHUB_WEBHOOK_MAX_BODY_BYTES", 1_024, 33_554_432],
      ["GITLAB_WEBHOOK_MAX_BODY_BYTES", 1_024, 33_554_432],
      ["COMMAND_RATE_LIMIT_MAX", 1, 10_000], ["COMMAND_RATE_LIMIT_WINDOW_MS", 1_000, 86_400_000],
      ["MAX_METRIC_COUNTER_RECORDS", 1, 100_000],
    ];
    for (const rule of rules) optionalInteger(env, ...rule);
    boolean(env, "PR_AGENT_CORE_LOGS", false);
  }
  if (profile === "web" || profile === "worker") {
    const reviewRules: Array<[string, number, number]> = [
      ["GITHUB_POLICY_CONFIG_CACHE_TTL_MS", 1_000, 86_400_000],
      ["GITLAB_POLICY_CONFIG_CACHE_TTL_MS", 1_000, 86_400_000],
      ["GITHUB_GUIDELINE_CACHE_TTL_MS", 1_000, 86_400_000],
      ["GITLAB_GUIDELINE_CACHE_TTL_MS", 1_000, 86_400_000],
      ["GITHUB_INCREMENTAL_STATE_TTL_MS", 60_000, 31_536_000_000],
      ["GITLAB_INCREMENTAL_STATE_TTL_MS", 60_000, 31_536_000_000],
      ["NOTIFY_HTTP_TIMEOUT_MS", 100, 300_000],
      ["NOTIFY_HTTP_RETRIES", 0, 10],
      ["NOTIFY_HTTP_RETRY_BACKOFF_MS", 0, 60_000],
    ];
    for (const rule of reviewRules) optionalInteger(env, ...rule);
  }
  if (profile === "web" && feature(env, "FEATURE_FIX", false)) {
    optionalInteger(env, "FIX_APPROVAL_TTL_SECONDS", 300, 86_400);
  }
  if (profile === "worker") {
    const rules: Array<[string, number, number]> = [
      ["AI_HTTP_TIMEOUT_MS", 500, 600_000], ["AI_HTTP_RETRIES", 0, 10],
      ["AI_HTTP_RETRY_BACKOFF_MS", 0, 60_000], ["AI_MAX_CONCURRENCY", 1, 128],
      ["AI_MAX_QUEUE_SIZE", 1, 100_000], ["AI_SHUTDOWN_DRAIN_TIMEOUT_MS", 1_000, 600_000],
      ["OPENAI_MAX_COMPLETION_TOKENS", 1, 1_000_000], ["ANTHROPIC_MAX_TOKENS", 1, 1_000_000],
      ["GEMINI_MAX_OUTPUT_TOKENS", 1, 1_000_000], ["MAX_OPENAI_CLIENT_CACHE_ENTRIES", 1, 10_000],
      ["GITHUB_MAX_PATCH_CHARS_PER_FILE", 1, 100_000_000],
      ["GITHUB_MAX_TOTAL_PATCH_CHARS", 1, 500_000_000],
      ["GITLAB_MAX_PATCH_CHARS_PER_FILE", 1, 100_000_000],
      ["GITLAB_MAX_TOTAL_PATCH_CHARS", 1, 500_000_000],
    ];
    for (const rule of rules) optionalInteger(env, ...rule);
    boolean(env, "AI_DEBUG_LOGS", false);
  }
  const format = optional(env, "NOTIFY_WEBHOOK_FORMAT")?.toLowerCase();
  if (format && !["wecom", "slack", "discord", "generic"].includes(format)) invalid("NOTIFY_WEBHOOK_FORMAT");
}

function maintenanceConfiguration(env: Record<string, string>): NonNullable<RuntimeEnvironmentConfiguration["maintenance"]> {
  const mode = (optional(env, "HARNESS_MAINTENANCE_MODE") ?? "preview").toLowerCase();
  if (mode !== "preview" && mode !== "apply") invalid("HARNESS_MAINTENANCE_MODE");
  const contentDays = integer(env, "HARNESS_MAINTENANCE_CONTENT_DAYS", 30, 7, 3_650);
  const replayDays = integer(env, "HARNESS_MAINTENANCE_REPLAY_DAYS", 90, 7, 3_650);
  const traceDays = integer(env, "HARNESS_MAINTENANCE_TRACE_DAYS", 400, 7, 3_650);
  if (!(contentDays < replayDays && replayDays < traceDays)) {
    invalid("HARNESS_MAINTENANCE_CONTENT_DAYS/REPLAY_DAYS/TRACE_DAYS");
  }
  return { mode, contentDays, replayDays, traceDays,
    intervalMs: integer(env, "HARNESS_MAINTENANCE_INTERVAL_MS", 60_000, 5_000, 86_400_000),
    batchLimit: integer(env, "HARNESS_MAINTENANCE_BATCH_LIMIT", 100, 1, 1_000) };
}

function heartbeatConfiguration(env: Record<string, string>, validate: boolean): RuntimeEnvironmentConfiguration["heartbeat"] {
  if (!validate) return { intervalMs: 5_000, staleAfterMs: 20_000 };
  const intervalMs = integer(env, "RUNTIME_HEARTBEAT_INTERVAL_MS", 5_000, 1_000, 60_000);
  const staleAfterMs = integer(env, "RUNTIME_HEARTBEAT_STALE_MS", 20_000, 3_000, 300_000);
  if (staleAfterMs < intervalMs * 2) invalid("RUNTIME_HEARTBEAT_STALE_MS");
  return { intervalMs, staleAfterMs };
}

function databaseConfiguration(env: Record<string, string>): NonNullable<RuntimeEnvironmentConfiguration["database"]> {
  const connectionString = optional(env, "HARNESS_DATABASE_URL");
  if (connectionString) {
    try {
      const parsed = new URL(connectionString);
      if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") invalid("HARNESS_DATABASE_URL");
    } catch { invalid("HARNESS_DATABASE_URL"); }
    return { connectionString, port: 5_432 };
  }
  const required = ["HARNESS_PG_HOST", "HARNESS_PG_DATABASE", "HARNESS_PG_USER", "HARNESS_PG_PASSWORD"];
  if (required.some((name) => !optional(env, name))) {
    throw new Error("Configure HARNESS_DATABASE_URL or HARNESS_PG_HOST/DATABASE/USER/PASSWORD/PORT");
  }
  return { host: optional(env, "HARNESS_PG_HOST"), database: optional(env, "HARNESS_PG_DATABASE"),
    user: optional(env, "HARNESS_PG_USER"), password: env.HARNESS_PG_PASSWORD,
    port: integer(env, "HARNESS_PG_PORT", 5_432, 1, 65_535) };
}

function poolName(profile: RuntimeEnvironmentProfile): string {
  if (profile === "worker") return "HARNESS_WORKER_POOL_MAX";
  if (profile === "recovery") return "HARNESS_RECOVERY_POOL_MAX";
  if (profile === "maintenance") return "HARNESS_MAINTENANCE_POOL_MAX";
  return "HARNESS_WEB_POOL_MAX";
}
function poolDefault(profile: RuntimeEnvironmentProfile): number {
  return profile === "recovery" || profile === "maintenance" ? 4 : 8;
}
function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
function optional(env: Record<string, string>, name: string): string | undefined { return env[name]?.trim() || undefined; }
function optionalInteger(env: Record<string, string>, name: string, min: number, max: number): void {
  if (optional(env, name) !== undefined) integer(env, name, min, min, max);
}
function integer(env: Record<string, string>, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name); if (!raw) return fallback;
  if (!/^[0-9]+$/u.test(raw)) invalid(name);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) invalid(name);
  return value;
}
function boolean(env: Record<string, string>, name: string, fallback: boolean): boolean {
  const raw = optional(env, name)?.toLowerCase(); if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  invalid(name);
}
function feature(env: Record<string, string>, name: string, fallback: boolean): boolean {
  const raw = optional(env, name)?.toLowerCase(); if (!raw) return fallback;
  if (raw === "on") return true; if (raw === "off") return false; invalid(name);
}
function exclusive(env: Record<string, string>, left: string, right: string): void {
  if (optional(env, left) && optional(env, right)) invalid(`${left}/${right}`);
}
function httpUrl(env: Record<string, string>, name: string, required: boolean): void {
  const raw = optional(env, name); if (!raw) { if (required) invalid(name); return; }
  try { const url = new URL(raw); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid(name); }
  catch { invalid(name); }
}
function bodyLimit(env: Record<string, string>): string {
  const raw = (optional(env, "WEBHOOK_BODY_LIMIT") ?? "1mb").toLowerCase();
  const match = /^(\d+)(kb|mb)$/u.exec(raw); if (!match) invalid("WEBHOOK_BODY_LIMIT");
  const bytes = Number(match[1]) * (match[2] === "mb" ? 1_048_576 : 1_024);
  if (bytes < 1_024 || bytes > 33_554_432) invalid("WEBHOOK_BODY_LIMIT");
  return raw;
}
function invalid(name: string): never { throw new Error(`Invalid runtime environment: ${name}`); }
