import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import type { StructuredModel } from "../../model/contracts.js";
import type { PullRequestReviewInput, RiskLevel } from "../contracts.js";

export type DeepReviewRole = "security" | "correctness";
export type DeepStepKind = "model" | "tool" | "coordination" | "verification";
export type CoverageStatus = "complete" | "partial" | "failed";
export type EvidenceKind =
  | "file_range"
  | "changed_files_search"
  | "symbol_references"
  | "manifest"
  | "ci_status";

export interface DeepReviewIdentity {
  tenantId: string;
  integrationId: string;
  runId: string;
  platform: "github" | "gitlab";
  repository: string;
  baseSha: string;
  headSha: string;
}

export interface DeepReviewFile {
  path: string;
  oldPath: string;
  status: string;
  changedLines: readonly number[];
}

export interface SourceCoverage {
  status: "complete" | "partial";
  reasonCodes: readonly string[];
}

export interface DeepReviewSource {
  identity: DeepReviewIdentity;
  input: PullRequestReviewInput;
  files: readonly DeepReviewFile[];
  coverage: SourceCoverage;
}

export interface FindingLocation {
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
}

export interface FindingCandidate {
  id: string;
  sourceRole: DeepReviewRole;
  severity: RiskLevel;
  title: string;
  body: string;
  location: FindingLocation;
  evidenceIds: string[];
  crossFileEvidenceIds: string[];
  suggestion?: string;
}

export interface EvidenceRecord {
  id: string;
  runId: string;
  headSha: string;
  kind: EvidenceKind;
  status: "succeeded" | "failed";
  path?: string;
  startLine?: number;
  endLine?: number;
  contentHash: string;
  summary: string;
  truncated: boolean;
}

export interface RoleCoverage {
  role: DeepReviewRole;
  status: CoverageStatus;
  attemptedTurns: number;
  completedToolCalls: number;
  reasonCodes: string[];
}

export interface RoleResult {
  role: DeepReviewRole;
  candidates: FindingCandidate[];
  coverage: RoleCoverage;
}

export type CriticDecisionKind = "accept" | "reject" | "needs_more_evidence";

export interface CriticDecision {
  candidateId: string;
  decision: CriticDecisionKind;
  reasonCode: string;
  duplicateOfCandidateId?: string;
}

export interface GateDecision {
  candidateId: string;
  accepted: boolean;
  reasonCode: GateReasonCode;
}

export type GateReasonCode =
  | "accepted"
  | "critic_rejected"
  | "critic_needs_more_evidence"
  | "critic_decision_missing"
  | "critic_decision_duplicate"
  | "critic_decision_invalid"
  | "candidate_identity_invalid"
  | "evidence_missing"
  | "evidence_failed"
  | "evidence_scope_mismatch"
  | "evidence_location_invalid"
  | "finding_not_on_changed_line"
  | "cross_file_not_supported"
  | "severity_not_supported";

export interface DeepReviewArtifact {
  workflowId: "review.deep.v1";
  publicationMode: "shadow";
  identity: DeepReviewIdentity;
  sourceCoverage: SourceCoverage;
  analysisStatus: CoverageStatus;
  verdict: "findings" | "no_findings" | "incomplete";
  candidates: FindingCandidate[];
  criticDecisions: CriticDecision[];
  gateDecisions: GateDecision[];
  coverage: RoleCoverage[];
}

export type ReadonlyToolRequest =
  | { name: "read_file_range"; path: string; startLine: number; endLine: number }
  | { name: "search_changed_files"; query: string }
  | { name: "find_symbol_references"; symbol: string }
  | { name: "read_manifest"; kind: "package" | "dependencies" | "build" | "ci" }
  | { name: "read_ci_status" };

export interface DeepToolRegistry {
  catalog(role: DeepReviewRole): readonly ReadonlyToolRequest["name"][];
  invoke(role: DeepReviewRole, name: ReadonlyToolRequest["name"], raw: unknown, signal?: AbortSignal): Promise<EvidenceRecord>;
}

export interface DeepReviewStore {
  loadArtifact(lease: RunLease): Promise<DeepReviewArtifact | undefined>;
  registerEvidence(lease: RunLease, stepKey: string, record: EvidenceRecord): Promise<void>;
  registerCandidates(lease: RunLease, stepKey: string, records: readonly FindingCandidate[]): Promise<void>;
  registerDecisions(
    lease: RunLease,
    stepKey: string,
    stage: "critic" | "gate",
    records: readonly CriticDecision[] | readonly GateDecision[],
  ): Promise<void>;
  loadUsableEvidence(lease: RunLease, ids: readonly string[]): Promise<Map<string, EvidenceRecord>>;
  saveArtifact(lease: RunLease, artifact: DeepReviewArtifact): Promise<void>;
}

export interface DeepWorkflowContext {
  lease: RunLease;
  step<T>(key: string, kind: DeepStepKind, inputHash: string, action: () => Promise<T>): Promise<T>;
  model: StructuredModel;
  tools: DeepToolRegistry;
  store: DeepReviewStore;
  signal?: AbortSignal;
}

export interface DeepWorkflowPolicy {
  roleLimits: Record<DeepReviewRole, RoleLimits>;
  criticInputCandidateLimit: number;
  criticLimits: {
    maxWallTimeMs: number;
    maxInputBytes: number;
    maxOutputTokens: number;
  };
}

export interface ReviewWorkflow {
  readonly id: "review.deep.v1";
  readonly publicationMode: "shadow";
  execute(
    source: DeepReviewSource,
    context: DeepWorkflowContext,
    policy: DeepWorkflowPolicy,
  ): Promise<DeepReviewArtifact>;
}

export interface RoleLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxCandidates: number;
  maxWallTimeMs: number;
  maxInputBytesPerTurn: number;
  maxOutputTokensPerTurn: number;
}
