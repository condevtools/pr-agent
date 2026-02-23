import { getRuntimeMetricStore } from "./metrics-runtime-store.js";

export function incrementMetricCounter(
  name: string,
  labels: Record<string, string> = {},
  delta = 1,
): void {
  getRuntimeMetricStore().incrementCounter(name, labels, delta);
}

export function renderPrometheusMetrics(): string {
  return getRuntimeMetricStore().renderPrometheus();
}
