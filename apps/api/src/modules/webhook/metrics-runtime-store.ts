import { createMetricStore, type MetricStore } from "./metrics.js";

const runtimeMetricStore: MetricStore = createMetricStore();

export function getRuntimeMetricStore(): MetricStore {
  return runtimeMetricStore;
}
