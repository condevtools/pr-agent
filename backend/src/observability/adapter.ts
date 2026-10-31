import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

import { LangfuseSpanProcessor, isLangfuseSpan } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservation,
  type LangfuseObservationAttributes,
} from "@langfuse/tracing";
import { INVALID_SPAN_CONTEXT, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { logCore, sanitizeLogMetadata } from "#core";
import { sanitizeObservationMaskValue, sanitizeObservationValue } from "./privacy.js";

export type AgentObservationType = "agent" | "span" | "tool" | "generation" | "chain" | "evaluator";
export type AgentObservationLevel = "DEFAULT" | "WARNING" | "ERROR";

export interface AgentObservationAttributes {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, unknown>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  level?: AgentObservationLevel;
  statusMessage?: string;
}

export interface AgentObservationHandle {
  readonly traceId?: string;
  readonly spanId?: string;
  update(attributes: AgentObservationAttributes): void;
}

export interface AgentObservationOptions {
  root?: boolean;
  sessionId?: string;
}

interface DriverObservation {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly spanContext?: SpanContext;
  update(attributes: AgentObservationAttributes): void;
  end(): void;
}

export interface AgentObservationDriver {
  start(
    name: string,
    type: AgentObservationType,
    attributes: AgentObservationAttributes,
    options: { parentSpanContext?: SpanContext; sessionId?: string },
  ): DriverObservation;
  shutdown(): Promise<void>;
}

export interface AgentObservability {
  readonly enabled: boolean;
  readonly captureContent: boolean;
  observe<T>(
    name: string,
    type: AgentObservationType,
    attributes: AgentObservationAttributes,
    action: (handle: AgentObservationHandle) => Promise<T>,
    options?: AgentObservationOptions,
  ): Promise<T>;
  shutdown(): Promise<void>;
}

export interface CreateAgentObservabilityOptions {
  env?: NodeJS.ProcessEnv;
  driver?: AgentObservationDriver;
  shutdownTimeoutMs?: number;
}

const activeAdapter = new AsyncLocalStorage<AgentObservability>();
const globalParent = new AsyncLocalStorage<SpanContext>();
let defaultAdapter: AgentObservability = disabledAdapter();

export function createAgentObservability(
  options: CreateAgentObservabilityOptions = {},
): AgentObservability {
  const env = options.env ?? process.env;
  const config = resolveConfig(env);
  if (!config.enabled) return disabledAdapter();
  let driver: AgentObservationDriver;
  try { driver = options.driver ?? createLangfuseDriver(config); }
  catch (error) {
    logTelemetryFailure("observability.initialization_failed", error);
    return disabledAdapter();
  }
  let closing: Promise<void> | undefined;
  return {
    enabled: true,
    captureContent: config.captureContent,
    async observe<T>(
      name: string,
      type: AgentObservationType,
      attributes: AgentObservationAttributes,
      action: (handle: AgentObservationHandle) => Promise<T>,
      observationOptions: AgentObservationOptions = {},
    ): Promise<T> {
      const initial = safelySanitizeAttributes(attributes, config, env);
      let accumulatedMetadata = initial.metadata;
      let observation: DriverObservation | undefined;
      try {
        observation = driver.start(safeName(name, env), type, initial, {
          parentSpanContext: observationOptions.root ? undefined : globalParent.getStore(),
          sessionId: observationOptions.sessionId
            ? safeName(observationOptions.sessionId, env) : undefined,
        });
      } catch (error) {
        logTelemetryFailure("observability.start_failed", error);
      }
      const handle: AgentObservationHandle = observation ? {
        traceId: observation.traceId,
        spanId: observation.spanId,
        update(update) {
          try {
            const next = safelySanitizeAttributes(update, config, env);
            if (next.metadata) {
              accumulatedMetadata = { ...accumulatedMetadata, ...next.metadata };
              next.metadata = accumulatedMetadata;
            }
            observation.update(next);
          }
          catch (error) { logTelemetryFailure("observability.update_failed", error); }
        },
      } : NOOP_HANDLE;
      const run = async () => {
        try {
          return await action(handle);
        } catch (error) {
          handle.update({ level: "ERROR", statusMessage: errorType(error) });
          throw error;
        } finally {
          try { observation?.end(); }
          catch (error) { logTelemetryFailure("observability.end_failed", error); }
        }
      };
      return observation?.spanContext
        ? globalParent.run(observation.spanContext, run)
        : run();
    },
    shutdown() {
      closing ??= boundedShutdown(driver, options.shutdownTimeoutMs ?? 5_000);
      return closing;
    },
  };
}

export function initializeAgentObservability(env: NodeJS.ProcessEnv = process.env): void {
  defaultAdapter = createAgentObservability({ env });
  logCore("info", "observability.initialized", {
    enabled: defaultAdapter.enabled,
    captureContent: defaultAdapter.captureContent,
  });
}

export function observeAgentOperation<T>(
  name: string,
  type: AgentObservationType,
  attributes: AgentObservationAttributes,
  action: (handle: AgentObservationHandle) => Promise<T>,
  options?: AgentObservationOptions,
): Promise<T> {
  return (activeAdapter.getStore() ?? defaultAdapter).observe(name, type, attributes, action, options);
}

export function withAgentObservability<T>(
  adapter: AgentObservability,
  action: () => Promise<T>,
): Promise<T> {
  return activeAdapter.run(adapter, action);
}

export function shutdownAgentObservability(): Promise<void> {
  return defaultAdapter.shutdown();
}

function createLangfuseDriver(config: ResolvedConfig): AgentObservationDriver {
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment ? safeName(config.environment, config.env) : undefined,
    release: config.release ? safeName(config.release, config.env) : undefined,
    flushAt: 32,
    flushInterval: 2,
    timeout: 3,
    mediaUploadEnabled: false,
    shouldExportSpan: ({ otelSpan }) => isLangfuseSpan(otelSpan),
    mask: ({ data }) => sanitizeObservationMaskValue(data, config.env),
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "pr-agent",
      ...(config.release ? { "service.version": safeName(config.release, config.env) } : {}),
    }),
    spanProcessors: [processor],
  });
  setLangfuseTracerProvider(provider);
  return {
    start(name, type, attributes, options) {
      const start = startObservation as unknown as (
        observationName: string,
        observationAttributes: AgentObservationAttributes,
        observationOptions: { asType: AgentObservationType; parentSpanContext?: SpanContext },
      ) => LangfuseObservation;
      const observation = start(name, attributes, {
        asType: type,
        parentSpanContext: options.parentSpanContext ?? INVALID_SPAN_CONTEXT,
      }) as LangfuseObservation;
      if (options.sessionId) {
        observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, options.sessionId);
      }
      return wrapSdkObservation(observation);
    },
    async shutdown() {
      try { await processor.forceFlush(); }
      finally {
        try { await provider.shutdown(); }
        finally { setLangfuseTracerProvider(null); }
      }
    },
  };
}

