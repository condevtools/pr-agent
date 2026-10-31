import { nowMs, readNumberEnv, resolveRefetchableCacheBackend, systemClock, type Clock } from "#core";
import { getModelConcurrencyStats } from "#model";

interface MetricDefinition {
  help: string;
  type: "counter" | "gauge";
}

interface MetricCounterRecord {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface MetricStoreOptions {
  clock?: Clock;
  resolveModelConcurrencyStats?: typeof getModelConcurrencyStats;
}

const DEFAULT_MAX_METRIC_COUNTER_RECORDS = 5_000;

const metricDefinitions: Record<string, MetricDefinition> = {
  pr_agent_github_onboarding_requests_total: {
    help: "GitHub installation synchronization requests and coalesced deliveries.", type: "counter",
  },
  pr_agent_github_onboarding_restrictions_total: {
    help: "GitHub App restrictive lifecycle outcomes.", type: "counter",
  },
  pr_agent_github_onboarding_activity_total: {
    help: "GitHub installation coordinator activity by bounded outcome.", type: "counter",
  },
  pr_agent_github_onboarding_errors_total: {
    help: "GitHub installation coordinator errors by stable operation and code.", type: "counter",
  },
  pr_agent_github_deferred_admissions_total: {
    help: "GitHub deferred PR admission outcomes.", type: "counter",
  },
  pr_agent_github_deferred_outcomes_total: {
    help: "GitHub deferred PR drain, retry, skip, conflict and expiry outcomes.", type: "counter",
  },
  pr_agent_webhook_requests_total: {
    help: "Total number of received webhook trigger requests.",
    type: "counter",
  },
  pr_agent_webhook_results_total: {
    help: "Total number of webhook trigger outcomes.",
    type: "counter",
  },
  pr_agent_webhook_replay_total: {
    help: "Total number of webhook replay outcomes.",
    type: "counter",
  },
  pr_agent_webhook_store_writes_total: {
    help: "Total number of persisted webhook debug records.",
    type: "counter",
  },
  pr_agent_webhook_store_trim_total: {
    help: "Total number of webhook debug store trim operations.",
    type: "counter",
  },
  pr_agent_health_checks_total: {
    help: "Total number of health endpoint calls.",
    type: "counter",
  },
  pr_agent_http_errors_total: {
    help: "Total number of HTTP errors handled by global filter.",
    type: "counter",
  },
  pr_agent_route_access_denials_total: {
    help: "Total number of capability guard access denials.",
    type: "counter",
  },
  pr_agent_process_uptime_seconds: {
    help: "Process uptime in seconds.",
    type: "gauge",
  },
  pr_agent_ai_requests_active: {
    help: "Number of active AI requests.",
    type: "gauge",
  },
  pr_agent_ai_wait_queue_size: {
    help: "Number of queued AI requests waiting for concurrency slots.",
    type: "gauge",
  },
  pr_agent_ai_shutdown_requested: {
    help: "Whether AI shutdown has been requested (1 or 0).",
    type: "gauge",
  },
  pr_agent_runtime_state_backend_info: {
    help: "Runtime state backend info metric (always 1 for selected backend).",
    type: "gauge",
  },
};

export class MetricStore {
  private readonly metricCounters = new Map<string, MetricCounterRecord>();
  private processStartedAt: number;
  private readonly clock: Clock;
  private readonly resolveModelStats: typeof getModelConcurrencyStats;

  constructor(options?: MetricStoreOptions) {
    this.clock = options?.clock ?? systemClock;
    this.resolveModelStats = options?.resolveModelConcurrencyStats ?? getModelConcurrencyStats;
    this.processStartedAt = nowMs(this.clock);
  }

  incrementCounter(name: string, labels: Record<string, string>, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }

    const normalizedName = normalizeMetricName(name);
    const normalizedLabels = normalizeMetricLabels(labels);
    const key = buildCounterKey(normalizedName, normalizedLabels);
    const existing = this.metricCounters.get(key);
    if (existing) {
      existing.value += delta;
      return;
    }

