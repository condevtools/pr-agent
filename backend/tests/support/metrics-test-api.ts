import { getRuntimeMetricStore } from "../../src/http/system/metrics-runtime-store.js";

export function clearMetricState(): void {
  getRuntimeMetricStore().clear();
}