function wrapSdkObservation(observation: LangfuseObservation): DriverObservation {
  return {
    traceId: observation.traceId,
    spanId: observation.id,
    spanContext: observation.otelSpan.spanContext(),
    update(attributes) {
      observation.updateOtelSpanAttributes(attributes as unknown as LangfuseObservationAttributes);
    },
    end() { observation.end(); },
  };
}

interface ResolvedConfig {
  enabled: boolean;
  captureContent: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
  env: NodeJS.ProcessEnv;
}

function resolveConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  const requestedMode = env.LANGFUSE_ENABLED?.trim().toLowerCase();
  const mode = oneOf(env.LANGFUSE_ENABLED, ["auto", "on", "off"], "auto");
  const capture = oneOf(env.LANGFUSE_CAPTURE_CONTENT, ["off", "redacted"], "off");
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? "";
  const baseUrl = env.LANGFUSE_BASE_URL?.trim().replace(/\/+$/u, "") ?? "";
  const validUrl = validHttpUrl(baseUrl);
  const transportAllowed = validUrl && isAllowedTransport(baseUrl, env);
  const complete = Boolean(publicKey && secretKey && baseUrl && transportAllowed);
  const modeValid = requestedMode === undefined || requestedMode === "" ||
    ["auto", "on", "off"].includes(requestedMode);
  if (!modeValid) {
    logCore("warn", "observability.configuration_invalid", { reason: "invalid_enabled_mode" });
  } else if (mode !== "off" && !complete && (mode === "on" || publicKey || secretKey || baseUrl)) {
    logCore("warn", "observability.configuration_invalid", { reason: "missing_or_invalid_required_value" });
  }
  if (mode !== "off" && validUrl && baseUrl.startsWith("http://") && transportAllowed) {
    logCore("warn", "observability.insecure_transport", { endpoint: baseUrl });
  }
  return {
    enabled: modeValid && mode !== "off" && complete,
    captureContent: capture === "redacted",
    publicKey,
    secretKey,
    baseUrl,
    environment: env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || undefined,
    release: env.LANGFUSE_RELEASE?.trim() || undefined,
    env,
  };
}