    const maxCounterRecords = this.resolveMaxCounterRecords();
    while (this.metricCounters.size >= maxCounterRecords) {
      const oldest = this.metricCounters.keys().next();
      if (oldest.done) {
        break;
      }
      this.metricCounters.delete(oldest.value);
    }

    this.metricCounters.set(key, {
      name: normalizedName,
      labels: normalizedLabels,
      value: delta,
    });
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    for (const [name, definition] of Object.entries(metricDefinitions)) {
      lines.push(`# HELP ${name} ${definition.help}`);
      lines.push(`# TYPE ${name} ${definition.type}`);

      if (definition.type === "counter") {
        const records = [...this.metricCounters.values()]
          .filter((record) => record.name === name)
          .sort((a, b) =>
            buildCounterKey(a.name, a.labels).localeCompare(
              buildCounterKey(b.name, b.labels),
            ),
          );
        if (records.length === 0) {
          lines.push(formatMetricLine(name, 0, {}));
        } else {
          for (const record of records) {
            lines.push(formatMetricLine(name, record.value, record.labels));
          }
        }
        continue;
      }

      if (name === "pr_agent_process_uptime_seconds") {
        lines.push(
          formatMetricLine(
            name,
            (nowMs(this.clock) - this.processStartedAt) / 1000,
            {},
          ),
        );
        continue;
      }

      if (name === "pr_agent_runtime_state_backend_info") {
        lines.push(
          formatMetricLine(name, 1, {
            backend: resolveRefetchableCacheBackend(),
          }),
        );
        continue;
      }

      const ai = this.resolveModelStats();
      if (name === "pr_agent_ai_requests_active") {
        lines.push(formatMetricLine(name, ai.activeRequests, {}));
        continue;
      }
      if (name === "pr_agent_ai_wait_queue_size") {
        lines.push(formatMetricLine(name, ai.queuedRequests, {}));
        continue;
      }
      if (name === "pr_agent_ai_shutdown_requested") {
        lines.push(formatMetricLine(name, ai.shutdownRequested ? 1 : 0, {}));
        continue;
      }

      lines.push(formatMetricLine(name, 0, {}));
    }

    return `${lines.join("\n")}\n`;
  }

  clear(): void {
    this.metricCounters.clear();
    this.processStartedAt = nowMs(this.clock);
  }

  readCounter(name: string, labels: Record<string, string>): number {
    const key = buildCounterKey(normalizeMetricName(name), normalizeMetricLabels(labels));
    return this.metricCounters.get(key)?.value ?? 0;
  }

  private resolveMaxCounterRecords(): number {
    return Math.max(
      100,
      readNumberEnv("MAX_METRIC_COUNTER_RECORDS", DEFAULT_MAX_METRIC_COUNTER_RECORDS),
    );
  }
}

export function createMetricStore(options?: MetricStoreOptions): MetricStore {
  return new MetricStore(options);
}

function normalizeMetricName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    return "pr_agent_unknown_metric_total";
  }
  return normalized;
}

function normalizeMetricLabels(labels: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const labelKey = key.trim();
    if (!labelKey) {
      continue;
    }
    normalized[labelKey] = value.trim();
  }
  return normalized;
}

function buildCounterKey(name: string, labels: Record<string, string>): string {
  const labelPairs = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
  return `${name}|${labelPairs.map(([key, value]) => `${key}=${value}`).join(",")}`;
}

function formatMetricLine(
  name: string,
  value: number,
  labels: Record<string, string>,
): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const labelPairs = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
  if (labelPairs.length === 0) {
    return `${name} ${safeValue}`;
  }

  const renderedLabels = labelPairs
    .map(([key, labelValue]) => `${key}="${escapePrometheusLabelValue(labelValue)}"`)
    .join(",");
  return `${name}{${renderedLabels}} ${safeValue}`;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
