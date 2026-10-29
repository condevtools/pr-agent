import { fingerprint } from "../harness/versions.js";

export interface CanaryObservation {
  selection: "control" | "candidate"; status: string;
  analysisStatus?: "complete" | "partial" | "failed"; costMicros?: number; latencyMs?: number;
  publicationUnknown?: boolean;
}
export interface CanaryMetricsV1 {
  schemaVersion: 1; candidateCount: number; controlCount: number; comparable: boolean;
  candidate: { operationalErrorRate: number; incompleteRate: number; p50CostMicros: number; p95LatencyMs: number };
  control: { operationalErrorRate: number; incompleteRate: number; p50CostMicros: number; p95LatencyMs: number };
  unknownPublications: number; metricsHash: string;
}

export function computeCanaryMetrics(rows: readonly CanaryObservation[]): CanaryMetricsV1 {
  const summarize = (selection: "control" | "candidate") => {
    const selected = rows.filter((row) => row.selection === selection);
    const costs = selected.flatMap((row) => row.costMicros === undefined ? [] : [row.costMicros]);
    const latencies = selected.flatMap((row) => row.latencyMs === undefined ? [] : [row.latencyMs]);
    return { operationalErrorRate: ratio(selected.filter((row) => row.status !== "succeeded").length, selected.length),
      incompleteRate: ratio(selected.filter((row) => row.analysisStatus !== "complete").length, selected.length),
      p50CostMicros: quantile(costs, 0.5), p95LatencyMs: quantile(latencies, 0.95),
      count: selected.length, completeMeasurements: selected.every((row) =>
        row.status === "succeeded" || row.status === "failed" || row.status === "cancelled")
        && costs.length === selected.length && latencies.length === selected.length
        && costs.every((value) => Number.isFinite(value) && value >= 0)
        && latencies.every((value) => Number.isFinite(value) && value >= 0) };
  };
  const candidate = summarize("candidate"); const control = summarize("control");
  const content = { schemaVersion: 1 as const, candidateCount: candidate.count, controlCount: control.count,
    comparable: candidate.completeMeasurements && control.completeMeasurements,
    candidate: { operationalErrorRate: candidate.operationalErrorRate, incompleteRate: candidate.incompleteRate,
      p50CostMicros: candidate.p50CostMicros, p95LatencyMs: candidate.p95LatencyMs },
    control: { operationalErrorRate: control.operationalErrorRate, incompleteRate: control.incompleteRate,
      p50CostMicros: control.p50CostMicros, p95LatencyMs: control.p95LatencyMs },
    unknownPublications: rows.filter((row) => row.publicationUnknown).length };
  return { ...content, metricsHash: fingerprint(content) };
}

export function canPromoteCanary(metrics: CanaryMetricsV1): boolean {
  return metrics.comparable && metrics.candidateCount >= 100 && metrics.controlCount >= 100
    && metrics.unknownPublications === 0
    && metrics.candidate.operationalErrorRate <= metrics.control.operationalErrorRate
    && metrics.candidate.incompleteRate <= metrics.control.incompleteRate
    && metrics.candidate.p50CostMicros <= metrics.control.p50CostMicros
    && metrics.candidate.p95LatencyMs <= metrics.control.p95LatencyMs;
}
function ratio(value: number, total: number): number { return total === 0 ? 1 : value / total; }
function quantile(values: readonly number[], p: number): number {
  if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1] ?? sorted[0]!;
}