function sanitizeAttributes(
  attributes: AgentObservationAttributes,
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
): AgentObservationAttributes {
  return {
    ...(config.captureContent && "input" in attributes
      ? { input: sanitizeObservationValue(attributes.input, env) } : {}),
    ...(config.captureContent && "output" in attributes
      ? { output: sanitizeObservationValue(attributes.output, env) } : {}),
    ...(attributes.metadata ? {
      metadata: sanitizeObservationValue(attributes.metadata, env) as Record<string, unknown>,
    } : {}),
    ...(attributes.model ? { model: safeName(attributes.model, env) } : {}),
    ...(attributes.modelParameters ? {
      modelParameters: sanitizeModelParameters(attributes.modelParameters, config, env),
    } : {}),
    ...(attributes.usageDetails ? { usageDetails: safeNumbers(attributes.usageDetails) } : {}),
    ...(attributes.costDetails ? { costDetails: safeNumbers(attributes.costDetails) } : {}),
    ...(attributes.level ? { level: attributes.level } : {}),
    ...(attributes.statusMessage ? {
      statusMessage: String(sanitizeObservationValue(attributes.statusMessage, env)).slice(0, 512),
    } : {}),
  };
}

function safelySanitizeAttributes(
  attributes: AgentObservationAttributes,
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
): AgentObservationAttributes {
  try { return sanitizeAttributes(attributes, config, env); }
  catch (error) {
    logTelemetryFailure("observability.sanitization_failed", error);
    return {};
  }
}

function disabledAdapter(): AgentObservability {
  return {
    enabled: false,
    captureContent: false,
    observe: (_name, _type, _attributes, action) => action(NOOP_HANDLE),
    shutdown: async () => undefined,
  };
}

const NOOP_HANDLE: AgentObservationHandle = { update() {} };

async function boundedShutdown(driver: AgentObservationDriver, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      driver.shutdown(),
      new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); }),
    ]);
    if (timedOut) logCore("warn", "observability.shutdown_timeout", { timeoutMs });
  } catch (error) {
    logTelemetryFailure("observability.shutdown_failed", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeNumbers(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).slice(0, 30)
    .filter(([, value]) => Number.isFinite(value) && value >= 0)
    .map(([key, value]) => [boundName(key), value]));
}

function safeName(value: string, env: NodeJS.ProcessEnv): string {
  const sanitized = sanitizeObservationValue(value, env);
  return boundName(typeof sanitized === "string" ? sanitized : "[REDACTED]");
}

function boundName(value: string): string {
  const trimmed = value.trim();
  return (trimmed || "unnamed").slice(0, 200);
}

function errorType(error: unknown): string {
  const failure = sanitizeLogMetadata({ failure: error }).failure;
  if (failure && typeof failure === "object" && "errorType" in failure &&
      typeof failure.errorType === "string") return failure.errorType;
  return "Error";
}

function logTelemetryFailure(event: string, error: unknown): void {
  logCore("warn", event, { failureClass: errorType(error) });
}

function oneOf<T extends string>(raw: string | undefined, values: readonly T[], fallback: T): T {
  const normalized = raw?.trim().toLowerCase();
  return values.includes(normalized as T) ? normalized as T : fallback;
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash;
  } catch { return false; }
}

function isAllowedTransport(value: string, env: NodeJS.ProcessEnv): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  if (env.LANGFUSE_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true") return true;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(hostname) === 4) {
    return /^127\./u.test(hostname) || /^10\./u.test(hostname) || /^192\.168\./u.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname);
  }
  if (isIP(hostname) === 6) return hostname === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/u.test(hostname);
  return hostname === "host.docker.internal" || /^[a-z0-9][a-z0-9-]*$/u.test(hostname);
}

function sanitizeModelParameters(
  parameters: Record<string, unknown>,
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [rawKey, rawValue] of Object.entries(parameters).slice(0, 30)) {
    const key = safeName(rawKey, env);
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) result[key] = rawValue;
    else if (typeof rawValue === "boolean") result[key] = String(rawValue);
    else if (typeof rawValue === "string") result[key] = safeName(rawValue, env);
    else if (config.captureContent && rawValue !== undefined) {
      const sanitized = sanitizeObservationValue(rawValue, env);
      result[key] = JSON.stringify(sanitized).slice(0, 16 * 1024);
    }
  }
  return result;
}
