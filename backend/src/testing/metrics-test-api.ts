import { getRuntimeMetricStore } from "../modules/webhook/metrics-runtime-store.js";

export function clearMetricState(): void {
  getRuntimeMetricStore().clear();
}
