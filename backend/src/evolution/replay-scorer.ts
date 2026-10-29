import type { DeepReviewArtifact, FindingCandidate } from "../agents/contracts.js";
import type { ReplayScoreV1 } from "./replay-contracts.js";

interface ExpectedFinding {
  path: string;
  startLine: number;
  endLine: number;
  severity: "low" | "medium" | "high";
}

export function scoreReplayArtifact(artifact: DeepReviewArtifact, labels: {
  completeness: "complete";
  expectedFindings: readonly ExpectedFinding[];
}): ReplayScoreV1 {
  const accepted = new Set(artifact.gateDecisions.filter(({ accepted: value }) => value).map(({ candidateId }) => candidateId));
  const predicted = artifact.candidates.filter((candidate) => accepted.has(candidate.id));
  const expectedKeys = new Set(labels.expectedFindings.map(findingKey));
  const predictedKeys = new Set(predicted.map(candidateKey));
  let truePositive = 0;
  for (const key of predictedKeys) if (expectedKeys.has(key)) truePositive += 1;
  const falsePositive = predictedKeys.size - truePositive;
  const falseNegative = expectedKeys.size - truePositive;
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const weighted = weightedCounts(labels.expectedFindings, predicted);
  const highFalsePositives = predicted.filter((candidate) => candidate.severity === "high"
    && !expectedKeys.has(candidateKey(candidate))).length;
  const highFalseNegatives = labels.expectedFindings.filter((finding) => finding.severity === "high"
    && !predictedKeys.has(findingKey(finding))).length;
  return { schemaVersion: 1, expected: expectedKeys.size, predicted: predictedKeys.size,
    truePositive, falsePositive, falseNegative, precision, recall, f1: harmonic(precision, recall),
    severityWeightedF1: harmonic(ratio(weighted.tp, weighted.tp + weighted.fp), ratio(weighted.tp, weighted.tp + weighted.fn)),
    highFalsePositives, highFalseNegatives,
    safetyRegression: artifact.analysisStatus !== "complete" || highFalsePositives > 0 || highFalseNegatives > 0,
    analysisStatus: artifact.analysisStatus };
}

function findingKey(value: ExpectedFinding): string {
  return `${value.path}\0${value.startLine}\0${value.endLine}\0${value.severity}`;
}

function candidateKey(value: FindingCandidate): string {
  return findingKey({ path: value.location.path, startLine: value.location.startLine,
    endLine: value.location.endLine, severity: value.severity });
}

function weight(severity: ExpectedFinding["severity"]): number { return severity === "high" ? 4 : severity === "medium" ? 2 : 1; }
function weightedCounts(expected: readonly ExpectedFinding[], predicted: readonly FindingCandidate[]) {
  const expectedWeights = new Map(expected.map((item) => [findingKey(item), weight(item.severity)]));
  const predictedWeights = new Map(predicted.map((item) => [candidateKey(item), weight(item.severity)]));
  let tp = 0; let fp = 0; let fn = 0;
  for (const [key, value] of predictedWeights) expectedWeights.has(key) ? tp += value : fp += value;
  for (const [key, value] of expectedWeights) if (!predictedWeights.has(key)) fn += value;
  return { tp, fp, fn };
}
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 1 : numerator / denominator; }
function harmonic(left: number, right: number): number { return left + right === 0 ? 0 : 2 * left * right / (left + right); }
