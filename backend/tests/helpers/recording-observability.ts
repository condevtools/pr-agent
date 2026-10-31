import type { SpanContext } from "@opentelemetry/api";

import {
  createAgentObservability,
  type AgentObservationAttributes,
  type AgentObservationDriver,
  type AgentObservationType,
} from "../../src/observability/index.js";

export interface ObservationRecord {
  name: string;
  type: AgentObservationType;
  attributes: AgentObservationAttributes;
  options: { parentSpanContext?: SpanContext; sessionId?: string };
  spanContext: SpanContext;
  updates: AgentObservationAttributes[];
  ended: boolean;
}

export function recordingObservability(
  records: ObservationRecord[],
  options: {
    captureContent?: "off" | "redacted";
    throwOnStart?: boolean;
    throwOnUpdate?: boolean;
    onUpdate?: (record: ObservationRecord, update: AgentObservationAttributes) => void;
  } = {},
) {
  return createAgentObservability({
    env: {
      LANGFUSE_ENABLED: "on",
      LANGFUSE_CAPTURE_CONTENT: options.captureContent ?? "off",
      LANGFUSE_PUBLIC_KEY: "fixture-public",
      LANGFUSE_SECRET_KEY: "fixture-secret",
      LANGFUSE_BASE_URL: "http://127.0.0.1:43189",
    },
    driver: recordingDriver(records, options),
  });
}

export function observationMetadata(record: ObservationRecord): Record<string, unknown> {
  return [record.attributes, ...record.updates].reduce<Record<string, unknown>>(
    (metadata, attributes) => ({ ...metadata, ...attributes.metadata }),
    {},
  );
}

function recordingDriver(
  records: ObservationRecord[],
  options: {
    throwOnStart?: boolean;
    throwOnUpdate?: boolean;
    onUpdate?: (record: ObservationRecord, update: AgentObservationAttributes) => void;
  },
): AgentObservationDriver {
  let ordinal = 0;
  return {
    start(name, type, attributes, observationOptions) {
      if (options.throwOnStart) throw new Error("synthetic telemetry start failure");
      ordinal += 1;
      const spanContext: SpanContext = {
        traceId: observationOptions.parentSpanContext?.traceId ?? `${ordinal}`.repeat(32).slice(0, 32),
        spanId: ordinal.toString(16).padStart(16, "0"),
        traceFlags: 1,
      };
      const record: ObservationRecord = {
        name, type, attributes, options: observationOptions,
        spanContext, updates: [], ended: false,
      };
      records.push(record);
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        spanContext,
        update(update) {
          if (options.throwOnUpdate) throw new Error("synthetic telemetry update failure");
          record.updates.push(update);
          options.onUpdate?.(record, update);
        },
        end() { record.ended = true; },
      };
    },
    shutdown: async () => undefined,
  };
}
