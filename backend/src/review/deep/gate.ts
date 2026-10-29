import { fingerprint } from "../../agent-runtime/versions.js";
import type {
  CriticDecision,
  DeepReviewSource,
  EvidenceRecord,
  FindingCandidate,
  GateDecision,
  GateReasonCode,
} from "./contracts.js";

export function gateDeepReviewFindings(input: {
  source: DeepReviewSource;
  candidates: readonly FindingCandidate[];
  criticDecisions: readonly CriticDecision[];
  evidence: ReadonlyMap<string, EvidenceRecord>;
}): GateDecision[] {
  const criticByCandidate = new Map<string, CriticDecision[]>();
  for (const decision of input.criticDecisions) {
    const decisions = criticByCandidate.get(decision.candidateId) ?? [];
    decisions.push(decision);
    criticByCandidate.set(decision.candidateId, decisions);
  }
  return input.candidates.map((candidate) => {
    const critic = criticByCandidate.get(candidate.id) ?? [];
    const reasonCode = gateCandidate(input.source, candidate, critic, input.evidence);
    return { candidateId: candidate.id, accepted: reasonCode === "accepted", reasonCode };
  });
}

function gateCandidate(
  source: DeepReviewSource,
  candidate: FindingCandidate,
  critic: readonly CriticDecision[],
  evidence: ReadonlyMap<string, EvidenceRecord>,
): GateReasonCode {
  if (critic.length === 0) return "critic_decision_missing";
  if (critic.length !== 1) return "critic_decision_duplicate";
  if (critic[0]!.duplicateOfCandidateId && critic[0]!.decision !== "reject") return "critic_decision_invalid";
  if (critic[0]!.decision === "reject") return "critic_rejected";
  if (critic[0]!.decision === "needs_more_evidence") return "critic_needs_more_evidence";
  if (!candidateIdentityMatches(candidate)) return "candidate_identity_invalid";
  if (candidate.crossFileEvidenceIds.length > 0) return "cross_file_not_supported";
  const records: EvidenceRecord[] = [];
  for (const id of candidate.evidenceIds) {
    const record = evidence.get(id);
    if (!record) return "evidence_missing";
    if (record.status !== "succeeded") return "evidence_failed";
    if (record.runId !== source.identity.runId || record.headSha !== source.identity.headSha) {
      return "evidence_scope_mismatch";
    }
    if (!/^[a-f0-9]{64}$/.test(record.contentHash)) return "evidence_failed";
    records.push(record);
  }
  if (!records.some((record) => evidenceCoversLocation(record, candidate))) {
    return "evidence_location_invalid";
  }
  if (!isChangedLine(source, candidate)) return "finding_not_on_changed_line";
  return "accepted";
}

function candidateIdentityMatches(candidate: FindingCandidate): boolean {
  const { id, ...identity } = candidate;
  return id === fingerprint(identity);
}

function evidenceCoversLocation(record: EvidenceRecord, candidate: FindingCandidate): boolean {
  return record.kind === "file_range"
    && !record.truncated
    && record.path === candidate.location.path
    && typeof record.startLine === "number"
    && typeof record.endLine === "number"
    && record.startLine <= candidate.location.startLine
    && record.endLine >= candidate.location.endLine;
}

function isChangedLine(source: DeepReviewSource, candidate: FindingCandidate): boolean {
  if (candidate.location.side !== "new") return false;
  const file = source.files.find(({ path }) => path === candidate.location.path);
  if (!file) return false;
  return file.changedLines.some((line) =>
    line >= candidate.location.startLine && line <= candidate.location.endLine);
}
